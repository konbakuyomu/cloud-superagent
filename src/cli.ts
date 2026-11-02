// csa queue / ticket / gate / patrol 的命令行入口。bin/csa.mjs 和四个单独的 bin/csa-<命令>.mjs 都转到这里。
import { parseArgs } from 'node:util';
import { CliError, fail, joinCommand, parseDuration } from './common.ts';
import { gate } from './gate.ts';
import { patrol, patrolText } from './patrol.ts';
import { ack, add, cancel, loadConfig, logTail, renderView, loadState, RUNNER_HINT, runLoop, saveConfig, setCurfew, status } from './queue.ts';
import { amend, dispatch, init, loadLedger, resolveLineDir, setStatus, show, showText, STATUS_TEXT } from './ticket.ts';

export const USAGE = [
  '  csa queue add --owner <会话> --est 12m [--limit 40m] [--ticket 50] [--session <id>] [--note "<说明>"] [--after <作业 id>] [--cwd <目录>] [--if "<开跑前的检查>" [--if-timeout 60s]] -- "<整行命令>"',
  '  csa queue list | status [--json] | log <作业 id> [--lines 40] | ack <作业 id> [--by <会话>] | cancel <作业 id>',
  '  csa queue curfew --no-start-after 06:45 --kill-at 06:50 [--note "<出处>"] | --clear',
  '  csa queue run [--idle-exit 120]     排队程序本体，用执行机守护进程的后台作业开（例：winhand job_start）',
  '  csa queue config [--add-view <路径>] [--remove-view <路径>] [--shell pwsh|powershell|cmd|bash] [--on-end "<结束钩子>" [--on-end-timeout 30s] | --clear-on-end]',
  '  csa ticket init --dir <线的目录> [--auth-file CLAUDE.md --auth-heading "## 授权"]',
  '  csa ticket dispatch <票> --owner <会话> [--session <id>] [--prepare] | set <票> <状态> [--note] | amend <票> --reason "<理由>" | show <票> [--json] | list [--json]   （都可加 --dir 或 --line）',
  '  csa gate <票> [--dir <线的目录> | --line <id>] [--out <目录>] [--json]',
  '  csa patrol [--json] [--ack-after 10] [--accept-after 15]   OK 退出码 0，有事退出码 3',
];

const print = (value: unknown, json: boolean | undefined, text: () => string) => console.log(json ? JSON.stringify(value, null, 2) : text());

const HELP: Record<string, number[]> = { queue: [0, 1, 2, 3, 4], ticket: [5, 6], gate: [7], patrol: [8] };

/** 去掉全局的 --data-dir <目录>（或 --data-dir=<目录>），写进 CSA_DATA_DIR，后面各命令都从那里取。 */
export function takeDataDir(argv: string[]) {
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { rest.push(...argv.slice(i)); break; }
    if (arg === '--data-dir') { process.env.CSA_DATA_DIR = argv[++i] ?? fail('--data-dir 后面要跟目录'); continue; }
    if (arg.startsWith('--data-dir=')) { process.env.CSA_DATA_DIR = arg.slice('--data-dir='.length); continue; }
    rest.push(arg);
  }
  return rest;
}

