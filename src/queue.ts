// csa queue：执行机上的重作业一次只跑一个，跑完自动开下一个；超时、时间窗到点自己停。
// 状态在 <数据目录>/queue.json，排队页是程序生成的只读视图。约定见 docs/cli.md。
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  clock, dataDir, fail, formatDuration, killTree, nextClock, parseDuration, pidAlive, readJson, startLogged,
  withLock, writeJson, writeText,
} from './common.ts';

export type ItemState = 'queued' | 'running' | 'done' | 'failed' | 'killed' | 'cancelled' | 'skipped' | 'lost';
export interface Item {
  id: string; owner: string; session?: string; ticket?: string; note?: string;
  cmd: string; cwd: string; shell?: string; est_s: number; limit_s: number; after?: string;
  state: ItemState; enq_at: string; start_at?: string; end_at?: string;
  pid?: number; rc?: number | null; reason?: string; log: string; acked_at?: string; cancel_requested?: boolean;
  /** 开跑前的检查命令（--if）和它的时限；检查不过记 skipped。 */
  if_cmd?: string; if_timeout_s?: number; checking_at?: string;
  /** 结束事件已经写进 events.jsonl（和跑过钩子）的时刻；有它就不再写。 */
  evented_at?: string;
}
export interface Curfew { no_start_after?: string; kill_at?: string; note?: string }
export interface QueueState { version: 1; curfew: Curfew | null; items: Item[] }
export interface LineConfig { id: string; dir: string; auth?: { file: string; heading: string; sha256: string } }
export interface Config { views?: string[]; shell?: string; idle_exit_s?: number; lines?: LineConfig[]; on_end?: string; on_end_timeout_s?: number }

export const TERMINAL: ItemState[] = ['done', 'failed', 'killed', 'cancelled', 'skipped', 'lost'];
const STATE_TEXT: Record<ItemState, string> = {
  queued: '排队', running: '正在跑', done: '跑完', failed: '出错退出', killed: '被停掉', cancelled: '取消', skipped: '检查没过、跳过', lost: '下落不明',
};
const REASON_TEXT: Record<string, string> = { limit: '超过上限', curfew: '时间窗到点', cancel: '有人取消' };

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

