#!/usr/bin/env node
// 四个命令的场景测试：csa queue（顺序、上限、依赖、时间窗、取消、单例、排队页）、csa patrol、csa ticket（判法锁）、
// csa gate（检查、范围、禁区、人判、分支），加命令行本身（数据目录、--help、错误）。每个场景用自己的临时数据目录和临时仓库。
// Q/P/T/G 共 34 项照搬自原来的私有任务仓库的调度测试，只把 board 换成 csa、改成不经 shell 起子进程；C1–C5 是这个仓库加的。
// `npm test` 会跑；Linux、macOS、Windows 都能跑，只要有 node 和 git。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const csa = join(repo, 'bin', 'csa.mjs');
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`✓ ${name}`);
  else { failed++; console.log(`✗ ${name}${detail ? `\n    ${detail}` : ''}`); }
};
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
// realpath：Windows 的临时目录常是 8.3 短名（RUNNER~1），git 报的是长名，统一成长名
const tmp = prefix => realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
const freshData = () => tmp('csa-data-');
// 不经 shell：node 直接跑 bin/csa.mjs，参数原样传过去
const board = (data, args, cwd = repo, env = { CSA_DATA_DIR: data }) => {
  const r = spawnSync(process.execPath, [csa, ...args], { cwd, encoding: 'utf8', env: { ...process.env, CSA_DATA_DIR: undefined, ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const runner = (data, extra = [], env = {}) => new Promise(done => {
  const child = spawn(process.execPath, [csa, 'queue', 'run', '--idle-exit', '1', '--tick', '150', ...extra], { cwd: repo, env: { ...process.env, CSA_DATA_DIR: data, ...env } });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  // 排队程序 120 秒还没退出就算卡死：停掉它，输出里记 RUNNER-TIMEOUT，后面的断言自然不过
  const guard = setTimeout(() => { out += '\nRUNNER-TIMEOUT'; child.kill('SIGKILL'); }, 120_000);
  child.on('exit', code => { clearTimeout(guard); done({ code, out }); });
});
const state = data => JSON.parse(readFileSync(join(data, 'queue.json'), 'utf8'));
const item = (data, owner) => state(data).items.find(i => i.owner === owner);
const node = code => `node -e "${code}"`;
const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

// ---------- csa queue ----------
{
  const d = freshData();
  board(d, ['queue', 'add', '--owner', 'A', '--est', '2s', '--', node('setTimeout(()=>{},600)')]);
  board(d, ['queue', 'add', '--owner', 'B', '--est', '2s', '--', node("console.log('hi there')")]);
  await runner(d);
  const [a, b] = [item(d, 'A'), item(d, 'B')];
  check('Q1 两个作业先后跑完，不重叠', a.state === 'done' && b.state === 'done' && Date.parse(b.start_at) >= Date.parse(a.end_at), JSON.stringify([a, b]));
  check('Q2 多个参数照 shell 规矩加引号，输出进日志', readFileSync(b.log, 'utf8').includes('hi there'));
  check('Q3 排队页写在数据目录，跑完的列出来、标「还没取」', readFileSync(join(d, 'queue.md'), 'utf8').includes('负责的会话还没取'));
}
{
  const d = freshData();
  board(d, ['queue', 'add', '--owner', 'A', '--est', '1s', '--limit', '2s', '--', node('setTimeout(()=>{},60000)')]);
  board(d, ['queue', 'add', '--owner', 'B', '--est', '1s', '--', node('process.exit(3)')]);
  const started = Date.now();
  await runner(d);
  const [a, b] = [item(d, 'A'), item(d, 'B')];
  check('Q4 超过上限的作业被停掉，记原因', a.state === 'killed' && a.reason === 'limit' && Date.now() - started < 20000, JSON.stringify(a));
  check('Q5 出错退出记退出码，下一个照开', b.state === 'failed' && b.rc === 3, JSON.stringify(b));
}
{
  const d = freshData();
  const first = board(d, ['queue', 'add', '--owner', 'A', '--est', '1s', '--json', '--', node('process.exit(1)')]);
  const firstId = JSON.parse(first.out).id;
  board(d, ['queue', 'add', '--owner', 'B', '--est', '1s', '--after', firstId, '--', node('0')]);
  const ok = JSON.parse(board(d, ['queue', 'add', '--owner', 'C', '--est', '1s', '--json', '--', node('0')]).out).id;
  board(d, ['queue', 'add', '--owner', 'D', '--est', '1s', '--after', ok, '--', node('0')]);
  await runner(d);
  check('Q6 依赖没成功的作业自动取消，依赖成功的照跑', item(d, 'B').state === 'cancelled' && item(d, 'D').state === 'done', JSON.stringify(state(d).items.map(i => [i.owner, i.state])));
}
{
  const d = freshData();
  board(d, ['queue', 'add', '--owner', 'LONG', '--est', '60s', '--', node('0')]);
  board(d, ['queue', 'add', '--owner', 'SHORT', '--est', '1s', '--', node('0')]);
  // 先排作业、再设时间窗、马上开排队程序：慢机器上起 tsx 也要几秒，时间窗留够余量
  board(d, ['queue', 'curfew', '--kill-at', '+6s', '--note', '测试']);
  await runner(d);
  check('Q7 时间窗：放不下的长作业不开，后面放得下的短作业照开', item(d, 'LONG').state === 'queued' && item(d, 'SHORT').state === 'done', JSON.stringify(state(d).items.map(i => [i.owner, i.state])));
  const p = board(d, ['patrol']);
  check('Q8 时间窗到点后排着的作业不报「排队程序没在跑」', p.code === 0 && p.out.includes('时间窗已到点'), p.out);
  board(d, ['queue', 'curfew', '--clear']);
  await runner(d);
  check('Q9 解除时间窗后照常跑', item(d, 'LONG').state === 'done');
}
{
  const d = freshData();
  board(d, ['queue', 'add', '--owner', 'A', '--est', '1s', '--', node('setTimeout(()=>{},60000)')]);
  board(d, ['queue', 'curfew', '--kill-at', '+5s']);
  await runner(d);
  check('Q10 时间窗到点停掉还在跑的作业', item(d, 'A').state === 'killed' && item(d, 'A').reason === 'curfew', JSON.stringify(item(d, 'A')));
}
{
  const d = freshData();
  const mirror = join(freshData(), 'mirror-queue.md');
  board(d, ['queue', 'config', '--add-view', mirror]);
  const long = JSON.parse(board(d, ['queue', 'add', '--owner', 'A', '--est', '30s', '--json', '--', node('setTimeout(()=>{},60000)')]).out).id;
  const queued = JSON.parse(board(d, ['queue', 'add', '--owner', 'B', '--est', '1s', '--json', '--', node('0')]).out).id;
  const run = runner(d);
  for (let i = 0; i < 60 && item(d, 'A').state !== 'running'; i++) await new Promise(r => setTimeout(r, 100));
  const second = await runner(d);
  check('Q11 排队程序只能开一个：第二个直接退出', second.code === 0 && second.out.includes('已经在跑'), second.out);
  board(d, ['queue', 'cancel', queued]);
  board(d, ['queue', 'cancel', long]);
  await run;
  check('Q12 取消：排着的直接取消，在跑的被停掉', item(d, 'B').state === 'cancelled' && item(d, 'A').state === 'killed' && item(d, 'A').reason === 'cancel', JSON.stringify(state(d).items.map(i => [i.owner, i.state, i.reason])));
  check('Q13 排队页另写一份到配置的路径', existsSync(mirror) && readFileSync(mirror, 'utf8').includes('程序生成，只读'));
}

// ---------- csa patrol ----------
{
  const d = freshData();
  let p = board(d, ['patrol']);
  check('P1 没事：输出 OK，退出码 0', p.code === 0 && p.out.startsWith('OK'), p.out);
  const id = JSON.parse(board(d, ['queue', 'add', '--owner', 'B', '--session', 'session_x', '--est', '1s', '--json', '--', node('0')]).out).id;
  p = board(d, ['patrol', '--json']);
  check('P2 排着作业、排队程序没在跑 → runner-down，退出码 3', p.code === 3 && JSON.parse(p.out).anomalies.some(a => a.code === 'runner-down'), p.out);
  await runner(d);
  p = board(d, ['patrol', '--json', '--ack-after', '0']);
  const unacked = JSON.parse(p.out).anomalies.find(a => a.code === 'finished-unacked');
  check('P3 跑完没人取 → finished-unacked，带负责会话', unacked?.owner === 'B' && unacked?.session === 'session_x', p.out);
  board(d, ['queue', 'ack', id, '--by', 'B']);
  p = board(d, ['patrol', '--ack-after', '0']);
  check('P4 取走（ack）以后不再报', p.code === 0, p.out);
}

// ---------- csa ticket 和 csa gate：临时的线仓库和代码仓库 ----------
const parent = tmp('csa-repos-');
const lineRepo = join(parent, 'board-repo');
const codeRepo = join(parent, 'code-repo');
for (const r of [lineRepo, codeRepo]) { mkdirSync(r, { recursive: true }); git(r, 'init', '-q', '-b', 'main'); }
write(join(lineRepo, 'CLAUDE.md'), '# 板\n\n## 工作约定\n\n- 一条\n\n## 授权\n\n> 用户原话：全权委托。\n');
write(join(lineRepo, 'docs', 'review', '.keep'), '');
write(join(codeRepo, 'tools', 'a.py'), 'print(1)\n');
for (const r of [lineRepo, codeRepo]) { git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', 'init'); }
const lineDir = join(lineRepo, '.scratch', 'demo');
const ticket = (id, { front = '', criteria = '', gateBlock = '' } = {}) => write(join(lineDir, 'issues', `${id}-demo.md`), [
  front ? `---\n${front}\n---\n` : '',
  `# ${id}: 演示\n\n**What to build:** 改 tools/a.py。\n\n`,
  criteria ? `**达标（事先定）：**\n${criteria}\n\n` : '',
  gateBlock ? `\`\`\`gate\n${gateBlock}\n\`\`\`\n\n` : '',
  '**Blocked by:** 无\n\n**Status:** 排队\n',
].join(''));
const scopeFront = (extra = '') => `owner: B\nscope:\n  code-repo: { strict: true, paths: ["tools/**"] }\n  board-repo: { paths: ["docs/review/t*.md", ".scratch/**"] }\nforbid: ["generated/**", "git push"]${extra}`;
const passGate = `- id: 1-runs\n  run: ${node("console.log('ALL GOOD')")}\n  expect: { exit: 0, stdout: "ALL GOOD" }`;
{
  const d = freshData();
  ticket('60');
  const init = board(d, ['ticket', 'init', '--dir', lineDir, '--auth-file', 'CLAUDE.md']);
  check('T1 登记一条线并记下授权一节的哈希', init.code === 0 && init.out.includes('授权一节'), init.out);
  check('T2 没有达标段也没有 gate 块的票不让派', board(d, ['ticket', 'dispatch', '60', '--dir', lineDir, '--owner', 'B']).code === 1);
  ticket('61', { front: scopeFront(), criteria: '1. 跑通。', gateBlock: passGate });
  const sent = board(d, ['ticket', 'dispatch', '61', '--dir', lineDir, '--owner', 'B']);
  const ledger = () => JSON.parse(readFileSync(join(lineDir, 'ledger.json'), 'utf8'));
  check('T3 派单记下判法哈希和 scope 里各仓库的当前提交', sent.code === 0 && ledger().tickets['61'].contract_sha && ledger().tickets['61'].heads['code-repo'], sent.out);
  const before = ledger().tickets['61'].contract_sha;
  ticket('61', { front: scopeFront().replace('owner: B', 'owner: A'), criteria: '1. 跑通。', gateBlock: passGate });
  check('T4 只改票头的 owner，判法哈希不变', board(d, ['ticket', 'dispatch', '61', '--dir', lineDir, '--owner', 'A']).code === 0 && ledger().tickets['61'].contract_sha === before);
  ticket('61', { front: scopeFront(), criteria: '1. 跑通。\n2. 开跑前补的一条。', gateBlock: passGate });
  check('T5 开工前补判法：amend 要理由，记下新旧哈希', board(d, ['ticket', 'amend', '61', '--dir', lineDir]).code === 1
    && board(d, ['ticket', 'amend', '61', '--dir', lineDir, '--reason', '量完再补']).code === 0 && ledger().tickets['61'].contract_sha !== before);
  board(d, ['ticket', 'set', '61', 'started', '--dir', lineDir]);
  check('T6 开工以后不能 amend，也不能退回「已派」', board(d, ['ticket', 'amend', '61', '--dir', lineDir, '--reason', 'x']).code === 1
    && board(d, ['ticket', 'set', '61', 'dispatched', '--dir', lineDir]).code === 1);

  write(join(codeRepo, 'tools', 'a.py'), 'print(2)\n');
  write(join(lineRepo, 'docs', 'review', 't61-run.md'), '# run log\n');
  let g = board(d, ['gate', '61', '--dir', lineDir, '--json']);
  let r = JSON.parse(g.out);
  check('G1 范围内的改动、检查都过 → gate 过，台账改成「交回待验」，结果写进 out/gate', g.code === 0 && r.verdict === 'pass' && ledger().tickets['61'].status === 'handed-in' && existsSync(join(lineRepo, 'out', 'gate', 't61.json')) && existsSync(join(lineRepo, 'out', 'gate', 't61.md')), g.out);
  check('G2 forbid 里不是路径的项（git push）列为程序查不了', r.notes.some(n => n.includes('git push')));
  let p = board(d, ['patrol', '--json', '--accept-after', '0']);
  check('P5 交回以后总调度一直没验 → handed-in-waiting', JSON.parse(p.out).anomalies.some(a => a.code === 'handed-in-waiting' && a.ticket === '61'), p.out);

  write(join(codeRepo, 'README.md'), 'x\n');
  write(join(codeRepo, 'generated', 'out.bin'), 'x\n');
  g = board(d, ['gate', '61', '--dir', lineDir, '--json']);
  r = JSON.parse(g.out);
  check('G3 改了范围外的文件 → out-of-scope；碰了禁区 → forbidden-path；gate 不过、退出码 1、台账「gate 不过」',
    g.code === 1 && r.findings.some(f => f.code === 'out-of-scope' && f.message.includes('README.md')) && r.findings.some(f => f.code === 'forbidden-path') && ledger().tickets['61'].status === 'gate-failed', g.out);
  spawnSync('git', ['checkout', '--', '.'], { cwd: codeRepo });
  // 只删这一步自己建的两个文件和一个空目录（一次一个明确路径），不用 git clean：执行机的规矩不许批量删除
  unlinkSync(join(codeRepo, 'README.md'));
  unlinkSync(join(codeRepo, 'generated', 'out.bin'));
  rmdirSync(join(codeRepo, 'generated'));

  ticket('61', { front: scopeFront(), criteria: '1. 跑通。\n2. 开跑前补的一条。\n3. 偷偷放宽。', gateBlock: passGate });
  g = board(d, ['gate', '61', '--dir', lineDir, '--json']);
  check('G4 开工后改了判法 → contract-changed，gate 不过', JSON.parse(g.out).findings.some(f => f.code === 'contract-changed'), g.out);
  p = board(d, ['patrol', '--json']);
  check('P6 巡检也报 contract-changed', JSON.parse(p.out).anomalies.some(a => a.code === 'contract-changed' && a.ticket === '61'), p.out);

  write(join(lineRepo, 'CLAUDE.md'), readFileSync(join(lineRepo, 'CLAUDE.md'), 'utf8').replace('全权委托', '全权委托（被改过）'));
  p = board(d, ['patrol', '--json']);
  check('P7 授权一节被改 → auth-changed', JSON.parse(p.out).anomalies.some(a => a.code === 'auth-changed'), p.out);

  ticket('62', { front: scopeFront(), criteria: '1. 过。\n2. 归因说得通。', gateBlock: `${passGate}\n- id: 2-attribution\n  human: 开路归因说得通` });
  board(d, ['ticket', 'dispatch', '62', '--dir', lineDir, '--owner', 'B']);
  g = board(d, ['gate', '62', '--dir', lineDir, '--json']);
  check('G5 有人判项、自动项都过 → pending-human，台账「交回待验」', g.code === 0 && JSON.parse(g.out).verdict === 'pending-human' && ledger().tickets['62'].status === 'handed-in', g.out);
  check('G6 共用工作区里别人改的文件（CLAUDE.md）只提示不判不过；gate 自己的输出和台账不算改动',
    JSON.parse(g.out).notes.some(n => n.includes('共用的工作区') && n.includes('CLAUDE.md') && !n.includes('out/gate') && !n.includes('ledger.json')), g.out);

  ticket('63', { front: scopeFront(), criteria: '1. 输出对。', gateBlock: `- id: 1-wrong\n  run: ${node("console.log('nope')")}\n  expect: { stdout: "ALL GOOD" }` });
  board(d, ['ticket', 'dispatch', '63', '--dir', lineDir, '--owner', 'B']);
  g = board(d, ['gate', '63', '--dir', lineDir, '--json']);
  check('G7 检查的输出对不上 → 不过', g.code === 1 && JSON.parse(g.out).checks[0].ok === false, g.out);

  git(codeRepo, 'checkout', '-q', '-b', 't64');
  write(join(codeRepo, 'tools', 'b.py'), 'print(3)\n');
  write(join(codeRepo, 'notes.txt'), 'x\n');
  git(codeRepo, 'add', '-A');
  git(codeRepo, 'commit', '-q', '-m', 'work');
  git(codeRepo, 'checkout', '-q', 'main');
  ticket('64', { front: 'owner: B\nscope:\n  code-repo: { branch: t64, base_branch: main, paths: ["tools/**"] }', criteria: '1. 过。', gateBlock: passGate });
  board(d, ['ticket', 'dispatch', '64', '--dir', lineDir, '--owner', 'B']);
  g = board(d, ['gate', '64', '--dir', lineDir, '--json']);
  r = JSON.parse(g.out);
  check('G8 按分支查范围：分叉点以来分支上的改动都算，范围外的照报', r.findings.some(f => f.code === 'out-of-scope' && f.message.includes('notes.txt') && !f.message.includes('b.py')), g.out);

  // 第二期 6.1：csa ticket show
  ticket('65', { front: scopeFront(), criteria: '1. 过。', gateBlock: passGate });
  board(d, ['ticket', 'dispatch', '65', '--dir', lineDir, '--owner', 'B', '--session', 'sess-b']);
  write(join(lineRepo, 'docs', 'review', 't65-run.md'), '# run log\n');
  const job65 = JSON.parse(board(d, ['queue', 'add', '--owner', 'B', '--ticket', '65', '--est', '1s', '--json', '--', node('0')]).out).id;
  await runner(d);
  board(d, ['gate', '65', '--dir', lineDir]);
  const snapshot = () => [d, lineDir, lineRepo].flatMap(root => {
    const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.name === '.git' ? [] : e.isDirectory() ? walk(join(dir, e.name)) : [`${join(dir, e.name)}@${statSync(join(dir, e.name)).mtimeMs}`]);
    return walk(root);
  }).sort().join('\n');
  const before65 = snapshot();
  const sj = board(d, ['ticket', 'show', '65', '--dir', lineDir, '--json']);
  const card = JSON.parse(sj.out);
  check('T7 show --json 有 status、jobs[0].id、gate.verdict 和 gate.file、heads.<仓库>.dispatched 和 .now、next',
    sj.code === 0 && card.status === 'handed-in' && card.jobs[0]?.id === job65 && card.gate?.verdict === 'pass' && card.gate?.file.endsWith('t65.json')
      && card.heads['code-repo']?.dispatched && card.heads['code-repo']?.now && card.run_log?.endsWith('t65-run.md') && card.next.includes('accept'), sj.out);
  const st = board(d, ['ticket', 'show', '65', '--dir', lineDir]);
  const stLines = st.out.trim().split('\n');
  check('T8 文本输出每一项一行，下一跳在最后一行', st.code === 0 && stLines.length === 8 && stLines.at(-1).startsWith('下一跳：') && stLines.some(l => l.startsWith('gate：pass')), st.out);
  check('T9 show 前后数据目录、线的目录和线所在仓库里所有文件的 mtime 不变', snapshot() === before65);

  // 第二期 6.4：csa ticket dispatch --prepare
  const wt = join(parent, 'code-repo-t66');
  const branches = () => git(codeRepo, 'branch', '--format=%(refname:short)').stdout.trim().split('\n').sort().join(',');
  ticket('66', { front: 'owner: B\nscope:\n  code-repo: { branch: t66, base_branch: main, path: code-repo-t66, paths: ["tools/**"] }', criteria: '1. 过。', gateBlock: passGate });
  const p66 = board(d, ['ticket', 'dispatch', '66', '--dir', lineDir, '--owner', 'B', '--prepare']);
  const wtBranch = git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  const fork = git(codeRepo, 'merge-base', 'main', 't66').stdout.trim();
  check('T10 --prepare 后 path 是一个 worktree，当前分支是 branch，分叉点是 base_branch 的 HEAD',
    p66.code === 0 && existsSync(join(wt, 'tools', 'a.py')) && wtBranch === 't66' && fork === git(codeRepo, 'rev-parse', 'main').stdout.trim() && ledger().tickets['66'].prepared?.['code-repo'], p66.out);
  const branchesBefore = branches();
  const again = board(d, ['ticket', 'dispatch', '66', '--dir', lineDir, '--owner', 'B', '--prepare']);
  check('T11 再派一次不报错，不新建分支', again.code === 0 && branches() === branchesBefore, again.out);
  mkdirSync(join(parent, 'code-repo-t67'), { recursive: true });
  write(join(parent, 'code-repo-t67', 'keep.txt'), 'x\n');
  ticket('67', { front: 'owner: B\nscope:\n  code-repo: { branch: t67, base_branch: main, path: code-repo-t67, paths: ["tools/**"] }', criteria: '1. 过。', gateBlock: passGate });
  const b67 = branches();
  const p67 = board(d, ['ticket', 'dispatch', '67', '--dir', lineDir, '--owner', 'B', '--prepare']);
  check('T12 path 已经存在但不是 worktree：退出码 1，台账没有这张票，分支列表不变', p67.code === 1 && !ledger().tickets['67'] && branches() === b67, p67.out);
  board(d, ['ticket', 'set', '66', 'started', '--dir', lineDir]);
  write(join(wt, 'tools', 'c.py'), 'print(4)\n');
  write(join(wt, 'README.md'), 'outside\n');
  const g66 = board(d, ['gate', '66', '--dir', lineDir, '--json']);
  const r66 = JSON.parse(g66.out);
  check('T13 在建好的 worktree 里改一个范围外的文件，csa gate 报 out-of-scope（严格查）',
    g66.code === 1 && r66.findings.some(f => f.code === 'out-of-scope' && f.message.includes('README.md') && !f.message.includes('c.py')), g66.out);

  // P1-1：票头 publish
  ticket('68', { front: `${scopeFront()}\npublish:\n  - { repo: someone/demo, actions: [push, tweet] }`, criteria: '1. 过。', gateBlock: passGate });
  const p68 = board(d, ['ticket', 'dispatch', '68', '--dir', lineDir, '--owner', 'B']);
  check('T14 publish 里有不认识的动作：不让派，退出码 1', p68.code === 1 && p68.out.includes('tweet') && !ledger().tickets['68'], p68.out);
  ticket('69', { front: `${scopeFront()}\npublish:\n  - { repo: someone/demo, actions: [push] }`, criteria: '1. 过。', gateBlock: passGate });
  board(d, ['ticket', 'dispatch', '69', '--dir', lineDir, '--owner', 'B']);
  let g69 = JSON.parse(board(d, ['gate', '69', '--dir', lineDir, '--json']).out);
  const listed = g69.notes.some(n => n.includes('someone/demo') && n.includes('push') && n.includes('本人'));
  ticket('69', { front: `${scopeFront()}\npublish:\n  - { repo: someone/demo, actions: [push, pr] }`, criteria: '1. 过。', gateBlock: passGate });
  g69 = JSON.parse(board(d, ['gate', '69', '--dir', lineDir, '--json']).out);
  check('T15 publish 算进判法：派单后放宽 publish → contract-changed', listed && g69.findings.some(f => f.code === 'contract-changed'), JSON.stringify(g69));
  ticket('70', { front: scopeFront(), criteria: '1. 过。', gateBlock: passGate });
  board(d, ['ticket', 'dispatch', '70', '--dir', lineDir, '--owner', 'B']);
  const g70 = JSON.parse(board(d, ['gate', '70', '--dir', lineDir, '--json']).out);
  check('T16 没写 publish 的票，gate 写明不许做任何发布类动作', g70.notes.some(n => n.includes('不许做任何发布类动作')), JSON.stringify(g70.notes));

  // 第三期：票头 model（docs/models.md）
  ticket('71', { front: scopeFront('\nmodel: opus'), criteria: '1. 过。', gateBlock: passGate });
  board(d, ['ticket', 'dispatch', '71', '--dir', lineDir, '--owner', 'B']);
  const sha71 = ledger().tickets['71'].contract_sha;
  ticket('71', { front: scopeFront('\nmodel: sonnet\neffort: high'), criteria: '1. 过。', gateBlock: passGate });
  const g71 = JSON.parse(board(d, ['gate', '71', '--dir', lineDir, '--json']).out);
  check('T17 只改票头的 model、effort，判法哈希不变，gate 不报 contract-changed', !g71.findings.some(f => f.code === 'contract-changed') && g71.contract_sha === sha71, JSON.stringify(g71.findings));
  ticket('72', { front: scopeFront('\nmodel: gpt-9'), criteria: '1. 过。', gateBlock: passGate });
  const p72 = board(d, ['ticket', 'dispatch', '72', '--dir', lineDir, '--owner', 'B']);
  check('T18 票头 model 写法不认识：不让派，退出码 1', p72.code === 1 && p72.out.includes('gpt-9') && !ledger().tickets['72'], p72.out);
  const c71 = JSON.parse(board(d, ['ticket', 'show', '71', '--dir', lineDir, '--json']).out);
  const c70 = JSON.parse(board(d, ['ticket', 'show', '70', '--dir', lineDir, '--json']).out);
  check('T19 show 给出票头的 model；没写的给 null', c71.model === 'sonnet' && c70.model === null, JSON.stringify([c71.model, c70.model]));

  // Codex 审查后修的：--prepare 先查分支是不是已经在别的 worktree 检出
  git(codeRepo, 'branch', 't73', 'main');
  git(codeRepo, 'worktree', 'add', join(parent, 'code-repo-t73-a'), 't73');
  ticket('73', { front: 'owner: B\nscope:\n  code-repo: { branch: t73, base_branch: main, path: code-repo-t73-b, paths: ["tools/**"] }', criteria: '1. 过。', gateBlock: passGate });
  const p73 = board(d, ['ticket', 'dispatch', '73', '--dir', lineDir, '--owner', 'B', '--prepare']);
  check('T20 分支已经在别的 worktree 检出：--prepare 不让派，不建新目录，台账没这张票',
    p73.code === 1 && p73.out.includes('已经在') && !existsSync(join(parent, 'code-repo-t73-b')) && !ledger().tickets['73'], p73.out);
  // 同号的票在两条线上：show 按线分开作业
  const lineDir2 = join(lineRepo, '.scratch', 'demo2');
  write(join(lineDir2, 'issues', '65-other.md'), `---\n${scopeFront()}\n---\n\n# 65: 另一条线\n\n**达标（事先定）：**\n1. 过。\n\n\`\`\`gate\n${passGate}\n\`\`\`\n`);
  board(d, ['ticket', 'init', '--dir', lineDir2]);
  board(d, ['ticket', 'dispatch', '65', '--dir', lineDir2, '--owner', 'C']);
  const job65b = JSON.parse(board(d, ['queue', 'add', '--owner', 'C', '--ticket', '65', '--line', 'demo2', '--est', '1s', '--json', '--', node('0')]).out).id;
  const s1 = JSON.parse(board(d, ['ticket', 'show', '65', '--dir', lineDir, '--json']).out);
  const s2 = JSON.parse(board(d, ['ticket', 'show', '65', '--dir', lineDir2, '--json']).out);
  check('T21 同号的票在两条线上：写了 --line 的作业只进自己那条线的卡片；没写的标 line_unknown',
    !s1.jobs.some(j => j.id === job65b) && s2.jobs.some(j => j.id === job65b && !j.line_unknown) && s1.jobs.some(j => j.id === job65 && j.line_unknown), JSON.stringify([s1.jobs, s2.jobs]));
  board(d, ['ticket', 'set', '65', 'started', '--dir', lineDir2]);
  const s3 = JSON.parse(board(d, ['ticket', 'show', '65', '--dir', lineDir2, '--json']).out);
  const s3t = board(d, ['ticket', 'show', '65', '--dir', lineDir2]).out;
  check('T22 线不明的作业只列出来、标「线不明」，不拿来指下一跳', !s3.next.includes(job65) && s3t.includes('线不明'), `${s3.next}\n${s3t}`);
}

// ---------- 命令行本身（这个仓库加的） ----------
{
  const d = join(freshData(), 'nested', 'data');
  const r = board(null, ['queue', 'status', '--json'], repo, { CSA_DATA_DIR: d });
  check('C1 数据目录取环境变量 CSA_DATA_DIR，目录不在就建', r.code === 0 && existsSync(d) && JSON.parse(r.out).queued.length === 0, r.out);
  const env = freshData(), flag = freshData();
  board(null, ['queue', '--data-dir', flag, 'add', '--owner', 'F', '--est', '1s', '--', node('0')], repo, { CSA_DATA_DIR: env });
  check('C2 --data-dir 盖过环境变量', existsSync(join(flag, 'queue.json')) && !existsSync(join(env, 'queue.json')));
  const helps = ['queue', 'ticket', 'gate', 'patrol'].map(c => spawnSync(process.execPath, [join(repo, 'bin', `csa-${c}.mjs`), '--help'], { encoding: 'utf8' }));
  check('C3 四个单独的命令都能 --help，退出码 0', helps.every((h, i) => h.status === 0 && h.stdout.includes(`csa ${['queue', 'ticket', 'gate', 'patrol'][i]}`)), helps.map(h => h.stdout + h.stderr).join('\n'));
  const bad = board(freshData(), ['queue', 'frobnicate']);
  check('C4 不认识的子命令：退出码 1，只打一行说明，不打堆栈', bad.code === 1 && bad.out.includes('不认识') && !bad.out.includes('    at '), bad.out);
  const small = board(freshData(), ['queue', 'add', '--owner', 'X', '--est', '10m', '--limit', '1m', '--', node('0')]);
  check('C5 --limit 比 --est 小的作业不让排', small.code === 1 && small.out.includes('--limit'), small.out);
}

// ---------- 第二期：作业结束钩子和 events.jsonl（6.2），开跑前的检查 --if（6.3） ----------
const hookDir = freshData();
const hookScript = join(hookDir, 'hook.mjs');
write(hookScript, `import { appendFileSync } from 'node:fs';
appendFileSync(process.argv[2], JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('CSA_JOB_') || k === 'SECRET_PROBE'))) + '\\n');
if (process.argv[3] === 'fail') process.exit(5);
if (process.argv[3] === 'sleep') setTimeout(() => {}, 60000);
`);
const hookCmd = (out, mode = '') => `node "${hookScript}" "${out}"${mode ? ` ${mode}` : ''}`;
const hookLines = out => existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const eventLines = d => existsSync(join(d, 'events.jsonl')) ? readFileSync(join(d, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
{
  const d = freshData();
  const out = join(hookDir, 'q14.txt');
  board(d, ['queue', 'config', '--on-end', hookCmd(out)]);
  board(d, ['queue', 'add', '--owner', 'A', '--session', 'sess-a', '--ticket', '7', '--est', '1s', '--', node('0')]);
  board(d, ['queue', 'add', '--owner', 'B', '--est', '1s', '--', node('process.exit(2)')]);
  await runner(d);
  const lines = hookLines(out);
  const ok = lines.length === 2 && ['A', 'B'].every(owner => {
    const it = item(d, owner), h = lines.find(l => l.CSA_JOB_ID === it.id);
    return h && h.CSA_JOB_STATE === it.state && h.CSA_JOB_RC === String(it.rc) && h.CSA_JOB_OWNER === owner;
  }) && lines.find(l => l.CSA_JOB_OWNER === 'A')?.CSA_JOB_SESSION === 'sess-a' && lines.find(l => l.CSA_JOB_OWNER === 'A')?.CSA_JOB_TICKET === '7';
  check('Q14 结束钩子每个作业跑一次，拿到的 CSA_JOB_ID / STATE / RC 和 queue.json 一致', ok, JSON.stringify(lines));
  const before = eventLines(d).length;
  board(d, ['queue', 'add', '--owner', 'C', '--est', '1s', '--', node('0')]);
  await runner(d);
  const ev = eventLines(d);
  check('Q17 events.jsonl 每个终态一行；排队程序重启后不重写已经写过的（钩子也不重跑）',
    before === 2 && ev.length === 3 && new Set(ev.map(e => e.id)).size === 3 && hookLines(out).length === 3 && ev.every(e => e.state && 'rc' in e && !('stdout' in e)), JSON.stringify(ev));
}
{
  const gap = d => Date.parse(item(d, 'B').start_at) - Date.parse(item(d, 'A').end_at);
  const d1 = freshData();
  board(d1, ['queue', 'config', '--on-end', hookCmd(join(hookDir, 'q15a.txt'), 'fail')]);
  board(d1, ['queue', 'add', '--owner', 'A', '--est', '1s', '--', node('0')]);
  board(d1, ['queue', 'add', '--owner', 'B', '--est', '1s', '--', node('0')]);
  const r1 = await runner(d1);
  const d2 = freshData();
  board(d2, ['queue', 'config', '--on-end', hookCmd(join(hookDir, 'q15b.txt'), 'sleep'), '--on-end-timeout', '2s']);
  board(d2, ['queue', 'add', '--owner', 'A', '--est', '1s', '--', node('0')]);
  board(d2, ['queue', 'add', '--owner', 'B', '--est', '1s', '--', node('0')]);
  const started = Date.now();
  const r2 = await runner(d2);
  check('Q15 钩子退出码非零、或睡 60 秒被时限停掉，下一个作业照常开（不晚于前一个结束后 2 跳）',
    item(d1, 'B').state === 'done' && gap(d1) <= 300 && r1.out.includes('退出码 5')
      && item(d2, 'B').state === 'done' && gap(d2) <= 300 && r2.out.includes('停掉') && Date.now() - started < 30000,
    `${gap(d1)} ${gap(d2)}\n${r1.out}\n${r2.out}`);
}
{
  const d = freshData();
  const out = join(hookDir, 'q16.txt');
  const probe = `probe${Math.random().toString(36).slice(2)}`;
  board(d, ['queue', 'config', '--on-end', hookCmd(out)]);
  board(d, ['queue', 'add', '--owner', 'A', '--est', '1s', '--', node(`console.log('${probe}')`)]);
  await runner(d);
  const text = existsSync(out) ? readFileSync(out, 'utf8') : '';
  check('Q16 钩子的环境里没有作业输出', readFileSync(item(d, 'A').log, 'utf8').includes(probe) && text.includes('CSA_JOB_ID') && !text.includes(probe), text);
}
{
  const d = freshData();
  const skipped = JSON.parse(board(d, ['queue', 'add', '--owner', 'S', '--est', '1s', '--json', '--if', node('process.exit(1)'), '--', node("console.log('should not run')")]).out).id;
  board(d, ['queue', 'add', '--owner', 'N', '--est', '1s', '--', node('0')]);
  board(d, ['queue', 'add', '--owner', 'D', '--est', '1s', '--after', skipped, '--', node('0')]);
  board(d, ['queue', 'add', '--owner', 'T', '--est', '1s', '--if', node('setTimeout(()=>{},60000)'), '--if-timeout', '2s', '--', node('0')]);
  const started = Date.now();
  await runner(d);
  const s = item(d, 'S');
  check('Q18 --if 返回 1 的作业记 skipped（命令没跑），排在后面的作业照开', s.state === 'skipped' && s.reason.includes('rc 1') && !readFileSync(s.log, 'utf8').includes('should not run') && item(d, 'N').state === 'done', JSON.stringify(state(d).items.map(i => [i.owner, i.state, i.reason])));
  check('Q19 --after 一个 skipped 的作业，记 cancelled，原因写明前一项被跳过', item(d, 'D').state === 'cancelled' && item(d, 'D').reason.includes('跳过'), JSON.stringify(item(d, 'D')));
  const p = board(d, ['patrol', '--json', '--ack-after', '0']);
  const t = item(d, 'T');
  check('Q20 --if 超过时限被停，记 skipped、原因写超时；csa patrol 不把 skipped 当 finished-unacked',
    t.state === 'skipped' && t.reason.includes('超时') && Date.now() - started < 30000
      && !JSON.parse(p.out).anomalies.some(a => a.code === 'finished-unacked' && (a.item === t.id || a.item === s.id)), `${JSON.stringify(t)}\n${p.out}`);
}

// ---------- P1-3：时间窗的钟点；P1-4：急停和恢复 ----------
{
  const d = freshData();
  const hhmm = t => { const x = new Date(t); return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; };
  const r = board(d, ['queue', 'curfew', '--no-start-after', hhmm(Date.now() - 2 * 60_000)]);
  const c = state(d).curfew;
  check('Q21 刚过去的钟点按「现在」算，打一行提示', r.code === 0 && Math.abs(Date.parse(c.no_start_after) - Date.now()) < 10_000 && r.out.includes('刚过去'), r.out);
  const n = board(d, ['queue', 'curfew', '--kill-at', 'now']);
  check('Q22 now 写法：时刻就是现在', n.code === 0 && Math.abs(Date.parse(state(d).curfew.kill_at) - Date.now()) < 10_000, n.out);
  const bad = board(d, ['queue', 'curfew', '--no-start-after', '+10m', '--kill-at', '+5m']);
  check('Q23 --kill-at 早于 --no-start-after：报错，退出码 1，原来的时间窗不变', bad.code === 1 && bad.out.includes('早于') && Math.abs(Date.parse(state(d).curfew.kill_at) - Date.now()) < 60_000, bad.out);
  board(d, ['queue', 'curfew', '--kill-at', '2099-01-02T03:04:00']);
  const view = readFileSync(join(d, 'queue.md'), 'utf8');
  check('Q24 不是今天的时刻，排队页带日期', view.includes('01-02 03:04:00'), view);
}
{
  const d = freshData();
  board(d, ['queue', 'add', '--owner', 'A', '--est', '30s', '--', node('setTimeout(()=>{},60000)')]);
  board(d, ['queue', 'add', '--owner', 'B', '--est', '1s', '--', node('0')]);
  const run = runner(d);
  for (let i = 0; i < 80 && item(d, 'A').state !== 'running'; i++) await new Promise(r => setTimeout(r, 100));
  const pz = board(d, ['queue', 'pause', '--note', '电脑要离线']);
  const started = Date.now();
  const res = await run;
  check('Q25 急停：在跑的被停掉（killed，原因 pause），排着的不开，排队程序自己退出',
    pz.code === 0 && item(d, 'A').state === 'killed' && item(d, 'A').reason === 'pause' && item(d, 'B').state === 'queued' && Date.now() - started < 20000 && readFileSync(join(d, 'queue.md'), 'utf8').includes('急停中'), `${pz.out}\n${res.out}`);
  const p = board(d, ['patrol', '--json', '--ack-after', '60']);
  const pj = JSON.parse(p.out);
  check('Q26 急停中 patrol 不报 runner-down、pc-idle，只记一行说明', p.code === 0 && pj.info.some(i => i.includes('急停中')) && pj.queue.paused === true, p.out);
  const rs = board(d, ['queue', 'resume']);
  await runner(d);
  check('Q27 resume 以后排着的照常跑；被急停停掉的不自动重排', rs.code === 0 && rs.out.includes('急停已解除') && item(d, 'B').state === 'done' && item(d, 'A').state === 'killed', rs.out);
}

// ---------- Codex 审查后修的：检查过了要重新看准入、接手遗留进程、事件去重、钩子并发、钟点 ----------
const waitFor = async (pred, ms = 8000) => { for (let t = 0; t < ms / 100 && !pred(); t++) await new Promise(r => setTimeout(r, 100)); return pred(); };
{
  const d = freshData();
  // 检查自己设上急停然后退出 0；排队程序 3 秒一跳，检查在两跳之间跑完：下一跳看到的一定是「检查已经退出 0、急停已经在了」
  board(d, ['queue', 'add', '--owner', 'A', '--est', '1s', '--if', `node "${csa}" queue pause --note 测试`, '--', node("console.log('JOB RAN')")]);
  await runner(d, ['--tick', '3000']);
  const a = item(d, 'A');
  check('Q28 检查过了的那一刻已经急停：作业不开，留在排队里', a.state === 'queued' && !a.start_at && !readFileSync(a.log, 'utf8').includes('JOB RAN'), JSON.stringify(a));
}
{
  const d = freshData();
  board(d, ['queue', 'add', '--owner', 'A', '--est', '1s', '--if', node('setTimeout(()=>{},2500)'), '--', node("console.log('JOB RAN')")]);
  const run = runner(d);
  await waitFor(() => item(d, 'A').checking_at);
  board(d, ['queue', 'curfew', '--no-start-after', 'now']);
  await run;
  const a = item(d, 'A');
  check('Q29 检查跑着的时候时间窗到点：检查过了也不开，作业留在排队里', a.state === 'queued' && !a.start_at && (!existsSync(a.log) || !readFileSync(a.log, 'utf8').includes('JOB RAN')), JSON.stringify(a));
}
{
  const d = freshData();
  const orphan = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { detached: process.platform !== 'win32', stdio: 'ignore' });
  const now = new Date().toISOString();
  write(join(d, 'queue.json'), JSON.stringify({ version: 1, curfew: null, items: [{ id: 'orph', owner: 'O', cmd: 'x', cwd: repo, est_s: 60, limit_s: 600, state: 'running', enq_at: now, start_at: now, pid: orphan.pid, log: join(d, 'logs', 'orph.log') }] }));
  board(d, ['queue', 'pause']);
  const exited = new Promise(r => orphan.on('exit', () => r(true)));
  await runner(d);
  const o = item(d, 'O');
  check('Q30 接手上一个排队程序留下的作业：急停照样停掉，记 killed、原因 pause', o.state === 'killed' && o.reason === 'pause' && await Promise.race([exited, new Promise(r => setTimeout(() => r(false), 8000))]), JSON.stringify(o));
}
{
  const d = freshData();
  const out = join(hookDir, 'q31.txt');
  const now = new Date().toISOString();
  const old = { id: 'old1', owner: 'O', cmd: 'x', cwd: repo, est_s: 1, limit_s: 600, state: 'done', rc: 0, enq_at: now, start_at: now, end_at: now, log: join(d, 'logs', 'old1.log') };
  write(join(d, 'queue.json'), JSON.stringify({ version: 1, curfew: null, items: [old] }));
  write(join(d, 'events.jsonl'), JSON.stringify({ event_id: 'old1:done', id: 'old1', state: 'done' }) + '\n');
  write(join(d, 'config.json'), JSON.stringify({ on_end: hookCmd(out) }));
  await runner(d);
  check('Q31 events.jsonl 里已经有的事件（写进去了、状态没落盘就崩了）：不重写，钩子不重跑', eventLines(d).length === 1 && !existsSync(out) && item(d, 'O').evented_at, JSON.stringify(eventLines(d)));
}
{
  const d = freshData();
  const out = join(hookDir, 'q32.txt');
  const now = new Date().toISOString();
  write(join(d, 'queue.json'), JSON.stringify({ version: 1, curfew: null, items: [{ id: 'old2', owner: 'O', cmd: 'x', cwd: repo, est_s: 1, limit_s: 600, state: 'done', rc: 0, enq_at: now, start_at: now, end_at: now, log: join(d, 'logs', 'old2.log') }] }));
  const c = board(d, ['queue', 'config', '--on-end', hookCmd(out)]);
  await runner(d);
  check('Q32 第一次配结束钩子：之前就结束的作业不补写事件、不补跑钩子', c.out.includes('不补写') && !existsSync(out) && eventLines(d).length === 0, c.out);
}
{
  const d = freshData();
  board(d, ['queue', 'add', '--owner', 'S', '--est', '1s', '--if', node("console.log('CHECKPROBE');process.exit(1)"), '--', node('0')]);
  await runner(d);
  const it = item(d, 'S');
  check('Q33 检查没过：原因只写 rc，不带检查的输出；事件里也没有；输出在作业日志里',
    it.state === 'skipped' && !it.reason.includes('CHECKPROBE') && !JSON.stringify(eventLines(d)).includes('CHECKPROBE') && readFileSync(it.log, 'utf8').includes('CHECKPROBE'), JSON.stringify(it));
}
{
  const d = freshData();
  const out = join(hookDir, 'q34.txt');
  const slow = join(hookDir, 'slow.mjs');
  write(slow, `import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], 'start ' + Date.now() + '\\n');\nsetTimeout(() => appendFileSync(process.argv[2], 'end ' + Date.now() + '\\n'), 1500);\n`);
  board(d, ['queue', 'config', '--on-end', `node "${slow}" "${out}"`, '--on-end-timeout', '20s']);
  for (const o of ['A', 'B', 'C', 'D']) board(d, ['queue', 'add', '--owner', o, '--est', '1s', '--', node('0')]);
  await runner(d);
  const marks = readFileSync(out, 'utf8').trim().split('\n').map(l => l.split(' ')).map(([k, t]) => [k, Number(t)]).sort((x, y) => x[1] - y[1]);
  let live = 0, peak = 0;
  for (const [k] of marks) { live += k === 'start' ? 1 : -1; peak = Math.max(peak, live); }
  check('Q34 结束钩子最多同时跑 2 个，4 个都跑完', marks.filter(m => m[0] === 'end').length === 4 && peak <= 2, JSON.stringify(marks));
}
{
  const probe = `import('${pathToFileURL(join(repo, 'src', 'common.ts')).href}').then(m => { const r = m.nextClock('04:00', new Date(2026, 2, 7, 12, 0)); console.log(JSON.stringify({ h: r.at.getHours(), d: r.at.getDate(), j: r.justPassed })); })`;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', probe], { cwd: repo, encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' } });
  const v = JSON.parse(r.stdout.trim() || '{}');
  check('Q35 跨夏令时那一天：钟点按本地日历算（纽约 3 月 7 日中午写 04:00 → 3 月 8 日 04:00，不是 05:00）', v.h === 4 && v.d === 8 && v.j === false, `${r.stdout}${r.stderr}`);
}

// ---------- Codex 第二轮复审后修的：要停的遗留进程重试强停、旧检查退出前不重检、事件文件的半行 ----------
{
  const d = freshData();
  const stubborn = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setTimeout(()=>{},60000)"], { detached: process.platform !== 'win32', stdio: 'ignore' });
  const exited = new Promise(r => stubborn.on('exit', () => r(true)));
  await new Promise(r => setTimeout(r, 300));
  const t = new Date().toISOString(), long = new Date(Date.now() - 60_000).toISOString();
  write(join(d, 'queue.json'), JSON.stringify({ version: 1, curfew: null, paused: { at: t }, items: [{ id: 'stub', owner: 'O', cmd: 'x', cwd: repo, est_s: 60, limit_s: 600, state: 'running', enq_at: t, start_at: t, pid: stubborn.pid, log: join(d, 'logs', 'stub.log'), kill_sent: 'pause', kill_sent_at: long }] }));
  const r36 = await runner(d);
  const o = item(d, 'O');
  check('Q36 接手的作业「要停过了」还活着（不理 TERM）：强制再停一次，记 killed、原因 pause',
    o.state === 'killed' && o.reason === 'pause' && r36.out.includes('强制停') && await Promise.race([exited, new Promise(r => setTimeout(() => r(false), 5000))]), `${JSON.stringify(o)}\n${r36.out}`);
  try { process.kill(stubborn.pid, 'SIGKILL'); } catch { /* 已经停了 */ }
}
{
  const d = freshData();
  const mark = join(hookDir, 'q37.txt');
  // 不理 TERM 的旧检查：第一次停不掉，得等强制停
  const sleeper = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setTimeout(()=>{},60000)"], { detached: process.platform !== 'win32', stdio: 'ignore' });
  let sleeperGone = 0;
  sleeper.on('exit', () => { sleeperGone = Date.now(); });
  await new Promise(r => setTimeout(r, 300));
  const t = new Date().toISOString();
  write(join(d, 'queue.json'), JSON.stringify({ version: 1, curfew: null, items: [{ id: 'chk', owner: 'C', cmd: node('0'), cwd: repo, est_s: 1, limit_s: 600, state: 'queued', enq_at: t, log: join(d, 'logs', 'chk.log'), if_cmd: node("require('fs').writeFileSync(process.env.Q37_MARK, String(Date.now()))"), if_timeout_s: 30, checking_at: t, checking_pid: sleeper.pid }] }));
  const r37 = await runner(d, [], { Q37_MARK: mark });
  const started = existsSync(mark) ? Number(readFileSync(mark, 'utf8')) : 0;
  check('Q37 上一个排队程序留下的检查还活着（不理 TERM）：先停、再强制停，等它退出以后才重新检查',
    sleeperGone > 0 && started >= sleeperGone && item(d, 'C').state === 'done' && r37.out.includes('留下的检查'), JSON.stringify({ sleeperGone, started, st: item(d, 'C').state, out: r37.out }));
  try { process.kill(sleeper.pid, 'SIGKILL'); } catch { /* 已经停了 */ }
}
{
  const d = freshData();
  const t = new Date().toISOString();
  write(join(d, 'queue.json'), JSON.stringify({ version: 1, curfew: null, items: [{ id: 'new1', owner: 'N', cmd: 'x', cwd: repo, est_s: 1, limit_s: 600, state: 'done', rc: 0, enq_at: t, start_at: t, end_at: t, log: join(d, 'logs', 'new1.log') }] }));
  writeFileSync(join(d, 'events.jsonl'), JSON.stringify({ event_id: 'a:done', id: 'a', state: 'done' }) + '\n{"event_id":"b:do');
  await runner(d);
  const good = readFileSync(join(d, 'events.jsonl'), 'utf8').split('\n').filter(l => { try { JSON.parse(l); return true; } catch { return false; } }).map(l => JSON.parse(l).event_id);
  check('Q38 events.jsonl 最后一行没写完：新事件另起一行，不被吞掉', good.includes('a:done') && good.includes('new1:done'), JSON.stringify(good));
}

console.log(failed ? `\n${failed} 项没过` : '\n全部通过');
process.exit(failed ? 1 : 0);