export async function main(command: string | undefined, rawArgv: string[]): Promise<number> {
  try {
    const argv = takeDataDir(rawArgv);
    if (!command || command === '--help' || command === '-h' || command === 'help') {
      console.log(['用法（全局选项 --data-dir <目录>，或环境变量 CSA_DATA_DIR）：', ...USAGE].join('\n'));
      return command ? 0 : 1;
    }
    const own = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
    if (own.includes('--help') || own.includes('-h')) {
      if (!HELP[command]) return fail(`不认识的命令：${command}`);
      console.log(HELP[command].map(i => USAGE[i]).join('\n'));
      return 0;
    }
    if (command === 'queue') return await queueCli(argv);
    if (command === 'ticket') return ticketCli(argv);
    if (command === 'gate') return gateCli(argv);
    if (command === 'patrol') return patrolCli(argv);
    return fail(`不认识的命令：${command}`);
  } catch (error: any) {
    if (!(error instanceof CliError) && error?.code !== 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && error?.code !== 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') throw error;
    console.error(error.message);
    return 1;
  }
}

async function queueCli(argv: string[]) {
  const { values: o, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      owner: { type: 'string' }, session: { type: 'string' }, ticket: { type: 'string' }, note: { type: 'string' },
      est: { type: 'string' }, limit: { type: 'string' }, after: { type: 'string' }, cwd: { type: 'string' }, shell: { type: 'string' },
      cmd: { type: 'string' }, json: { type: 'boolean' }, 'idle-exit': { type: 'string' }, tick: { type: 'string' },
      'no-start-after': { type: 'string' }, 'kill-at': { type: 'string' }, clear: { type: 'boolean' }, by: { type: 'string' },
      lines: { type: 'string' }, 'add-view': { type: 'string' }, 'remove-view': { type: 'string' },
      if: { type: 'string' }, 'if-timeout': { type: 'string' }, 'on-end': { type: 'string' }, 'on-end-timeout': { type: 'string' }, 'clear-on-end': { type: 'boolean' },
    },
  });
  const [action, ...rest] = positionals;
  if (action === 'add') {
    const shell = o.shell ?? loadConfig().shell;
    const r = add({ owner: o.owner!, session: o.session, ticket: o.ticket, note: o.note, est: o.est!, limit: o.limit, after: o.after, cwd: o.cwd, shell, cmd: o.cmd ?? joinCommand(rest, shell), if: o.if, ifTimeout: o['if-timeout'] });
    print(r, o.json, () => [
      `排上了 ${r.id}：排队第 ${r.position} 位${r.running ? '（前面有作业在跑）' : ''}，日志 ${r.log}`,
      r.runner_alive ? '排队程序在跑，轮到就自动开' : RUNNER_HINT,
      '跑完以后取结果，再运行 csa queue ack <作业 id>；估时到了先回来看一次（send_later 定在估计跑完的时刻）',
    ].join('\n'));
    return 0;
  }
  if (action === 'list' || action === undefined) { print(loadState(), o.json, () => renderView(loadState())); return 0; }
  if (action === 'status') { const s = status(); print(s, o.json, () => renderView(loadState())); return 0; }
  if (action === 'log') { console.log(logTail(rest[0] ?? fail('要作业 id'), Number(o.lines ?? 40))); return 0; }
  if (action === 'ack') { const item = ack(rest[0] ?? fail('要作业 id'), o.by); console.log(`${item.id} 记为已取`); return 0; }
  if (action === 'cancel') { console.log(cancel(rest[0] ?? fail('要作业 id'))); return 0; }
  if (action === 'curfew') {
    const c = setCurfew({ noStartAfter: o['no-start-after'], killAt: o['kill-at'], note: o.note, clear: o.clear });
    console.log(c ? `时间窗：${c.no_start_after ? `${new Date(c.no_start_after).toLocaleString('sv-SE')} 以后不开新作业；` : ''}${c.kill_at ? `${new Date(c.kill_at).toLocaleString('sv-SE')} 停掉还在跑的` : ''}` : `时间窗已解除。排着的作业要开，先确认排队程序在跑：${RUNNER_HINT}`);
    return 0;
  }
  if (action === 'run') return runLoop(Number(o['idle-exit'] ?? loadConfig().idle_exit_s ?? 120), Number(o.tick ?? 2000));
  if (action === 'config') {
    const config = loadConfig();
    if (o['add-view']) config.views = [...new Set([...(config.views ?? []), o['add-view']])];
    if (o['remove-view']) config.views = (config.views ?? []).filter(v => v !== o['remove-view']);
    if (o.shell) config.shell = o.shell;
    if (o['on-end']) config.on_end = o['on-end'];
    if (o['on-end-timeout']) config.on_end_timeout_s = parseDuration(o['on-end-timeout']);
    if (o['clear-on-end']) { delete config.on_end; delete config.on_end_timeout_s; }
    saveConfig(config);
    console.log(JSON.stringify(config, null, 2));
    return 0;
  }
  return fail(`csa queue 不认识「${action}」\n${USAGE.slice(0, 5).join('\n')}`);
}

