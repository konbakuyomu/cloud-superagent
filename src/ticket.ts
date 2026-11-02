// csa ticket：一条线的台账（<线的目录>/ledger.json），派单时记下判法的哈希，之后改判法能被查出来。
// 约定见 docs/cli.md。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { canonical as realPath, fail, git, inside, readJson, sha256, withLock, writeJson } from './common.ts';
import { loadConfig, saveConfig, type LineConfig } from './queue.ts';

export const STATUSES = ['dispatched', 'started', 'handed-in', 'gate-failed', 'accepted', 'rejected', 'blocked', 'waiting-user', 'abandoned'] as const;
export type Status = (typeof STATUSES)[number];
export const STATUS_TEXT: Record<Status, string> = {
  dispatched: '已派', started: '开工', 'handed-in': '交回待验', 'gate-failed': 'gate 不过', accepted: '验收通过',
  rejected: '验收不过', blocked: '卡住', 'waiting-user': '等你定', abandoned: '放弃',
};
export const OPEN: Status[] = ['dispatched', 'started', 'handed-in', 'gate-failed', 'blocked', 'waiting-user'];

export interface TicketEntry {
  ticket: string; status: Status; owner?: string; session?: string; file: string;
  contract_sha: string; heads: Record<string, string>; dispatched_at: string; updated_at: string;
  history: { at: string; status?: Status; note?: string; contract_sha?: string }[];
  gate?: { at: string; verdict: string; file: string };
  /** dispatch --prepare 建好或核过的 worktree：仓库名 → 目录。 */
  prepared?: Record<string, string>;
}
export interface Ledger { line: string; tickets: Record<string, TicketEntry> }

const iso = () => new Date().toISOString();

/** --dir 优先，其次 --line 查配置，最后看当前目录有没有 issues/。 */
export function resolveLineDir(opt: { dir?: string; line?: string }) {
  if (opt.dir) return realPath(opt.dir);
  if (opt.line) {
    const line = (loadConfig().lines ?? []).find(l => l.id === opt.line) ?? fail(`配置里没有这条线：${opt.line}（先 csa ticket init --dir <线的目录>）`);
    return line.dir;
  }
  if (existsSync(join(process.cwd(), 'issues'))) return process.cwd();
  return fail('不知道是哪条线：用 --dir <线的目录> 或 --line <id>');
}

export function repoRoot(dir: string) {
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  return top.ok ? realPath(top.out) : fail(`${dir} 不在 git 仓库里`);
}

export function findTicketFile(lineDir: string, id: string) {
  const issues = join(lineDir, 'issues');
  if (!existsSync(issues)) fail(`没有票目录：${issues}`);
  const file = readdirSync(issues).find(name => name.toLowerCase().startsWith(`${id.toLowerCase()}-`) && name.endsWith('.md'));
  return file ? join(issues, file) : fail(`找不到票 ${id}：${issues}\\${id}-*.md`);
}

const canonical = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(',')}}`
      : JSON.stringify(value ?? null);

/**
 * 判法（合同）= 票头里除 owner / session / status 以外的字段 + 「**达标」那段（到 **Blocked by / **Status 或下一个标题为止，
 * 中间补的判法也算）+ 所有 ```gate 块。改了这些，哈希就变。
 */
export function readTicket(file: string) {
  const raw = readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  const front: Record<string, any> = fm ? (parse(fm[1]) ?? {}) : {};
  const body = fm ? raw.slice(fm[0].length) : raw;
  const gateRaw = [...body.matchAll(/^```gate[^\n]*\n([\s\S]*?)^```/gm)].map(m => m[1]);
  const gates: any[] = gateRaw.flatMap(text => {
    const parsed = parse(text);
    if (parsed && !Array.isArray(parsed)) fail(`${basename(file)} 的 gate 块要写成列表（每项 - id: …）`);
    return parsed ?? [];
  });
  const lines = body.split('\n');
  const start = lines.findIndex(l => /^\*\*达标/.test(l));
  let criteria = '';
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\*\*(Blocked by|Status)\b/i.test(lines[i]) || /^#{1,6}\s/.test(lines[i])) { end = i; break; }
    }
    criteria = lines.slice(start, end).join('\n').trim();
  }
  const { owner, session, status, ...contractFront } = front;
  const contract_sha = sha256(`${canonical(contractFront)}\n---\n${criteria}\n---\n${gateRaw.join('\n---\n')}`);
  return { raw, front, gates, criteria, contract_sha, hasCriteria: start >= 0 };
}