export function heldByCurfew(state: QueueState, now = Date.now()) {
  const { noStart, killAt } = curfewTimes(state.curfew);
  return (noStart !== null && now >= noStart) || (killAt !== null && now >= killAt);
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
  if (heldByCurfew(state, now)) return null;
  const { killAt } = curfewTimes(state.curfew);
  for (const item of state.items) {
    if (item.state !== 'queued') continue;
    if (item.after) {
      const dep = state.items.find(i => i.id === item.after);
      if (dep && dep.state !== 'done') continue;
    }
    if (killAt !== null && now + item.est_s * 1000 > killAt) continue;
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
    `- 时间窗：${curfew ? [curfew.no_start_after && `${clock(curfew.no_start_after)} 以后不开新作业`, curfew.kill_at && `${clock(curfew.kill_at)} 停掉还在跑的`, heldByCurfew(state, now) && '**已到点，等有人 `csa queue curfew --clear`**', curfew.note].filter(Boolean).join('；') : '无'}`,
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

export interface AddOptions { owner: string; session?: string; ticket?: string; note?: string; est: string; limit?: string; after?: string; cwd?: string; shell?: string; cmd: string; if?: string; ifTimeout?: string }

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
      id, owner: opts.owner, session: opts.session, ticket: opts.ticket, note: opts.note, cmd: opts.cmd, cwd,
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

/** +90s、+5m 这种相对写法给测试和临时用；平常写钟点 06:45（已过的钟点算明天）。 */
function clockOrRelative(text: string) {
  if (text.startsWith('+')) return new Date(Date.now() + parseDuration(text.slice(1)) * 1000);
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return new Date(text);
  return nextClock(text);
}

export function setCurfew(opts: { noStartAfter?: string; killAt?: string; note?: string; clear?: boolean }) {
  return withLock('queue', () => {
    const state = loadState();
    if (opts.clear) state.curfew = null;
    else {
      if (!opts.noStartAfter && !opts.killAt) fail('至少给 --no-start-after 或 --kill-at；解除用 --clear');
      state.curfew = {
        no_start_after: opts.noStartAfter ? clockOrRelative(opts.noStartAfter).toISOString() : undefined,
        kill_at: opts.killAt ? clockOrRelative(opts.killAt).toISOString() : undefined,
        note: opts.note,
      };
    }
    writeJson(paths().state, state);
    writeViews(state);
    return state.curfew;
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
  return { at: item.end_at ?? iso(), id: item.id, state: item.state, rc: item.rc ?? null, reason: item.reason ?? null, owner: item.owner, session: item.session ?? null, ticket: item.ticket ?? null, log: item.log };
}

/** 钩子拿到的环境变量：固定这几个，值都来自排队记录。 */
export function hookEnv(item: Item): Record<string, string> {
  const e = endEvent(item);
  return {
    CSA_JOB_ID: e.id, CSA_JOB_STATE: e.state, CSA_JOB_RC: e.rc === null ? '' : String(e.rc), CSA_JOB_REASON: e.reason ?? '',
    CSA_JOB_OWNER: e.owner, CSA_JOB_SESSION: e.session ?? '', CSA_JOB_TICKET: e.ticket ?? '', CSA_JOB_LOG: e.log,
  };
}

function tailOf(file: string, lines = 5) {
  try { return readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-lines).join(' ⏎ '); } catch { return ''; }
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
        if (!item || item.state !== 'queued') {
          // 检查跑着的时候作业被取消了
          if (!slot.exited) killTree(slot.child.pid!);
          if (item) delete item.checking_at;
          current = null;
        } else if (slot.exited) {
          delete item.checking_at;
          if (slot.exited.code === 0 && !slot.timedOut) {
            current = spawnSlot(item.id, 'job', item.cmd, item);
            Object.assign(item, { state: 'running', start_at: iso(now), pid: current.child.pid });
            console.log(`${clock(now)} ${item.id} 检查过了，开跑`);
          } else {
            const why = slot.timedOut ? `开跑前的检查超时（${item.if_timeout_s} s），跳过` : `开跑前的检查没过（rc ${slot.exited.code}）：${tailOf(item.log)}`;
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
            : (now - Date.parse(item.start_at!)) / 1000 > item.limit_s ? 'limit'
            : killAt !== null && now >= killAt ? 'curfew' : undefined;
          if (why) {
            slot.killedFor = why;
            console.log(`${clock(now)} 停掉 ${item.id}（${REASON_TEXT[why]}）`);
            killTree(slot.child.pid!);
          }
        }
      }
      // 上一个排队程序留下的「正在跑」：进程还在就等它，不在了记「下落不明」；留下的「在检查」重新排
      let orphanAlive = false;
      for (const item of state.items) {
        if (item.state === 'queued' && item.checking_at && item.id !== current?.id) delete item.checking_at;
        if (item.state !== 'running' || item.id === current?.id) continue;
        if (pidAlive(item.pid)) orphanAlive = true;
        else Object.assign(item, { state: 'lost', end_at: iso(now), rc: null, reason: '排队程序重启前就在跑，退出码不明' });
      }
      if (!current && !orphanAlive) {
        const next = pickNext(state, now);
        if (next?.if_cmd) {
          current = spawnSlot(next.id, 'check', next.if_cmd, next);
          next.checking_at = iso(now);
          console.log(`${clock(now)} ${next.id} 先跑开跑前的检查`);
        } else if (next) {
          current = spawnSlot(next.id, 'job', next.cmd, next);
          Object.assign(next, { state: 'running', start_at: iso(now), pid: current.child.pid });
          console.log(`${clock(now)} 开 ${next.id}（${next.owner}${next.ticket ? ` 票 ${next.ticket}` : ''}）`);
        }
      }

      // 结束事件：每个终态写一行 events.jsonl，配了 on_end 再起一次钩子；写过的记 evented_at，重启也不重写
      for (const item of state.items) {
        if (!TERMINAL.includes(item.state) || item.evented_at) continue;
        item.evented_at = iso(now);
        try { appendFileSync(paths().events, `${JSON.stringify(endEvent(item))}\n`); } catch (error: any) { console.error(`events.jsonl 写不进：${error.message}`); }
        if (config.on_end) {
          mkdirSync(paths().logs, { recursive: true });
          const child = startLogged(config.on_end, paths().dir, join(paths().logs, 'hooks.log'), config.shell, hookEnv(item));
          const hook: Hook = { id: item.id, child, started: now, timeout_s: config.on_end_timeout_s ?? 30, exited: false };
          child.on('exit', code => { hook.exited = true; if (code !== 0 && !hook.killed) console.error(`${item.id} 的结束钩子退出码 ${code}`); });
          child.on('error', error => { hook.exited = true; console.error(`${item.id} 的结束钩子起不来：${error.message}`); });
          hooks.push(hook);
        }
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
      pending = !!current || orphanAlive || hooks.length > 0 || (state.items.some(i => i.state === 'queued') && !heldByCurfew(state, now));
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
