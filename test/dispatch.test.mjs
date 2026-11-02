#!/usr/bin/env node
// 四个命令的场景测试：csa queue（顺序、上限、依赖、时间窗、取消、单例、排队页）、csa patrol、csa ticket（判法锁）、
// csa gate（检查、范围、禁区、人判、分支），加命令行本身（数据目录、--help、错误）。每个场景用自己的临时数据目录和临时仓库。
// Q/P/T/G 共 34 项照搬自原来的私有任务仓库的调度测试，只把 board 换成 csa、改成不经 shell 起子进程；C1–C5 是这个仓库加的。
// `npm test` 会跑；Linux、macOS、Windows 都能跑，只要有 node 和 git。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  child.on('exit', code => done({ code, out }));
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
  spawnSync('git', ['clean', '-fdq'], { cwd: codeRepo });

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

console.log(failed ? `\n${failed} 项没过` : '\n全部通过');
process.exit(failed ? 1 : 0);
