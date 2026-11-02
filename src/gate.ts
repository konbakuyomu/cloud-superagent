// csa gate：子会话交回前，照票里事先写定的 gate 块逐条跑检查，再查改动有没有越出票的范围、判法派单后有没有被改。
// 结果写 <仓库>/out/gate/t<票>.json 和 .md，并更新台账。约定见 docs/cli.md。
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { git, inside, matchesAny, parseDuration, runCaptured, writeJson, writeText } from './common.ts';
import { contractChanged, findTicketFile, loadLedger, readTicket, recordGate, repoRoot, scopeRepos } from './ticket.ts';
import { loadConfig } from './queue.ts';

interface CheckResult { id: string; kind: 'auto' | 'human'; ok: boolean | null; why: string; seconds?: number; code?: number | null; tail?: string }
interface Finding { code: string; message: string }

const tail = (text: string, lines = 15) => text.trimEnd().split(/\r?\n/).slice(-lines).join('\n');

/** 一个仓库里相对基准改过的文件（已提交 + 没提交 + 新文件）。 */
function changedFiles(dir: string, entry: any, recordedHead?: string) {
  const files = new Set<string>();
  const notes: string[] = [];
  const add = (out: string) => out.split('\n').map(s => s.trim()).filter(Boolean).forEach(f => files.add(f.replace(/\\/g, '/')));
  if (entry.branch) {
    const baseBranch = entry.base_branch ?? 'main';
    const base = git(dir, ['merge-base', baseBranch, entry.branch]);
    if (!base.ok) return { files: null, notes: [`找不到 ${entry.branch} 和 ${baseBranch} 的分叉点：${base.err}`] };
    add(git(dir, ['diff', '--name-only', base.out, entry.branch]).out);
    if (git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).out === entry.branch) {
      add(git(dir, ['diff', '--name-only', 'HEAD']).out);
      add(git(dir, ['ls-files', '--others', '--exclude-standard']).out);
    }
    notes.push(`比的是 ${entry.branch} 相对 ${baseBranch} 的分叉点 ${base.out.slice(0, 8)}`);
  } else {
    const base = entry.base ?? recordedHead ?? 'HEAD';
    const diff = git(dir, ['diff', '--name-only', base]);
    if (!diff.ok) return { files: null, notes: [`git diff ${base} 失败：${diff.err}`] };
    add(diff.out);
    add(git(dir, ['ls-files', '--others', '--exclude-standard']).out);
    notes.push(base === 'HEAD' ? '没有基准提交（派单时没记、票头也没写 base），只查了没提交的改动' : `比的是 ${base.slice(0, 8)} 以来的改动`);
  }
  return { files: [...files].sort(), notes };
}

