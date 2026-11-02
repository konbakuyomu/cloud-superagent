// csa patrol：巡检的第一层，纯代码，只回答「有没有事」。没事输出一行 OK；有事列出异常，交给看门狗会话判断。
// 约定见 docs/cli.md。
import { existsSync } from 'node:fs';
import { clock, formatDuration } from './common.ts';
import { heldByCurfew, isPaused, loadConfig, loadState, pickNext, runnerInfo, RUNNER_HINT, TERMINAL } from './queue.ts';
import { contractChanged, loadLedger, sectionSha, STATUS_TEXT } from './ticket.ts';

export interface Anomaly { code: string; message: string; owner?: string; session?: string; ticket?: string; item?: string; line?: string; action?: string }

export function patrol(opts: { ackAfterMin?: number; acceptAfterMin?: number; idleAfterSec?: number } = {}) {
  const now = Date.now();
  const ackAfter = (opts.ackAfterMin ?? 10) * 60_000;
  const acceptAfter = (opts.acceptAfterMin ?? 15) * 60_000;
  const idleAfter = (opts.idleAfterSec ?? 60) * 1000;
  const state = loadState();
  const runner = runnerInfo();
  const anomalies: Anomaly[] = [];
  const info: string[] = [];
  const running = state.items.filter(i => i.state === 'running');
  const queued = state.items.filter(i => i.state === 'queued');
  const paused = isPaused(state);
  const held = heldByCurfew(state, now) || paused;
  if (paused) info.push(`急停中（${clock(state.paused!.at)} 起${state.paused!.note ? `，${state.paused!.note}` : ''}），${queued.length} 项排着等 csa queue resume`);

  if (heldByCurfew(state, now) && queued.length) info.push(`时间窗已到点，${queued.length} 项排着等 csa queue curfew --clear`);
  if (queued.length && !runner.alive && !held) {
    anomalies.push({ code: 'runner-down', message: `排队里有 ${queued.length} 项，排队程序没在跑`, action: RUNNER_HINT });
  }
  if (runner.alive && !running.length && !held) {
    const next = pickNext(structuredClone(state), now);
    const lastEnd = Math.max(0, ...state.items.map(i => Date.parse(i.end_at ?? i.enq_at)));
    if (next && now - lastEnd > idleAfter) {
      anomalies.push({ code: 'pc-idle', message: `执行机空着，排队里 ${next.id} 能开却没开（${formatDuration((now - lastEnd) / 1000)}）`, item: next.id, owner: next.owner, session: next.session });
    }
  }
  for (const item of running) {
    const elapsed = (now - Date.parse(item.start_at!)) / 1000;
    if (elapsed > item.est_s * 1.5) {
      anomalies.push({ code: 'over-estimate', message: `${item.id} 跑了 ${formatDuration(elapsed)}，估时 ${formatDuration(item.est_s)}，上限 ${formatDuration(item.limit_s)}`, item: item.id, owner: item.owner, session: item.session, ticket: item.ticket });
    }
  }
  for (const item of state.items) {
    if (!TERMINAL.includes(item.state) || item.acked_at || item.state === 'cancelled' || item.state === 'skipped') continue;
    const age = now - Date.parse(item.end_at ?? item.enq_at);
    if (age >= ackAfter) {
      anomalies.push({
        code: 'finished-unacked',
        message: `${item.id} ${clock(item.end_at)} 就${item.state === 'done' ? '跑完了' : `结束了（${item.state}${item.rc !== undefined && item.rc !== null ? ` rc ${item.rc}` : ''}）`}，${item.owner} 还没取（过了 ${formatDuration(age / 1000)}）`,
        item: item.id, owner: item.owner, session: item.session, ticket: item.ticket,
        action: `用 priority now 告诉 ${item.owner}：作业 ${item.id} 结束了，日志 ${item.log}；取完运行 csa queue ack ${item.id}`,
      });
    }
  }

  for (const line of loadConfig().lines ?? []) {
    if (!existsSync(line.dir)) { anomalies.push({ code: 'line-missing', message: `线 ${line.id} 的目录不在：${line.dir}`, line: line.id }); continue; }
    if (line.auth) {
      const sha = sectionSha(line.auth.file, line.auth.heading);
      if (sha !== line.auth.sha256) {
        anomalies.push({ code: 'auth-changed', line: line.id, message: `${line.auth.file} 的「${line.auth.heading}」${sha ? '内容变了' : '这一节不见了'}：授权只能由用户改。是用户改的，就重新 csa ticket init 记下新哈希；不是，就报给用户` });
      }
    }
    const ledger = loadLedger(line.dir);
    for (const entry of Object.values(ledger.tickets)) {
      const age = now - Date.parse(entry.updated_at);
      if (entry.status === 'handed-in' && age >= acceptAfter) {
        anomalies.push({ code: 'handed-in-waiting', line: line.id, ticket: entry.ticket, owner: entry.owner, message: `票 ${entry.ticket} 交回 ${formatDuration(age / 1000)} 了，总调度还没验收` });
      }
      if (entry.status === 'gate-failed') info.push(`票 ${entry.ticket} gate 不过（${entry.owner ?? '?'} 在改）`);
      if (['started', 'dispatched', 'handed-in', 'gate-failed', 'blocked'].includes(entry.status)) {
        const { changed } = contractChanged(line.dir, entry);
        if (changed) anomalies.push({ code: 'contract-changed', line: line.id, ticket: entry.ticket, owner: entry.owner, message: `票 ${entry.ticket}（${STATUS_TEXT[entry.status]}）的判法在派单后被改过` });
      }
      if (entry.status === 'waiting-user') info.push(`票 ${entry.ticket} 等用户定`);
    }
  }
  return { ok: anomalies.length === 0, at: new Date(now).toISOString(), anomalies, info, queue: { runner_alive: runner.alive, running: running.map(i => i.id), queued: queued.length, held_by_curfew: heldByCurfew(state, now), paused } };
}

export function patrolText(result: ReturnType<typeof patrol>) {
  const head = result.ok ? 'OK' : `有 ${result.anomalies.length} 件事`;
  const queue = `排队程序${result.queue.runner_alive ? '在跑' : '没在跑'}，正在跑 ${result.queue.running.join('、') || '无'}，排着 ${result.queue.queued} 项${result.queue.paused ? '（急停中）' : result.queue.held_by_curfew ? '（时间窗到点，停着）' : ''}`;
  return [
    `${head}　${clock(result.at)}　${queue}`,
    ...result.anomalies.map(a => `! ${a.code}：${a.message}${a.action ? `\n  → ${a.action}` : ''}`),
    ...result.info.map(i => `· ${i}`),
  ].join('\n');
}
