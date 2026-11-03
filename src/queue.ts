// csa queue：执行机上的重作业一次只跑一个，跑完自动开下一个；超时、时间窗到点自己停。
// 状态在 <数据目录>/queue.json，排队页是程序生成的只读视图。约定见 docs/cli.md。
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  clock, dataDir, fail, formatDuration, KILL_RETRY_MS, killTree, nextClock, parseDuration, pidAlive, readJson, startLogged,
  withLock, writeJson, writeText,
} from './common.ts';

export type ItemState = 'queued' | 'running' | 'done' | 'failed' | 'killed' | 'cancelled' | 'skipped' | 'lost';
export interface Item {
  id: string; owner: string; session?: string; ticket?: string; note?: string;
  cmd: string; cwd: string; shell?: string; est_s: number; limit_s: number; after?: string;
  state: ItemState; enq_at: string; start_at?: string; end_at?: string;
  pid?: number; rc?: number | null; reason?: string; log: string; acked_at?: string; cancel_requested?: boolean;
  /** 开跑前的检查命令（--if）和它的时限；检查不过记 skipped。 */
  if_cmd?: string; if_timeout_s?: number; checking_at?: string; checking_pid?: number;
  /** 线的 id（csa queue add --line）：同号的票在不同的线上，靠它分开。 */
  line?: string;
  /** 接手的遗留作业已经被要求停掉的原因（pause / cancel / limit / curfew）。 */
  kill_sent?: string; kill_sent_at?: string;
  /** 接手的遗留检查进程，要它停的时刻（停之前作业不重新检查）。 */
  checking_kill_at?: string;
  /** 结束事件已经写进 events.jsonl（和跑过钩子）的时刻；有它就不再写。 */
  evented_at?: string;
}
export interface Curfew { no_start_after?: string; kill_at?: string; note?: string }
export interface Pause { at: string; note?: string }
export interface QueueState { version: 1; curfew: Curfew | null; paused?: Pause | null; items: Item[] }
export interface LineConfig { id: string; dir: string; auth?: { file: string; heading: string; sha256: string } }
export interface Config { views?: string[]; shell?: string; idle_exit_s?: number; lines?: LineConfig[]; on_end?: string; on_end_timeout_s?: number }

export const TERMINAL: ItemState[] = ['done', 'failed', 'killed', 'cancelled', 'skipped', 'lost'];
const STATE_TEXT: Record<ItemState, string> = {
  queued: '排队', running: '正在跑', done: '跑完', failed: '出错退出', killed: '被停掉', cancelled: '取消', skipped: '检查没过、跳过', lost: '下落不明',
};
const REASON_TEXT: Record<string, string> = { limit: '超过上限', curfew: '时间窗到点', cancel: '有人取消', pause: '急停' };

export function paths() {
  const dir = dataDir();
  return { dir, state: join(dir, 'queue.json'), runner: join(dir, 'runner.json'), config: join(dir, 'config.json'), view: join(dir, 'queue.md'), logs: join(dir, 'logs'), events: join(dir, 'events.jsonl') };
}
export const loadState = (): QueueState => readJson(paths().state, { version: 1, curfew: null, items: [] } as QueueState);
export const loadConfig = (): Config => readJson(paths().config, {} as Config);
export const saveConfig = (config: Config) => writeJson(paths().config, config);
const iso = (ms = Date.now()) => new Date(ms).toISOString();

export function runnerInfo() {
  const info = readJson<{ pid?: number; started_at?: string; heartbeat_at?: string } | null>(paths().runner, null);
  const alive = !!info && pidAlive(info.pid) && Date.now() - Date.parse(info.heartbeat_at ?? '') < 30_000;
  return { pid: info?.pid, started_at: info?.started_at, heartbeat_at: info?.heartbeat_at, alive };
}

export const RUNNER_HINT = "排队程序没在跑：用执行机守护进程的后台作业开 `csa queue run`（例：winhand 的 job_start(command='csa queue run', name='csa-queue')），排队清空后它自己退出";