/** 票头 scope 里每个仓库在执行机上的位置：path（相对这条线所在仓库的上一级，或绝对路径），默认就是上一级目录里同名的文件夹。 */
export function scopeRepos(lineRepo: string, front: Record<string, any>) {
  const scope = front.scope ?? {};
  if (typeof scope !== 'object' || Array.isArray(scope)) fail('票头的 scope 要写成「仓库名: { paths: [...] }」');
  return Object.entries(scope).map(([key, entry]: [string, any]) => {
    const where = entry?.path ?? key;
    const dir = isAbsolute(where) ? where : resolve(dirname(lineRepo), where);
    return { key, dir, entry: entry ?? {} };
  });
}

/** 按标题取一节（到下一个同级或更高级标题为止）的哈希；没有这节返回 null。 */
export function sectionSha(file: string, heading: string) {
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  const level = /^(#+)/.exec(heading)?.[1].length ?? 2;
  const start = lines.findIndex(l => l.trim() === heading.trim());
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i]);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return sha256(lines.slice(start, end).join('\n').trimEnd());
}

export const ledgerFile = (lineDir: string) => join(lineDir, 'ledger.json');
export const loadLedger = (lineDir: string): Ledger => readJson(ledgerFile(lineDir), { line: basename(lineDir), tickets: {} } as Ledger);

function update(lineDir: string, fn: (ledger: Ledger) => void) {
  return withLock(`ledger-${sha256(lineDir).slice(0, 12)}`, () => {
    const ledger = loadLedger(lineDir);
    fn(ledger);
    writeJson(ledgerFile(lineDir), ledger);
    return ledger;
  });
}

export function init(opts: { dir: string; id?: string; authFile?: string; authHeading?: string }) {
  const lineDir = realPath(opts.dir);
  if (!existsSync(join(lineDir, 'issues'))) fail(`${lineDir} 下没有 issues/，不像一条线的目录`);
  const id = opts.id ?? basename(lineDir);
  const line: LineConfig = { id, dir: lineDir };
  if (opts.authFile) {
    const file = isAbsolute(opts.authFile) ? opts.authFile : join(repoRoot(lineDir), opts.authFile);
    const heading = opts.authHeading ?? '## 授权';
    const sha = sectionSha(file, heading) ?? fail(`${file} 里没有「${heading}」这一节`);
    line.auth = { file, heading, sha256: sha };
  }
  const config = loadConfig();
  config.lines = [...(config.lines ?? []).filter(l => l.id !== id && l.dir !== lineDir), line];
  saveConfig(config);
  if (!existsSync(ledgerFile(lineDir))) update(lineDir, () => {});
  return line;
}

const reopenable = (old: TicketEntry | undefined) => !(old && OPEN.includes(old.status) && old.status !== 'dispatched');

/**
 * dispatch --prepare：票头 scope 里同时写了 branch 和 path 的仓库，path 不在就建 worktree。
 * 源仓库是线所在仓库上一级目录里和仓库名同名的文件夹（或 scope 里的 repo 字段）。
 * 先把所有仓库都核一遍，有一个不行就整次失败、什么都不改；都行了再动手。已经是这个分支的 worktree 就不动。
 */
