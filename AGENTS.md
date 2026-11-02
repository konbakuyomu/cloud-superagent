# AGENTS.md

写给审这个仓库的人和编码代理（Codex、Claude Code 等）。仓库是什么，先看 [README.md](README.md)。

## 跑测试

```sh
npm ci
npm run typecheck   # tsc --noEmit
npm test            # node test/dispatch.test.mjs：39 个场景，约 1 分钟
```

- 要 Node 20.6+ 和 git（测试会在临时目录里建 git 仓库、做提交）。不用网络，不用 Claude。
- 每个场景用自己的临时数据目录（`CSA_DATA_DIR`）和临时仓库，互不影响，不碰你机器上的任何状态。
- 测试起子进程一律 `node bin/csa.mjs …`，**不经 shell**，所以 Windows 上参数也原样传过去。被排的作业本身经 shell 跑（Windows pwsh，其他 bash）。
- 有几项和时间有关（排队程序 150 ms 一跳、时间窗 `+5s` / `+6s`）。很慢的机器上偶发失败时，先看是不是这几项（Q7–Q10）。
- CI：`.github/workflows/ci.yml`，ubuntu-latest 和 windows-latest 都跑 typecheck 和 test。

## 代码在哪

| 文件 | 内容 |
|---|---|
| `src/common.ts` | 数据目录、原子写 JSON、目录锁、时长解析、子进程和进程树、简易 glob、路径规范化 |
| `src/queue.ts` | `csa queue`：排队状态、挑下一项、排队程序本体、排队页 |
| `src/ticket.ts` | `csa ticket`：读票、判法哈希、台账 |
| `src/gate.ts` | `csa gate`：跑检查、查范围和禁区 |
| `src/patrol.ts` | `csa patrol`：异常码 |
| `src/cli.ts` | 参数解析和统一出错处理 |
| `bin/*.mjs` | 入口：用 tsx 直接跑 TypeScript，不编译 |
| `test/dispatch.test.mjs` | 场景测试 |

约定的文字版在 [docs/cli.md](docs/cli.md)；为什么这样设计在 [docs/design.md](docs/design.md)。

## 约定

- **出错**：一律 `fail(<一句中文说明>)`，抛 `CliError`，由 `src/cli.ts` 的入口统一打印、退出码 1。不要在锁里 `process.exit`，锁目录会留在原地。`csa patrol` 有异常退出码 3，`csa gate` 不过退出码 1。
- **写文件**：状态文件一律 `writeJson` / `writeText`（先写临时文件再改名，Windows 上改名撞到读者会重试）。改 `queue.json`、`ledger.json` 一律在 `withLock` 里读改写。
- **路径**：比较两个路径、算相对路径用 `inside()` / `canonical()`，不要 `startsWith` 或 `slice(length)`：Windows 的临时目录常是 8.3 短名，git 报的是长名，盘符大小写也会不同。
- **不带个人默认值**：不写死任何人的路径、账号、域名。数据目录只来自 `--data-dir`、`CSA_DATA_DIR` 或平台的通用状态目录。
- **判法哈希的范围**是对外约定（`src/ticket.ts` 的 `readTicket`）：票头除 `owner`、`session`、`status` 外的字段 + 「**达标」段 + 全部 gate 块。改它会让已经派出的票全部报 `contract-changed`，要在 run log 里写清楚。
- **文字**：给人看的输出和文档用中文，短句，先说结论。命令、文件名、字段名保持英文。
- **测试**：新行为先加场景，编号接着用（Q / P / T / G / C）。照搬自原仓库的 34 项（Q1–Q13、P1–P7、T1–T6、G1–G8）不改判法，只能改调用方式。
- **私人信息**：仓库里不能出现个人路径（盘符、用户目录）、会话 id、定时任务 id、邮箱、私人域名、令牌，以及具体硬件项目的数据。提交前跑 `scripts/check-private.sh`（用法见 [docs/run-log.md](docs/run-log.md)「去私人信息」）；私人词表放仓库以外，不要提交。

## 审的时候值得看的地方

- `src/queue.ts` 的 `runLoop`：单例、心跳、孤儿作业、时间窗到点后的退出条件。
- `src/gate.ts` 的 `changedFiles`：有分支和没分支两种范围怎么算。
- `src/common.ts` 的 `shellArgs` / `joinCommand`：PowerShell 退出码怎么带出来，多参数怎么加引号。
- 文档里引用 DeepSeek 原型的 `文件:行` 都按提交 `6337fc8`，可以对着原型核。