/** 时间窗：过了 no_start_after 不开新作业；估计跑不完到 kill_at 的不开；到 kill_at 停掉在跑的。到点以后一直停着，直到有人 --clear。 */
function curfewTimes(curfew: Curfew | null) {
  return { noStart: curfew?.no_start_after ? Date.parse(curfew.no_start_after) : null, killAt: curfew?.kill_at ? Date.parse(curfew.kill_at) : null };
}

/** 急停中：不开新作业，在跑的停掉，排队程序照样退出；直到有人 csa queue resume。 */
export const isPaused = (state: QueueState) => !!state.paused;

export function heldByCurfew(state: QueueState, now = Date.now()) {
  const { noStart, killAt } = curfewTimes(state.curfew);
  return (noStart !== null && now >= noStart) || (killAt !== null && now >= killAt);
}

/** 现在能不能开这一项：急停、时间窗到点、估时放不进时间窗，都不能开。pickNext 和「检查过了要开跑」都用它。 */
export function admissible(state: QueueState, item: Item, now = Date.now()) {
  if (isPaused(state) || heldByCurfew(state, now)) return false;
  const { killAt } = curfewTimes(state.curfew);
  return !(killAt !== null && now + item.est_s * 1000 > killAt);
}

/** 依赖没成功的作业直接取消；返回下一项能开的作业（先来先跑，时间窗里放不下的跳过，看后面短的）。 */
export function pickNext(state: QueueState, now = Date.now()): Item | null {
  for (const item of state.items) {
    if (item.state !== 'queued' || !item.after) continue;
    const dep = state.items.find(i => i.id === item.after);
    if (dep && TERMINAL.includes(dep.state) && dep.state !== 'done') {
      Object.assign(item, { state: 'cancelled', end_at: iso(now), reason: `前一项 ${dep.id} 没成功（${STATE_TEXT[dep.state]}）` });
    }
  }
  if (isPaused(state) || heldByCurfew(state, now)) return null;
  const { killAt } = curfewTimes(state.curfew);
  for (const item of state.items) {
    if (item.state !== 'queued') continue;
    if (item.after) {
      const dep = state.items.find(i => i.id === item.after);
      if (dep && dep.state !== 'done') continue;
    }
    if (!admissible(state, item, now)) continue;
    return item;
  }
  return null;
}

export function renderView(state: QueueState, now = Date.now()) {
  const runner = runnerInfo();
  const curfew = state.curfew;
  const line = (i: Item) => {
    const who = `${i.owner}${i.session ? `（${i.session}）` : ''}${i.ticket ? ` 票 ${i.ticket}` : ''}`;
    const what = i.note ? `：${i.note}` : '';
    return `${i.id} ${who}${what}`;
  };
  const running = state.items.filter(i => i.state === 'running');
  const queued = state.items.filter(i => i.state === 'queued');
  const finished = state.items.filter(i => TERMINAL.includes(i.state)).sort((a, b) => (b.end_at ?? '').localeCompare(a.end_at ?? '')).slice(0, 30);
  const out = [
    '# 执行机上的作业排队（程序生成，只读）',
    '',
    `由 cloud-superagent 的 \`csa queue\` 生成，${new Date(now).toLocaleString('sv-SE')}。改排队只用命令（\`csa queue add / cancel / curfew\`），手改这页会被覆盖。用法见 cloud-superagent 的 \`docs/cli.md\`。`,
    '',
    `- 排队程序：${runner.alive ? `在跑（pid ${runner.pid}，心跳 ${clock(runner.heartbeat_at)}）` : '没在跑'}`,
    ...(state.paused ? [`- **急停中**（${clock(state.paused.at, now)} 起${state.paused.note ? `，${state.paused.note}` : ''}）：不开新作业，等有人 \`csa queue resume\``] : []),
    `- 时间窗：${curfew ? [curfew.no_start_after && `${clock(curfew.no_start_after, now)} 以后不开新作业`, curfew.kill_at && `${clock(curfew.kill_at, now)} 停掉还在跑的`, heldByCurfew(state, now) && '**已到点，等有人 `csa queue curfew --clear`**', curfew.note].filter(Boolean).join('；') : '无'}`,
    '',
    '## 正在跑',
    ...(running.length ? running.map(i => `- ${line(i)}；${clock(i.start_at)} 开，估时 ${formatDuration(i.est_s)}，上限 ${formatDuration(i.limit_s)}`) : queued.some(i => i.checking_at) ? [] : ['- 无']),
    ...queued.filter(i => i.checking_at).map(i => `- ${line(i)}；${clock(i.checking_at)} 起在跑开跑前的检查`),
    '',
    '## 排队',
    ...(queued.length ? queued.map((i, n) => `${n + 1}. ${line(i)}；估时 ${formatDuration(i.est_s)}${i.after ? `，等 ${i.after} 跑完` : ''}`) : ['- 无']),
    '',
    '## 跑完（最近 30 项）',
    ...(finished.length ? finished.map(i => `- ${line(i)}；${clock(i.start_at)}–${clock(i.end_at)} ${STATE_TEXT[i.state]}${i.rc !== undefined && i.rc !== null ? ` rc ${i.rc}` : ''}${i.reason ? `（${REASON_TEXT[i.reason] ?? i.reason}）` : ''}${i.acked_at ? '' : '，负责的会话还没取'}`) : ['- 无']),
    '',
  ];
  return out.join('\n');
}