export function prepareWorktrees(lineRepo: string, front: Record<string, any>) {
  const plans: { key: string; source: string; target: string; branch: string; base: string; exists: boolean; branchExists: boolean }[] = [];
  for (const repo of scopeRepos(lineRepo, front)) {
    const { branch, path } = repo.entry;
    if (!branch || !path) continue;
    const base = repo.entry.base_branch ?? 'main';
    const source = resolve(dirname(lineRepo), repo.entry.repo ?? repo.key);
    const common = git(source, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!common.ok) fail(`${repo.key}：源仓库 ${source} 不是 git 仓库`);
    const target = repo.dir;
    if (existsSync(target)) {
      const theirs = git(target, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      const top = git(target, ['rev-parse', '--show-toplevel']);
      if (!theirs.ok || !top.ok || inside(top.out, target) !== '' || inside(common.out, theirs.out) !== '') fail(`${repo.key}：${target} 已经存在，但不是 ${source} 的 worktree；挪开或改票头的 path`);
      const current = git(target, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
      if (current !== branch) fail(`${repo.key}：${target} 是 worktree，但在分支 ${current}，票要的是 ${branch}`);
      plans.push({ key: repo.key, source, target, branch, base, exists: true, branchExists: true });
    } else {
      const branchExists = git(source, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
      if (!branchExists && !git(source, ['rev-parse', '--verify', '--quiet', base]).ok) fail(`${repo.key}：基准分支 ${base} 不存在`);
      plans.push({ key: repo.key, source, target, branch, base, exists: false, branchExists });
    }
  }
  const prepared: Record<string, string> = {};
  for (const plan of plans) {
    if (!plan.exists) {
      const r = plan.branchExists
        ? git(plan.source, ['worktree', 'add', plan.target, plan.branch])
        : git(plan.source, ['worktree', 'add', '-b', plan.branch, plan.target, plan.base]);
      if (!r.ok) fail(`${plan.key}：git worktree add 失败：${r.err}`);
    }
    prepared[plan.key] = plan.target;
  }
  return prepared;
}

export function dispatch(lineDir: string, id: string, opts: { owner?: string; session?: string; note?: string; prepare?: boolean }) {
  const file = findTicketFile(lineDir, id);
  const ticket = readTicket(file);
  if (!ticket.hasCriteria && !ticket.gates.length) fail(`票 ${id} 没有「**达标」段也没有 gate 块：先把判法写进票再派`);
  const lineRepo = repoRoot(lineDir);
  const already = loadLedger(lineDir).tickets[id];
  if (!reopenable(already)) fail(`票 ${id} 已经${STATUS_TEXT[already!.status]}，不能重派；要改判法先和用户定，再 csa ticket set ${id} abandoned 后另开一张`);
  const prepared = opts.prepare ? prepareWorktrees(lineRepo, ticket.front) : undefined;
  const heads: Record<string, string> = {};
  for (const repo of scopeRepos(lineRepo, ticket.front)) {
    const head = existsSync(repo.dir) ? git(repo.dir, ['rev-parse', 'HEAD']) : null;
    if (head?.ok) heads[repo.key] = head.out;
  }
  return update(lineDir, ledger => {
    const old = ledger.tickets[id];
    if (!reopenable(old)) fail(`票 ${id} 已经${STATUS_TEXT[old.status]}，不能重派；要改判法先和用户定，再 csa ticket set ${id} abandoned 后另开一张`);
    const now = iso();
    ledger.tickets[id] = {
      ticket: id, status: 'dispatched', owner: opts.owner ?? ticket.front.owner, session: opts.session ?? ticket.front.session,
      file: inside(lineDir, file) ?? file, contract_sha: ticket.contract_sha, heads,
      dispatched_at: now, updated_at: now, ...(prepared ? { prepared } : {}),
      history: [...(old?.history ?? []), { at: now, status: 'dispatched', note: opts.note, contract_sha: ticket.contract_sha }],
    };
  }).tickets[id];
}

export function setStatus(lineDir: string, id: string, status: string, note?: string) {
  if (!STATUSES.includes(status as Status)) fail(`状态只能是：${STATUSES.join('、')}`);
  if (status === 'dispatched') fail('「已派」只能由 csa ticket dispatch 设：开工以后退回「已派」等于绕过判法锁');
  return update(lineDir, ledger => {
    const entry = ledger.tickets[id] ?? fail(`台账里没有票 ${id}：先 csa ticket dispatch ${id}`);
    entry.status = status as Status;
    entry.updated_at = iso();
    entry.history.push({ at: entry.updated_at, status: status as Status, note });
  }).tickets[id];
}

/** 开工前补判法：只在「已派」时允许，记下新旧哈希和理由。 */
export function amend(lineDir: string, id: string, reason: string) {
  if (!reason?.trim()) fail('补判法要写理由：--reason "<为什么改>"');
  const file = findTicketFile(lineDir, id);
  const ticket = readTicket(file);
  return update(lineDir, ledger => {
    const entry = ledger.tickets[id] ?? fail(`台账里没有票 ${id}`);
    if (entry.status !== 'dispatched') fail(`票 ${id} 已经${STATUS_TEXT[entry.status]}：开工以后不能改判法（判法开工即锁定，见 docs/design.md）`);
    entry.history.push({ at: iso(), note: `补判法：${reason}（${entry.contract_sha.slice(0, 8)} → ${ticket.contract_sha.slice(0, 8)}）`, contract_sha: ticket.contract_sha });
    entry.contract_sha = ticket.contract_sha;
    entry.updated_at = iso();
  }).tickets[id];
}

export function contractChanged(lineDir: string, entry: TicketEntry) {
  const file = join(lineDir, entry.file);
  if (!existsSync(file)) return { changed: true, now: null };
  const now = readTicket(file).contract_sha;
  return { changed: now !== entry.contract_sha, now };
}

export function recordGate(lineDir: string, id: string, gate: { verdict: string; file: string }) {
  return update(lineDir, ledger => {
    const entry = ledger.tickets[id];
    if (!entry) return;
    const at = iso();
    entry.gate = { at, ...gate };
    entry.status = gate.verdict === 'fail' ? 'gate-failed' : 'handed-in';
    entry.updated_at = at;
    entry.history.push({ at, status: entry.status, note: `gate ${gate.verdict}` });
  });
}

/** 每个状态的下一跳：谁该做什么。 */
export const NEXT_TEXT: Record<Status, string> = {
  dispatched: '子会话核授权、核票，两条都过就 csa ticket set <票> started',
  started: '子会话在做；交回前跑 csa gate <票>',
  'handed-in': '总调度读 gate 结果、判 human 项，再 csa ticket accept <票> 或 set <票> rejected',
  'gate-failed': '子会话看 gate 结果里哪条不过，改完再跑 csa gate <票>',
  accepted: '已收尾，没有下一步',
  rejected: '子会话按验收意见改；改不了就由总调度作废重开',
  blocked: '总调度看卡在哪，补材料或改票',
  'waiting-user': '等用户定',
  abandoned: '已作废，没有下一步',
};

/**
 * 一张票的卡片：台账一条 + 这张票的排队作业 + gate 结论 + 各仓库派单时和现在的提交 + run log + 下一跳。
 * 纯读：不写任何文件，不碰锁。
 */
export function show(lineDir: string, id: string, queueItems: { id: string; ticket?: string; state: string; rc?: number | null; log: string; acked_at?: string; owner: string }[]) {
  const entry = loadLedger(lineDir).tickets[id] ?? fail(`台账里没有票 ${id}：先 csa ticket dispatch ${id}`);
  const file = join(lineDir, entry.file);
  const front = existsSync(file) ? readTicket(file).front : {};
  const lineRepo = repoRoot(lineDir);
  const heads: Record<string, { dispatched: string | null; now: string | null }> = {};
  for (const repo of scopeRepos(lineRepo, front)) {
    const head = existsSync(repo.dir) ? git(repo.dir, ['rev-parse', 'HEAD']) : null;
    heads[repo.key] = { dispatched: entry.heads[repo.key] ?? null, now: head?.ok ? head.out : null };
  }
  for (const key of Object.keys(entry.heads)) heads[key] ??= { dispatched: entry.heads[key], now: null };
  const jobs = queueItems.filter(i => i.ticket === id)
    .map(i => ({ id: i.id, owner: i.owner, state: i.state, rc: i.rc ?? null, acked: !!i.acked_at, log: i.log }));
  const gate = entry.gate ? { verdict: entry.gate.verdict, at: entry.gate.at, file: entry.gate.file, md: entry.gate.file.replace(/\.json$/, '.md') } : null;
  let runLog: string | null = null;
  if (typeof front.run_log === 'string') runLog = isAbsolute(front.run_log) ? front.run_log : join(lineRepo, front.run_log);
  else {
    const review = join(lineRepo, 'docs', 'review');
    const hit = existsSync(review) ? readdirSync(review).find(n => n.toLowerCase().startsWith(`t${id.toLowerCase()}-`) && n.endsWith('.md')) : undefined;
    if (hit) runLog = join(review, hit);
  }
  let next = NEXT_TEXT[entry.status];
  const running = jobs.find(j => j.state === 'running' || j.state === 'queued');
  const unacked = jobs.find(j => !['running', 'queued', 'cancelled', 'skipped'].includes(j.state) && !j.acked);
  if (entry.status === 'started' && running) next = `等作业 ${running.id} 跑完（${running.state}）`;
  else if (entry.status === 'started' && unacked) next = `取作业 ${unacked.id} 的结果（csa queue log），取完 csa queue ack ${unacked.id}`;
  return {
    ticket: id, status: entry.status, status_text: STATUS_TEXT[entry.status], owner: entry.owner ?? null, session: entry.session ?? null,
    file, contract_sha: entry.contract_sha, updated_at: entry.updated_at, jobs, gate, heads, run_log: runLog, next: next.replace(/<票>/g, id),
  };
}

export function showText(card: ReturnType<typeof show>) {
  const short = (sha: string | null) => sha ? sha.slice(0, 8) : '—';
  return [
    `票 ${card.ticket}：${card.status_text}，${card.owner ?? '?'}${card.session ? `（${card.session}）` : ''}，更新 ${new Date(card.updated_at).toLocaleString('sv-SE')}`,
    `票文件：${card.file}`,
    `作业：${card.jobs.length ? card.jobs.map(j => `${j.id} ${j.state}${j.rc !== null ? ` rc ${j.rc}` : ''}${j.acked ? '' : j.state === 'running' || j.state === 'queued' ? '' : ' 未取'}`).join('；') : '无'}`,
    `gate：${card.gate ? `${card.gate.verdict}，${card.gate.md}` : '还没跑'}`,
    `提交：${Object.entries(card.heads).map(([k, h]) => `${k} ${short(h.dispatched)} → ${short(h.now)}`).join('；') || '票头没有 scope'}`,
    `run log：${card.run_log ?? '没找到'}`,
    `下一跳：${card.next}`,
  ].join('\n');
}
