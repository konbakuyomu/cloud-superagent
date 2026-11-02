// 四个命令共用的小件：数据目录、原子写 JSON、目录锁、时长解析、子进程和进程树、简易 glob、路径规范化。
// 约定见 docs/cli.md。
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

export const isWin = process.platform === 'win32';
export const gitExe = process.env.CSA_GIT || 'git';

export function git(cwd: string, args: string[]) {
  const result = spawnSync(gitExe, ['--no-optional-locks', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  return { ok: result.status === 0, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

/**
 * 排队、日志、配置所在目录。优先级：命令行 --data-dir（入口把它写进 CSA_DATA_DIR）> 环境变量 CSA_DATA_DIR >
 * 平台的通用状态目录（Windows：%LOCALAPPDATA%\\cloud-superagent；其他：$XDG_STATE_HOME/cloud-superagent，缺省 ~/.local/state/cloud-superagent）。
 */
export function defaultDataDir() {
  if (isWin) return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'cloud-superagent');
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'cloud-superagent');
}
export function dataDir() {
  const dir = resolve(process.env.CSA_DATA_DIR || defaultDataDir());
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 把路径规范成真实的长路径（Windows 的 8.3 短名、符号链接都展开）；不存在的路径只做 resolve。 */
export function canonical(path: string) {
  const abs = resolve(path);
  try { return realpathSync.native(abs); } catch { return abs; }
}

/** child 在 parent 里面（或就是 parent）时返回相对路径（用 /），否则 null。Windows 上不分大小写。 */
export function inside(parent: string, child: string) {
  const rel = relative(isWin ? canonical(parent).toLowerCase() : canonical(parent), isWin ? canonical(child).toLowerCase() : canonical(child));
  if (rel.startsWith('..') || /^[a-zA-Z]:/.test(rel) || rel.startsWith('/')) return null;
  return relative(canonical(parent), canonical(child)).replace(/\\/g, '/');
}

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return text.trim() ? JSON.parse(text) as T : fallback;
}

/** 先写临时文件再改名，读的人不会读到半个文件。 */
export function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameRetry(tmp, file);
}

/** Windows 上别的进程正好在读目标文件时，改名会报 EPERM / EBUSY / EACCES：等一下再试。 */
function renameRetry(from: string, to: string) {
  for (let n = 0; ; n++) {
    try { renameSync(from, to); return; } catch (error: any) {
      if (n >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      sleepSync(25);
    }
  }
}

export function writeText(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameRetry(tmp, file);
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
export const sleepSync = (ms: number) => Atomics.wait(sleepBuffer, 0, 0, ms);

/** 用 mkdir 当锁（Windows 和 Linux 都是原子的）；锁目录超过 30 秒没放就当作上一个持有者已经死了。 */
export function withLock<T>(name: string, fn: () => T): T {
  const lock = join(dataDir(), `${name}.lock`);
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) { rmdirSync(lock); continue; }
      } catch { /* 别人刚放掉，再试 */ }
      if (Date.now() > deadline) throw new Error(`等锁超时：${lock}`);
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    try { rmdirSync(lock); } catch { /* 已被当作过期锁清掉 */ }
  }
}

/** 12m、1h30m、900s、90（秒）→ 秒。 */
export function parseDuration(text: string | undefined, fallback?: number): number {
  if (text === undefined || text === '') {
    if (fallback === undefined) throw new Error('缺少时长');
    return fallback;
  }
  if (/^\d+$/.test(text)) return Number(text);
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text.trim());
  if (!match || !match.slice(1).some(Boolean)) throw new Error(`时长写法不认识：${text}（例：12m、1h30m、900s）`);
  const [, h, m, s] = match.map(v => Number(v ?? 0));
  return h * 3600 + m * 60 + s;
}