export function writeViews(state: QueueState) {
  const text = renderView(state);
  const targets = [paths().view, ...(loadConfig().views ?? [])];
  for (const target of targets) {
    try { writeText(target, text); } catch (error: any) { console.error(`排队页写不进 ${target}：${error.message}`); }
  }
}

function newId(state: QueueState, owner: string, ticket?: string) {
  const d = new Date();
  const stamp = `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  const base = `${owner}${ticket ? `-t${ticket}` : ''}-${stamp}`.replace(/[^\w.-]+/g, '_');
  let id = base;
  for (let n = 2; state.items.some(i => i.id === id); n++) id = `${base}-${n}`;
  return id;
}

export interface AddOptions { owner: string; session?: string; ticket?: string; line?: string; note?: string; est: string; limit?: string; after?: string; cwd?: string; shell?: string; cmd: string; if?: string; ifTimeout?: string }

export function add(opts: AddOptions) {
  if (!opts.owner) fail('缺少 --owner（哪个会话负责，例：B）');
  if (!opts.cmd.trim()) fail('缺少命令：csa queue add … -- "<整行命令>"');
  const est = parseDuration(opts.est);
  const limit = parseDuration(opts.limit, est * 2 + 600);
  if (limit < est) fail('--limit 不能比 --est 小');
  const cwd = resolve(opts.cwd ?? process.cwd());
  if (!existsSync(cwd)) fail(`工作目录不存在：${cwd}`);
  return withLock('queue', () => {
    const state = loadState();
    if (opts.after && !state.items.some(i => i.id === opts.after)) fail(`--after 的作业不存在：${opts.after}`);
    const id = newId(state, opts.owner, opts.ticket);
    const item: Item = {
      id, owner: opts.owner, session: opts.session, ticket: opts.ticket, line: opts.line, note: opts.note, cmd: opts.cmd, cwd,
      shell: opts.shell ?? loadConfig().shell, est_s: est, limit_s: limit, after: opts.after,
      state: 'queued', enq_at: iso(), log: join(paths().logs, `${id}.log`),
      ...(opts.if?.trim() ? { if_cmd: opts.if, if_timeout_s: parseDuration(opts.ifTimeout, 60) } : {}),
    };
    state.items.push(item);
    writeJson(paths().state, state);
    writeViews(state);
    const position = state.items.filter(i => i.state === 'queued').indexOf(item) + 1;
    const running = state.items.filter(i => i.state === 'running').length;
    return { id, position, running, runner_alive: runnerInfo().alive, log: item.log };
  });
}

/**
 * 第一次配结束钩子时调用：已经结束、还没写过结束事件的作业，记成「开钩子以前就结束了」，不补写事件、不补跑钩子。
 * 否则老作业会在下一跳一起触发钩子。返回记了几项。
 */
export function markOldEvented() {
  return withLock('queue', () => {
    const state = loadState();
    const at = iso();
    let n = 0;
    for (const item of state.items) {
      if (TERMINAL.includes(item.state) && !item.evented_at) { item.evented_at = at; n++; }
    }
    writeJson(paths().state, state);
    return n;
  });
}

export function cancel(id: string) {
  return withLock('queue', () => {
    const state = loadState();
    const item = state.items.find(i => i.id === id) ?? fail(`没有这个作业：${id}`);
    if (item.state === 'queued') Object.assign(item, { state: 'cancelled', end_at: iso(), reason: 'cancel' });
    else if (item.state === 'running') item.cancel_requested = true;
    else fail(`作业已经${STATE_TEXT[item.state]}，不用取消`);
    writeJson(paths().state, state);
    writeViews(state);
    return item.state === 'running' ? `${id} 正在跑：已通知排队程序停掉（几秒内生效）` : `${id} 已取消`;
  });
}

export function ack(id: string, by?: string) {
  return withLock('queue', () => {
    const state = loadState();
    const item = state.items.find(i => i.id === id) ?? fail(`没有这个作业：${id}`);
    if (!TERMINAL.includes(item.state)) fail(`作业还没结束（${STATE_TEXT[item.state]}），结束后再 ack`);
    item.acked_at = iso();
    if (by) item.note = item.note ?? `由 ${by} 取走`;
    writeJson(paths().state, state);
    writeViews(state);
    return item;
  });
}

/**
 * 时间窗的时刻：钟点 06:45（刚过去 30 分钟以内的按「现在」，更早的算明天）、now、+90s / +5m 这种相对写法、
 * 或完整的 ISO 时刻。hint 是要打给人看的一行提示。
 */
function clockOrRelative(text: string, flag: string, hints: string[]) {
  if (text === 'now') return new Date();
  if (text.startsWith('+')) return new Date(Date.now() + parseDuration(text.slice(1)) * 1000);
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const at = new Date(text);
    if (Number.isNaN(at.getTime())) fail(`${flag} 的时刻写法不认识：${text}`);
    return at;
  }
  const { at, justPassed } = nextClock(text);
  if (justPassed) {
    const tomorrow = new Date(at);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const ymd = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
    const hhmm = text.split(':').map(x => x.padStart(2, '0')).join(':');
    hints.push(`${flag} ${text} 刚过去，按现在（${clock(at)}）算；要的是明天的 ${text}，写完整时刻（例：${ymd}T${hhmm}）`);
  }
  return at;
}

export function setCurfew(opts: { noStartAfter?: string; killAt?: string; note?: string; clear?: boolean }) {
  const hints: string[] = [];
  let curfew: Curfew | null = null;
  if (!opts.clear) {
    if (!opts.noStartAfter && !opts.killAt) fail('至少给 --no-start-after 或 --kill-at；解除用 --clear');
    const noStart = opts.noStartAfter ? clockOrRelative(opts.noStartAfter, '--no-start-after', hints) : undefined;
    const killAt = opts.killAt ? clockOrRelative(opts.killAt, '--kill-at', hints) : undefined;
    if (noStart && killAt && killAt.getTime() < noStart.getTime()) fail(`--kill-at（${clock(killAt)}）早于 --no-start-after（${clock(noStart)}）：停掉在跑的时刻不能早于不再开新作业的时刻`);
    curfew = { no_start_after: noStart?.toISOString(), kill_at: killAt?.toISOString(), note: opts.note };
  }
  return withLock('queue', () => {
    const state = loadState();
    state.curfew = curfew;
    writeJson(paths().state, state);
    writeViews(state);
    return { curfew: state.curfew, hints };
  });
}

/** 急停：在跑的作业停掉（记 killed，原因 pause，不自动重排），排着的都不开，直到 resume。排队程序没在跑也能先设上。 */
export function pause(note?: string) {
  return withLock('queue', () => {
    const state = loadState();
    state.paused = { at: state.paused?.at ?? iso(), note: note ?? state.paused?.note };
    writeJson(paths().state, state);
    writeViews(state);
    return { paused: state.paused, running: state.items.filter(i => i.state === 'running').map(i => i.id), runner_alive: runnerInfo().alive };
  });
}

export function resume() {
  return withLock('queue', () => {
    const state = loadState();
    const was = state.paused ?? null;
    state.paused = null;
    writeJson(paths().state, state);
    writeViews(state);
    return { was, queued: state.items.filter(i => i.state === 'queued').length, runner_alive: runnerInfo().alive };
  });
}

export function logTail(id: string, lines = 40) {
  const item = loadState().items.find(i => i.id === id) ?? fail(`没有这个作业：${id}`);
  if (!existsSync(item.log)) return '（还没有输出）';
  return readFileSync(item.log, 'utf8').split(/\r?\n/).slice(-lines).join('\n');
}

export function status() {
  const state = loadState();
  return {
    runner: runnerInfo(),
    curfew: state.curfew,
    held_by_curfew: heldByCurfew(state),
    paused: state.paused ?? null,
    running: state.items.filter(i => i.state === 'running'),
    queued: state.items.filter(i => i.state === 'queued'),
    unacked: state.items.filter(i => TERMINAL.includes(i.state) && !i.acked_at),
  };
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 当前占着执行机的那一项：要么在跑开跑前的检查（--if），要么在跑作业本身。 */
interface Slot { id: string; phase: 'check' | 'job'; child: ChildProcess; started: number; exited: { code: number | null } | null; killedFor?: string; timedOut?: boolean }
/** 作业结束钩子：和排队并行跑，不占执行机的槽位，到时限停掉。 */
interface Hook { id: string; child: ChildProcess; started: number; timeout_s: number; exited: boolean; killed?: boolean }

function spawnSlot(id: string, phase: Slot['phase'], cmd: string, item: Item): Slot {
  const child = startLogged(cmd, item.cwd, item.log, item.shell);
  const slot: Slot = { id, phase, child, started: Date.now(), exited: null };
  child.on('exit', code => { slot.exited = { code }; });
  child.on('error', error => { console.error(`${id} 起不来：${error.message}`); slot.exited = { code: null }; });
  return slot;
}

/** 结束事件：只给固定字段，不带作业输出。 */
export function endEvent(item: Item) {
  return { event_id: `${item.id}:${item.state}`, at: item.end_at ?? iso(), id: item.id, state: item.state, rc: item.rc ?? null, reason: item.reason ?? null, owner: item.owner, session: item.session ?? null, ticket: item.ticket ?? null, log: item.log };
}

/** 钩子拿到的环境变量：固定这几个，值都来自排队记录。 */
export function hookEnv(item: Item): Record<string, string> {
  const e = endEvent(item);
  return {
    CSA_EVENT_ID: e.event_id, CSA_JOB_ID: e.id, CSA_JOB_STATE: e.state, CSA_JOB_RC: e.rc === null ? '' : String(e.rc), CSA_JOB_REASON: e.reason ?? '',
    CSA_JOB_OWNER: e.owner, CSA_JOB_SESSION: e.session ?? '', CSA_JOB_TICKET: e.ticket ?? '', CSA_JOB_LOG: e.log,
  };
}

/** 结束钩子最多同时跑几个。 */
const HOOK_PARALLEL = 2;

/** events.jsonl 里已经写过的 event_id（排队程序起来时读一次）。 */
function loadEventIds() {
  const ids = new Set<string>();
  if (!existsSync(paths().events)) return ids;
  const text = readFileSync(paths().events, 'utf8');
  // 最后一行没写完（写到一半崩了）：先补一个换行把它隔开，否则下一条事件会接在它后面，两行都坏
  if (text.length && !text.endsWith('\n')) appendFileSync(paths().events, '\n');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); ids.add(e.event_id ?? `${e.id}:${e.state}`); } catch { /* 半行：写到一半崩了，跳过 */ }
  }
  return ids;
}

/** 排队程序本体：单例；一次只跑一个；排队清空、钩子也都结束 idleExit 秒后退出。 */
export async function runLoop(idleExit: number, tickMs = 2000) {
  const me = process.pid;
  const claimed = withLock('queue', () => {
    const info = runnerInfo();
    if (info.alive && info.pid !== me) return false;
    writeJson(paths().runner, { pid: me, started_at: iso(), heartbeat_at: iso() });
    return true;
  });
  if (!claimed) {
    console.log(`排队程序已经在跑（pid ${runnerInfo().pid}），这次不重复开`);
    return 0;
  }
  console.log(`排队程序开始（pid ${me}），排队清空 ${idleExit} 秒后退出`);
  let current: Slot | null = null;
  const hooks: Hook[] = [];
  const hookQueue: { item: Item; command: string; shell?: string; timeout_s: number }[] = [];
  const seenEvents = loadEventIds();
  let idleSince = Date.now();
  for (;;) {
    let pending = false;
    withLock('queue', () => {
      const now = Date.now();
      const state = loadState();
      const config = loadConfig();
      const info = readJson<Record<string, string | number>>(paths().runner, {});
      if (info.pid !== me) return;
      writeJson(paths().runner, { ...info, heartbeat_at: iso(now) });

      if (current?.phase === 'check') {
        const slot: Slot = current;
        const item = state.items.find(i => i.id === slot.id);
        if (item && item.state === 'queued' && isPaused(state) && !slot.exited) {
          // 急停：检查停掉，作业留在排队里
          killTree(slot.child.pid!);
          delete item.checking_at;
          delete item.checking_pid;
          console.log(`${clock(now)} 急停，停掉 ${item.id} 开跑前的检查，作业留在排队里`);
          current = null;
        } else if (!item || item.state !== 'queued') {
          // 检查跑着的时候作业被取消了
          if (!slot.exited) killTree(slot.child.pid!);
          if (item) { delete item.checking_at; delete item.checking_pid; }
          current = null;
        } else if (slot.exited) {
          delete item.checking_at;
          delete item.checking_pid;
          if (slot.exited.code === 0 && !slot.timedOut && !admissible(state, item, now)) {
            // 检查跑着的时候急停了、时间窗到点了、或者剩的时间放不下了：作业留在排队里，以后重新检查
            console.log(`${clock(now)} ${item.id} 检查过了，但现在不能开（急停或时间窗），留在排队里`);  // 测试 Q28 认这一行
            current = null;
          } else if (slot.exited.code === 0 && !slot.timedOut) {
            current = spawnSlot(item.id, 'job', item.cmd, item);
            Object.assign(item, { state: 'running', start_at: iso(now), pid: current.child.pid });
            console.log(`${clock(now)} ${item.id} 检查过了，开跑`);
          } else {
            // 原因只写结构化的事实，检查的输出留在作业日志里：原因会进 events.jsonl 和钩子的环境
            const why = slot.timedOut ? `开跑前的检查超时（${item.if_timeout_s} s），跳过` : `开跑前的检查没过（rc ${slot.exited.code}），输出见作业日志`;
            Object.assign(item, { state: 'skipped', end_at: iso(now), rc: null, reason: why });
            console.log(`${clock(now)} ${item.id} 跳过：${why}`);
            current = null;
          }
        } else if (!slot.timedOut && (now - slot.started) / 1000 > (item.if_timeout_s ?? 60)) {
          slot.timedOut = true;
          killTree(slot.child.pid!);
        }
      } else if (current) {
        const slot: Slot = current;
        const item = state.items.find(i => i.id === slot.id);
        if (slot.exited) {
          if (item) {
            item.state = slot.killedFor ? 'killed' : slot.exited.code === 0 ? 'done' : 'failed';
            item.rc = slot.exited.code;
            item.end_at = iso(now);
            if (slot.killedFor) item.reason = slot.killedFor;
            console.log(`${clock(now)} ${item.id} ${STATE_TEXT[item.state]}${item.rc !== null ? ` rc ${item.rc}` : ''}`);
          }
          current = null;
        } else if (item && !slot.killedFor) {
          const { killAt } = curfewTimes(state.curfew);
          const why = item.cancel_requested ? 'cancel'
            : isPaused(state) ? 'pause'
            : (now - Date.parse(item.start_at!)) / 1000 > item.limit_s ? 'limit'
            : killAt !== null && now >= killAt ? 'curfew' : undefined;
          if (why) {
            slot.killedFor = why;
            console.log(`${clock(now)} 停掉 ${item.id}（${REASON_TEXT[why]}）`);
            killTree(slot.child.pid!);
          }
        }
      }
      // 上一个排队程序留下的：
      // - 「在检查」：检查进程还在就停掉，作业留在排队里重新检查（检查本来就该是只读、可以重跑的）；
      // - 「正在跑」：进程还在就接着管，急停、取消、超上限、时间窗到点照样停掉；进程不在了，停过的记 killed，没停过的记「下落不明」。
      let orphanAlive = false;
      const { killAt: orphanKillAt } = curfewTimes(state.curfew);
      for (const item of state.items) {
        // 不管作业现在是什么状态（排着，还是检查跑着的时候被取消了），只要留着旧检查的 pid，就按进程活不活着处理
        if ((item.checking_at || item.checking_pid) && item.id !== current?.id) {
          if (pidAlive(item.checking_pid)) {
            // 旧检查还活着：停掉它，等它真的退出了再重新检查；这期间执行机算占着，不开别的
            orphanAlive = true;
            if (!item.checking_kill_at) {
              item.checking_kill_at = iso(now);
              console.log(`${clock(now)} 停掉上一个排队程序留下的检查（${item.id}），等它退出再重新检查`);
              killTree(item.checking_pid!);
            } else if (now - Date.parse(item.checking_kill_at) > KILL_RETRY_MS) {
              item.checking_kill_at = iso(now);
              console.log(`${clock(now)} ${item.id} 留下的检查要停以后还活着，强制停`);
              killTree(item.checking_pid!, true);
            }
          } else {
            delete item.checking_at;
            delete item.checking_pid;
            delete item.checking_kill_at;
          }
        }
        if (item.state !== 'running' || item.id === current?.id) continue;
        if (pidAlive(item.pid)) {
          orphanAlive = true;
          const why = item.cancel_requested ? 'cancel'
            : isPaused(state) ? 'pause'
            : (now - Date.parse(item.start_at!)) / 1000 > item.limit_s ? 'limit'
            : orphanKillAt !== null && now >= orphanKillAt ? 'curfew' : undefined;
          if (why && !item.kill_sent) {
            Object.assign(item, { kill_sent: why, kill_sent_at: iso(now) });
            console.log(`${clock(now)} 停掉接手的 ${item.id}（${REASON_TEXT[why]}）`);
            killTree(item.pid!);
          } else if (item.kill_sent && now - Date.parse(item.kill_sent_at ?? '') > KILL_RETRY_MS || (item.kill_sent && !item.kill_sent_at)) {
            // 要停过了还活着（上次的强制停止可能随排队程序重启丢了）：强制再停一次
            item.kill_sent_at = iso(now);
            console.log(`${clock(now)} ${item.id} 要停以后还活着，强制停`);
            killTree(item.pid!, true);
          }
        } else if (item.kill_sent) {
          Object.assign(item, { state: 'killed', end_at: iso(now), rc: null, reason: item.kill_sent });
          delete item.kill_sent;
          delete item.kill_sent_at;
        } else Object.assign(item, { state: 'lost', end_at: iso(now), rc: null, reason: '排队程序重启前就在跑，退出码不明' });
      }
      if (!current && !orphanAlive) {
        const next = pickNext(state, now);
        if (next?.if_cmd) {
          current = spawnSlot(next.id, 'check', next.if_cmd, next);
          next.checking_at = iso(now);
          next.checking_pid = current.child.pid;
          console.log(`${clock(now)} ${next.id} 先跑开跑前的检查`);
        } else if (next) {
          current = spawnSlot(next.id, 'job', next.cmd, next);
          Object.assign(next, { state: 'running', start_at: iso(now), pid: current.child.pid });
          console.log(`${clock(now)} 开 ${next.id}（${next.owner}${next.ticket ? ` 票 ${next.ticket}` : ''}）`);
        }
      }

      // 结束事件：每个终态写一行 events.jsonl（带 event_id = 作业 id:状态），写进去了才记 evented_at；
      // 写不进就下一跳再写。events.jsonl 里已经有的 event_id 不再写、不再起钩子（防「写进去了、状态还没落盘就崩了」重复）。
      for (const item of state.items) {
        if (!TERMINAL.includes(item.state) || item.evented_at) continue;
        const event = endEvent(item);
        if (!seenEvents.has(event.event_id)) {
          try { appendFileSync(paths().events, `${JSON.stringify(event)}\n`); } catch (error: any) { console.error(`events.jsonl 写不进，下一跳再写：${error.message}`); continue; }
          seenEvents.add(event.event_id);
          if (config.on_end) hookQueue.push({ item: { ...item }, command: config.on_end, shell: config.shell, timeout_s: config.on_end_timeout_s ?? 30 });
        }
        item.evented_at = iso(now);
      }
      // 钩子最多同时跑 HOOK_PARALLEL 个，其余排着
      while (hookQueue.length && hooks.filter(h => !h.exited).length < HOOK_PARALLEL) {
        const job = hookQueue.shift()!;
        mkdirSync(paths().logs, { recursive: true });
        const child = startLogged(job.command, paths().dir, join(paths().logs, 'hooks.log'), job.shell, hookEnv(job.item));
        const hook: Hook = { id: job.item.id, child, started: now, timeout_s: job.timeout_s, exited: false };
        child.on('exit', code => { hook.exited = true; if (code !== 0 && !hook.killed) console.error(`${job.item.id} 的结束钩子退出码 ${code}`); });
        child.on('error', error => { hook.exited = true; console.error(`${job.item.id} 的结束钩子起不来：${error.message}`); });
        hooks.push(hook);
      }
      for (const hook of hooks) {
        if (!hook.exited && !hook.killed && (now - hook.started) / 1000 > hook.timeout_s) {
          hook.killed = true;
          console.error(`${hook.id} 的结束钩子超过 ${hook.timeout_s} s，停掉`);
          killTree(hook.child.pid!);
        }
      }
      for (let i = hooks.length - 1; i >= 0; i--) if (hooks[i].exited) hooks.splice(i, 1);

      // 时间窗到点后排着的作业不算「有活」：排队程序照样退出，执行机可以睡；解除时间窗后再开排队程序
      pending = !!current || orphanAlive || hooks.length > 0 || hookQueue.length > 0 || (state.items.some(i => i.state === 'queued') && !heldByCurfew(state, now) && !isPaused(state));
      writeJson(paths().state, state);
      writeViews(state);
    });
    if (readJson<{ pid?: number }>(paths().runner, {}).pid !== me) {
      console.log('排队程序被别的实例接手，退出');
      return 1;
    }
    if (pending) idleSince = Date.now();
    else if (Date.now() - idleSince > idleExit * 1000) break;
    await delay(tickMs);
  }
  withLock('queue', () => {
    if (readJson<{ pid?: number }>(paths().runner, {}).pid === me) writeJson(paths().runner, {});
    writeViews(loadState());
  });
  console.log(`${clock(Date.now())} 排队清空，排队程序退出`);
  return 0;
}
