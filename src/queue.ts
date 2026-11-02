// csa queue：执行机上的重作业一次只跑一个，跑完自动开下一个；超时、时间窗到点自己停。
// 状态在 <数据目录>/queue.json，排队页是程序生成的只读视图。约定见 docs/cli.md。
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  clock, dataDir, fail, formatDuration, killTree, nextClock, parseDuration, pidAlive, readJson, startLogged,
  withLock, writeJson, writeText,
} from './common.ts';

export type ItemState = 'queued' | 'running' | 'done' | 'failed' | 'killed' | 'cancelled' | 'lost';
export interface Item {
  id: string; owner: string; session?: string; ticket?: string; note?: string;
  cmd: string; cwd: string; shell?: string; est_s: number; limit_s: number; after?: string;
  state: ItemState; enq_at: string; start_at?: string; end_at?: string;
  pid?: number; rc?: number | null; reason?: string; log: string; acked_at?: string; cancel_requested?: boolean;
}
export interface Curfew { no_start_after?: string; kill_at?: string; note?: string }
export interface QueueState { version: 1; curfew: Curfew | null; items: Item[] }
export interface LineConfig { id: string; dir: string; auth?: { file: string; heading: string; sha256: string } }
export interface Config { views?: string[]; shell?: string; idle_exit_s?: number; lines?: LineConfig[] }

export const TERMINAL: ItemState[] = ['done', 'failed', 'killed', 'cancelled', 'lost'];
const STATE_TEXT: Record<ItemState, string> = {
  queued: '排队', running: '正在跑', done: '跑完', failed: '出错退出', killed: '被停掉', cancelled: '取消', lost: '下落不明',
};
const REASON_TEXT: Record<string, string> = { limit: '超过上限', curfew: '时间窗到点', cancel: '有人取消' };

export function paths() {
  const dir = dataDir();
  return { dir, state: join(dir, 'queue.json'), runner: join(dir, 'runner.json'), config: join(dir, 'config.json'), view: join(dir, 'queue.md'), logs: join(dir, 'logs') };
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
    ...(running.length ? running.map(i => `- ${line(i)}；${clock(i.start_at)} 开，估时 ${formatDuration(i.est_s)}，上限 ${formatDuration(i.limit_s)}`) : ['- 无']),
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

export interface AddOptions { owner: string; session?: string; ticket?: string; note?: string; est: string; limit?: string; after?: string; cwd?: string; shell?: string; cmd: string }

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

/** 排队程序本体：单例；一次只跑一个；排队清空 idleExit 秒后退出。 */
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
  let current: { id: string; child: ChildProcess; exited: { code: number | null } | null; killedFor?: string } | null = null;
  let idleSince = Date.now();
  for (;;) {
    let pending = false;
    withLock('queue', () => {
      const now = Date.now();
      const state = loadState();
      const info = readJson<Record<string, string | number>>(paths().runner, {});
      if (info.pid !== me) return;
      writeJson(paths().runner, { ...info, heartbeat_at: iso(now) });
      if (current) {
        const item = state.items.find(i => i.id === current!.id);
        if (current.exited) {
          if (item) {
            item.state = current.killedFor ? 'killed' : current.exited.code === 0 ? 'done' : 'failed';
            item.rc = current.exited.code;
            item.end_at = iso(now);
            if (current.killedFor) item.reason = current.killedFor;
            console.log(`${clock(now)} ${item.id} ${STATE_TEXT[item.state]}${item.rc !== null ? ` rc ${item.rc}` : ''}`);
          }
          current = null;
        } else if (item && !current.killedFor) {
          const { killAt } = curfewTimes(state.curfew);
          const why = item.cancel_requested ? 'cancel'
            : (now - Date.parse(item.start_at!)) / 1000 > item.limit_s ? 'limit'
            : killAt !== null && now >= killAt ? 'curfew' : undefined;
          if (why) {
            current.killedFor = why;
            console.log(`${clock(now)} 停掉 ${item.id}（${REASON_TEXT[why]}）`);
            killTree(current.child.pid!);
          }
        }
      }
      // 上一个排队程序留下的「正在跑」：进程还在就等它，不在了记「下落不明」
      let orphanAlive = false;
      for (const item of state.items) {
        if (item.state !== 'running' || item.id === current?.id) continue;
        if (pidAlive(item.pid)) orphanAlive = true;
        else Object.assign(item, { state: 'lost', end_at: iso(now), rc: null, reason: '排队程序重启前就在跑，退出码不明' });
      }
      if (!current && !orphanAlive) {
        const next = pickNext(state, now);
        if (next) {
          const child = startLogged(next.cmd, next.cwd, next.log, next.shell);
          const started = { id: next.id, child, exited: null as { code: number | null } | null };
          child.on('exit', code => { started.exited = { code }; });
          child.on('error', error => { console.error(`${next.id} 起不来：${error.message}`); started.exited = { code: null }; });
          Object.assign(next, { state: 'running', start_at: iso(now), pid: child.pid });
          current = started;
          console.log(`${clock(now)} 开 ${next.id}（${next.owner}${next.ticket ? ` 票 ${next.ticket}` : ''}）`);
        }
      }
      // 时间窗到点后排着的作业不算「有活」：排队程序照样退出，执行机可以睡；解除时间窗后再开排队程序
      pending = !!current || orphanAlive || (state.items.some(i => i.state === 'queued') && !heldByCurfew(state, now));
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