export function formatDuration(seconds: number) {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** 本地时间 HH:mm:ss（执行机的钟）。 */
export const clock = (iso: string | number | Date | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString('en-GB', { hour12: false }) : '—';

/** 今天或明天的 HH:mm（本地时间）；已经过了的钟点算明天，除非 allowPast。 */
export function nextClock(hhmm: string, now = new Date(), allowPast = false) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) throw new Error(`钟点写法不认识：${hhmm}（例：06:45）`);
  const at = new Date(now);
  at.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (!allowPast && at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

export function sha256(text: string) {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}

export function pidAlive(pid: number | null | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error.code === 'EPERM';
  }
}

/** 照平台起一个 shell 跑整行命令：Windows 用 pwsh（没有就用 Windows PowerShell），其他用 bash。 */
export function shellArgs(command: string, shell?: string) {
  if (shell === 'cmd') return { file: 'cmd.exe', args: ['/d', '/s', '/c', command] };
  if (shell === 'bash' || (!shell && !isWin)) return { file: 'bash', args: ['-c', command] };
  const exe = shell === 'powershell' ? 'powershell.exe' : (shell ?? (hasPwsh() ? 'pwsh' : 'powershell.exe'));
  return { file: exe, args: ['-NoProfile', '-NonInteractive', '-Command', `${command}\n${PS_EXIT}`] };
}

/**
 * PowerShell 的 -Command 会把外部程序 0、1 以外的退出码都报成 1（about_Pwsh：To preserve the specific exit code, add exit
 * $LASTEXITCODE）。接在命令后面（另起一行，命令末尾的注释不会把它吃掉），把最后一条命令的结果原样带出来：成功 0；
 * 外部程序失败带它自己的退出码；cmdlet 出错 1。命令里自己写了 exit 的，在这之前就退了。
 */
const PS_EXIT = 'if ($?) { exit 0 } elseif ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 }';

/** `--` 后面给了好几个参数时，照目标 shell 的规矩逐个加引号再拼成一行；只给一个参数就当作整行命令原样用。 */
export function joinCommand(args: string[], shell?: string) {
  if (args.length <= 1) return args[0] ?? '';
  const posix = shell === 'bash' || (!shell && !isWin);
  const plain = /^[\w@%+=:,./\\-]+$/;
  return args.map(arg => {
    if (arg && plain.test(arg)) return arg;
    if (shell === 'cmd') return `"${arg.replace(/"/g, '""')}"`;
    return posix ? `'${arg.replace(/'/g, `'\\''`)}'` : `'${arg.replace(/'/g, "''")}'`;
  }).join(' ');
}

let pwshCache: boolean | undefined;
function hasPwsh() {
  if (pwshCache === undefined) pwshCache = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status === 0;
  return pwshCache;
}

/** 起子进程，输出接到日志文件。POSIX 下单独成组，好整组停掉。 */
export function startLogged(command: string, cwd: string, log: string, shell?: string, env?: Record<string, string>): ChildProcess {
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, 'a');
  const { file, args } = shellArgs(command, shell);
  const child = spawn(file, args, { cwd, stdio: ['ignore', fd, fd], windowsHide: true, detached: !isWin, ...(env ? { env: { ...process.env, ...env } } : {}) });
  closeSync(fd);
  return child;
}

/** 停掉整棵进程树：Windows 用 taskkill /T /F；POSIX 先 TERM 整组，5 秒后还在就 KILL（不阻塞，好让事件循环收子进程）。 */
export function killTree(pid: number) {
  if (isWin) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  const signal = (sig: NodeJS.Signals) => { try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* 已经结束 */ } } };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), 5000);
}

/** 同步跑一条命令到结束，带超时；返回退出码和输出。 */
export function runCaptured(command: string, cwd: string, timeoutSeconds: number, shell?: string) {
  const { file, args } = shellArgs(command, shell);
  const started = Date.now();
  const result = spawnSync(file, args, { cwd, encoding: 'utf8', timeout: timeoutSeconds * 1000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return {
    code: result.status,
    timedOut: result.error ? (result.error as any).code === 'ETIMEDOUT' : false,
    error: result.error && (result.error as any).code !== 'ETIMEDOUT' ? String(result.error.message) : null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}

/** 简易 glob：** 跨目录，* 和 ? 不跨 /；大小写不敏感（Windows 路径）。 */
export function globToRegExp(glob: string) {
  let re = '';
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

export const matchesAny = (path: string, globs: string[]) =>
  globs.some(glob => globToRegExp(glob).test(path.replace(/\\/g, '/')));

/** 抛给命令行入口统一打印、退出码 1；不在这里 process.exit，免得锁目录留在原地。 */
export class CliError extends Error {}
export function fail(message: string): never {
  throw new CliError(message);
}