function ticketCli(argv: string[]) {
  const { values: o, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      dir: { type: 'string' }, line: { type: 'string' }, owner: { type: 'string' }, session: { type: 'string' }, note: { type: 'string' },
      reason: { type: 'string' }, json: { type: 'boolean' }, prepare: { type: 'boolean' }, id: { type: 'string' }, 'auth-file': { type: 'string' }, 'auth-heading': { type: 'string' },
    },
  });
  const [action, id, value] = positionals;
  if (action === 'init') {
    const line = init({ dir: o.dir ?? process.cwd(), id: o.id, authFile: o['auth-file'], authHeading: o['auth-heading'] });
    console.log(`登记了线 ${line.id}：${line.dir}${line.auth ? `；授权一节 ${line.auth.file}「${line.auth.heading}」哈希 ${line.auth.sha256.slice(0, 12)}` : ''}`);
    return 0;
  }
  const lineDir = resolveLineDir(o);
  const need = () => id ?? fail('要票号');
  if (action === 'dispatch') {
    const e = dispatch(lineDir, need(), { owner: o.owner, session: o.session, note: o.note, prepare: o.prepare });
    console.log(`票 ${e.ticket} 已派给 ${e.owner ?? '?'}，判法哈希 ${e.contract_sha.slice(0, 12)}${Object.keys(e.heads).length ? `，记下了 ${Object.keys(e.heads).join('、')} 的当前提交` : ''}${e.prepared ? `；worktree：${Object.entries(e.prepared).map(([k, v]) => `${k} ${v}`).join('、')}` : ''}`);
    return 0;
  }
  if (action === 'set') { const e = setStatus(lineDir, need(), value ?? fail('要状态'), o.note); console.log(`票 ${e.ticket}：${STATUS_TEXT[e.status]}`); return 0; }
  if (action === 'accept') { const e = setStatus(lineDir, need(), 'accepted', o.note); console.log(`票 ${e.ticket}：${STATUS_TEXT[e.status]}`); return 0; }
  if (action === 'amend') { const e = amend(lineDir, need(), o.reason!); console.log(`票 ${e.ticket} 的判法改了，新哈希 ${e.contract_sha.slice(0, 12)}`); return 0; }
  if (action === 'show') {
    const card = show(lineDir, need(), loadState().items);
    print(card, o.json, () => showText(card));
    return 0;
  }
  if (action === 'list' || action === undefined) {
    const ledger = loadLedger(lineDir);
    const entries = Object.values(ledger.tickets);
    print(ledger, o.json, () => entries.map(e => `- 票 ${e.ticket}：${STATUS_TEXT[e.status]}，${e.owner ?? '?'}${e.gate ? `，gate ${e.gate.verdict}` : ''}，更新 ${new Date(e.updated_at).toLocaleString('sv-SE')}`).join('\n') || '（台账是空的）');
    return 0;
  }
  return fail(`csa ticket 不认识「${action}」\n${USAGE.slice(5, 7).join('\n')}`);
}

function gateCli(argv: string[]) {
  const { values: o, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { dir: { type: 'string' }, line: { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' }, 'no-ledger': { type: 'boolean' }, shell: { type: 'string' } },
  });
  const id = positionals[0] ?? fail(`要票号\n${USAGE[7]}`);
  const r = gate(resolveLineDir(o), id, { out: o.out, noLedger: o['no-ledger'], shell: o.shell });
  print(r, o.json, () => [
    `票 ${id} gate：${{ pass: '过', 'pending-human': '自动项都过，还有要总调度判的', fail: '不过' }[r.verdict]}（${r.out}）`,
    ...r.checks.map(c => `  ${c.kind === 'human' ? '人判' : c.ok ? '过' : '不过'}　${c.id}：${c.why}`),
    ...r.findings.map(f => `  ! ${f.code}：${f.message}`),
    ...r.notes.map(n => `  · ${n}`),
  ].join('\n'));
  return r.verdict === 'fail' ? 1 : 0;
}

function patrolCli(argv: string[]) {
  const { values: o } = parseArgs({
    args: argv, allowPositionals: false,
    options: { json: { type: 'boolean' }, 'ack-after': { type: 'string' }, 'accept-after': { type: 'string' }, 'idle-after': { type: 'string' } },
  });
  const r = patrol({ ackAfterMin: o['ack-after'] ? Number(o['ack-after']) : undefined, acceptAfterMin: o['accept-after'] ? Number(o['accept-after']) : undefined, idleAfterSec: o['idle-after'] ? Number(o['idle-after']) : undefined });
  print(r, o.json, () => patrolText(r));
  return r.ok ? 0 : 3;
}