export function gate(lineDir: string, id: string, opts: { out?: string; noLedger?: boolean; shell?: string }) {
  const file = findTicketFile(lineDir, id);
  const ticket = readTicket(file);
  const lineRepo = repoRoot(lineDir);
  const entry = loadLedger(lineDir).tickets[id];
  const findings: Finding[] = [];
  const notes: string[] = [];

  if (!entry) notes.push('台账里没有这张票（没经过 csa ticket dispatch），判法有没有被改查不了');
  else {
    const { changed, now } = contractChanged(lineDir, entry);
    if (changed) findings.push({ code: 'contract-changed', message: `判法在派单后被改过：派单时 ${entry.contract_sha.slice(0, 8)}，现在 ${now?.slice(0, 8) ?? '票文件不见了'}。开工前补判法要用 csa ticket amend` });
  }

  // 范围：每个仓库改过的文件都得落在 paths 里；forbid 里的 glob 一律不许碰
  const forbid: string[] = (ticket.front.forbid ?? []).filter((f: unknown) => typeof f === 'string' && /[*/]/.test(f));
  const unchecked: string[] = (ticket.front.forbid ?? []).filter((f: unknown) => typeof f === 'string' && !/[*/]/.test(f));
  if (unchecked.length) notes.push(`forbid 里这些不是路径，程序查不了，留给总调度：${unchecked.join('、')}`);
  const repos = scopeRepos(lineRepo, ticket.front);
  if (!repos.length) notes.push('票头没有 scope，没查改动范围');
  const outDir = opts.out ? resolve(opts.out) : join(lineRepo, 'out', 'gate');
  const scope: { repo: string; dir: string; strict: boolean; changed: string[] | null; outside: string[]; forbidden: string[]; notes: string[] }[] = [];
  for (const repo of repos) {
    if (!existsSync(repo.dir)) { findings.push({ code: 'scope-missing', message: `scope 里的仓库不在：${repo.dir}` }); continue; }
    const allowed: string[] = repo.entry.paths ?? [];
    // 有自己分支的仓库，改动都算这张票的，严格查；大家共用的工作区（例如共用的 main 工作区）里混着别的会话的改动，默认只提示
    const strict: boolean = repo.entry.strict ?? !!repo.entry.branch;
    const { files: raw, notes: n } = changedFiles(repo.dir, repo.entry, entry?.heads?.[repo.key]);
    const own = (f: string) => { const abs = join(repo.dir, f); return inside(outDir, abs) !== null || inside(join(lineDir, 'ledger.json'), abs) === ''; };
    const files = raw?.filter(f => !own(f)) ?? null;
    const outside = files ? files.filter(f => !matchesAny(f, allowed)) : [];
    const forbidden = files ? files.filter(f => matchesAny(f, forbid)) : [];
    const list = (fs: string[]) => `${fs.slice(0, 20).join('、')}${fs.length > 20 ? ` 等 ${fs.length} 个` : ''}`;
    if (!files) findings.push({ code: 'scope-unknown', message: `${repo.key}：${n.join('；')}` });
    if (outside.length && strict) findings.push({ code: 'out-of-scope', message: `${repo.key} 改了票范围外的文件：${list(outside)}` });
    if (outside.length && !strict) notes.push(`${repo.key} 是共用的工作区，这些范围外的改动可能是别的会话做的，没判不过，总调度看一眼：${list(outside)}`);
    if (forbidden.length) findings.push({ code: 'forbidden-path', message: `${repo.key} 碰了不许碰的路径：${list(forbidden)}` });
    scope.push({ repo: repo.key, dir: repo.dir, strict, changed: files, outside, forbidden, notes: n });
  }

  // 检查清单：human 项不跑，留给总调度判
  if (!ticket.gates.length) findings.push({ code: 'no-gate', message: '票里没有 ```gate 块，没有可跑的检查' });
  const checks: CheckResult[] = [];
  const shell = opts.shell ?? loadConfig().shell;
  for (const [n, check] of ticket.gates.entries()) {
    const cid = String(check?.id ?? `#${n + 1}`);
    if (check?.human) { checks.push({ id: cid, kind: 'human', ok: null, why: String(check.human) }); continue; }
    if (!check?.run) { checks.push({ id: cid, kind: 'auto', ok: false, why: '没写 run' }); continue; }
    const cwd = check.cwd ? (isAbsolute(check.cwd) ? check.cwd : resolve(lineRepo, check.cwd)) : lineRepo;
    const timeout = typeof check.timeout === 'number' ? check.timeout : parseDuration(check.timeout, 600);
    const r = runCaptured(String(check.run), cwd, timeout, shell);
    const expect = check.expect ?? {};
    const wantExit = expect.exit ?? 0;
    const problems: string[] = [];
    if (r.timedOut) problems.push(`超时（${timeout} s）`);
    if (r.error) problems.push(`起不来：${r.error}`);
    if (!r.timedOut && !r.error && r.code !== wantExit) problems.push(`退出码 ${r.code}，要 ${wantExit}`);
    if (expect.stdout && !new RegExp(expect.stdout, 'm').test(r.stdout)) problems.push(`输出里没有 /${expect.stdout}/`);
    if (expect.not_stdout && new RegExp(expect.not_stdout, 'm').test(r.stdout)) problems.push(`输出里出现了 /${expect.not_stdout}/`);
    checks.push({ id: cid, kind: 'auto', ok: !problems.length, why: problems.join('；') || '过', seconds: r.seconds, code: r.code, tail: tail(`${r.stdout}\n${r.stderr}`) });
  }

  const autoFailed = checks.some(c => c.kind === 'auto' && !c.ok);
  const humanPending = checks.some(c => c.kind === 'human');
  const verdict = findings.length || autoFailed ? 'fail' : humanPending ? 'pending-human' : 'pass';
  const base = join(outDir, `t${id}`);
  const result = { ticket: id, at: new Date().toISOString(), verdict, file: inside(lineRepo, file) ?? file, contract_sha: ticket.contract_sha, findings, checks, scope, notes };
  writeJson(`${base}.json`, result);
  const verdictText = { pass: '过', 'pending-human': '自动项都过，还有要总调度判的', fail: '不过' }[verdict];
  writeText(`${base}.md`, [
    `# 票 ${id} gate：${verdictText}`,
    '',
    `${new Date().toLocaleString('sv-SE')}，票文件 \`${result.file}\`，判法哈希 ${ticket.contract_sha.slice(0, 12)}。`,
    '',
    '## 检查',
    ...checks.map(c => `- ${c.kind === 'human' ? '要人判' : c.ok ? '过' : '不过'}　${c.id}：${c.why}${c.seconds !== undefined ? `（${c.seconds} s）` : ''}`),
    ...(findings.length ? ['', '## 问题', ...findings.map(f => `- ${f.code}：${f.message}`)] : []),
    ...(notes.length ? ['', '## 说明', ...notes.map(n => `- ${n}`)] : []),
    ...(scope.length ? ['', '## 改动范围', ...scope.map(s => `- ${s.repo}（${s.strict ? '严格查' : '共用工作区，只提示'}）：改了 ${s.changed?.length ?? '?'} 个文件，范围外 ${s.outside.length}，禁区 ${s.forbidden.length}（${s.notes.join('；')}）`)] : []),
    '',
  ].join('\n'));
  if (!opts.noLedger && entry) recordGate(lineDir, id, { verdict, file: `${base}.json` });
  return { ...result, out: `${base}.json` };
}
