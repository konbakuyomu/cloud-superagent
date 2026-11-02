# 命令约定：queue、ticket、gate、patrol

执行机上的四个确定性命令。云端会话经 MCP 守护进程（例如 winhand）的 `run` 调用它们，执行机上不需要登录 Claude。为什么要这四个，见 [设计](design.md)。

## 怎么调用

```
csa <queue|ticket|gate|patrol> …      # 总入口
csa-queue … / csa-ticket … / csa-gate … / csa-patrol …   # 四个独立命令，等于 csa <命令> …
csa <命令> --help
```

- 装：`npm ci`（或 `npm install -g .`，之后就有上面五个命令）。要 Node 20.6 以上和 git。TypeScript 由 tsx 直接跑，不用先编译。
- 出错一律打一行中文说明、退出码 1，不打堆栈。`csa patrol` 有异常时退出码 3。
- 环境变量 `CSA_GIT` 可以指定 git 的位置（默认在 PATH 里找 `git`）。

## 数据目录

排队、日志、配置放在数据目录里，优先级：

1. 命令行 `--data-dir <目录>`（任何位置都行，`--` 之前）；
2. 环境变量 `CSA_DATA_DIR`；
3. 平台的通用状态目录：Windows `%LOCALAPPDATA%\cloud-superagent`；其他 `$XDG_STATE_HOME/cloud-superagent`，没设就 `~/.local/state/cloud-superagent`。

目录里有：

| 文件 | 内容 |
|---|---|
| `queue.json` | 排队状态（作业、时间窗） |
| `logs/<作业 id>.log` | 作业输出 |
| `runner.json` | 排队程序的 pid 和心跳 |
| `config.json` | 配置：另写排队页的路径 `views`、默认 shell、登记的线 `lines` |
| `queue.md` | 程序生成的排队页，只读 |
| `*.lock/` | 目录锁，用完就删；超过 30 秒没放当作持有者已死 |

线自己的台账 `ledger.json` 不在数据目录，在线的目录里（跟着票走）。

## csa queue：执行机上的重作业一次只跑一个

```
csa queue add --owner <会话代号> --est 12m [--limit 40m] [--ticket 50] [--session <id>] [--note "<说明>"] [--after <作业 id>] [--cwd <目录>] [--shell pwsh|powershell|cmd|bash] -- "<整行命令>"
csa queue list | status [--json] | log <作业 id> [--lines 40] | ack <作业 id> [--by <会话>] | cancel <作业 id>
csa queue curfew --no-start-after 06:45 --kill-at 06:50 [--note "<出处>"] | --clear
csa queue run [--idle-exit 120]
csa queue config [--add-view <路径>] [--remove-view <路径>] [--shell …]
```

- `--limit` 默认估时 × 2 + 10 分钟。到上限停整棵进程树（Windows `taskkill /T /F`；POSIX 先 TERM 整个进程组，5 秒后 KILL）。
- `--` 后面只给一个参数时当整行命令原样用；给了好几个时按目标 shell 的规矩逐个加引号再拼。Windows 默认 pwsh（没有就 Windows PowerShell），其他默认 bash。PowerShell 下会把外部程序的退出码原样带出来。
- 先来先跑。`--after` 的前一项没成功，后一项自动取消。时间窗里放不下（`now + 估时 > kill_at`）的长作业跳过，看后面短的。
- 时间窗到点以后一直停着，直到有人 `--clear`；这期间排着的作业不算「有活」，排队程序照样退出。
- `run` 是排队程序本体：单例（心跳 30 秒内的另一个实例直接退出）；排队清空 `--idle-exit` 秒后退出。上一个排队程序留下的「正在跑」：进程还在就等它，不在了记「下落不明」（`lost`）。
- 作业状态：`queued`、`running`、`done`、`failed`、`killed`（带原因 `limit` / `curfew` / `cancel`）、`cancelled`、`lost`。跑完的作业负责会话取走结果后 `ack`。
- `config --add-view` 让程序把排队页另写一份到那个路径（会覆盖那里原有的内容）。

## csa ticket：一条线的台账

```
csa ticket init --dir <线的目录> [--id <线的 id>] [--auth-file CLAUDE.md --auth-heading "## 授权"]
csa ticket dispatch <票> --owner <会话> [--session <id>] [--note …]
csa ticket set <票> <状态> [--note …] | accept <票> | amend <票> --reason "<理由>" | list [--json] | show <票> [--json]
```

后面几条都要 `--dir <线的目录>` 或 `--line <id>`（`init` 登记过的）；当前目录下有 `issues/` 时可省。

- 线的目录里要有 `issues/`，票文件叫 `<票号>-<短名>.md`，写法见 [templates/ticket.md](../templates/ticket.md)。
- `init` 把线登记进 `config.json`，给了 `--auth-file` 就记下授权一节的哈希（从标题到下一个同级标题）。
- `dispatch` 记下判法哈希和票头 scope 里各仓库的当前提交。没有「**达标」段也没有 gate 块的票不让派。
- **判法** = 票头里除 `owner`、`session`、`status` 以外的字段 + 「**达标」那段（到 `**Blocked by`、`**Status` 或下一个标题为止）+ 所有 ```` ```gate ```` 块。改了这些哈希就变；只换 owner 不变。
- 状态：`dispatched`、`started`、`handed-in`、`gate-failed`、`accepted`、`rejected`、`blocked`、`waiting-user`、`abandoned`。「已派」只能由 `dispatch` 设；`amend` 只在「已派」时能用，要理由，记下新旧哈希。

## csa gate：交回前的确定性检查

```
csa gate <票> [--dir <线的目录> | --line <id>] [--out <目录>] [--json] [--no-ledger] [--shell …]
```

- 照票里的 gate 块逐条跑：`run`、`cwd`（相对线所在仓库的根目录）、`timeout`（默认 10 分钟）、`expect: {exit, stdout, not_stdout}`（后两个是正则）。`human: <说明>` 的不跑，留给总调度判。
- 查判法派单后有没有被改（`contract-changed`）。
- 查票头 `scope`（`仓库名: {paths, branch, base_branch, base, path, strict}`）：
  - 有 `branch` 的仓库比分支相对 `base_branch` 分叉点以来的改动，默认严格（`out-of-scope` 判不过）；
  - 没分支的共用工作区比派单时记下的提交（或 `base`）以来的改动和新文件，默认只提示，`strict: true` 改成严格；
  - gate 自己的输出和台账不算改动。
- 查 `forbid`：只认路径 glob（含 `*` 或 `/`），碰了一律不过（`forbidden-path`）；其余（如 `git push`）列成「程序查不了」留给总调度。
- 结论：`pass`、`pending-human`（自动项都过，还有人判项）、`fail`。结果写 `<线所在仓库>/out/gate/t<票>.json` 和 `.md`，台账改成 `handed-in` 或 `gate-failed`。不过退出码 1。

## csa patrol：巡检第一层

```
csa patrol [--json] [--ack-after 10] [--accept-after 15] [--idle-after 60]
```

纯代码，只回答「有没有事」。没事输出一行 `OK…`、退出码 0；有事列出异常、退出码 3：

| 代码 | 意思 |
|---|---|
| `runner-down` | 排着作业，排队程序没在跑 |
| `pc-idle` | 排队程序在跑、能开的作业却没开，超过 `--idle-after` 秒 |
| `over-estimate` | 在跑的作业超过估时 1.5 倍 |
| `finished-unacked` | 作业结束超过 `--ack-after` 分钟没人 ack（带 owner、session） |
| `handed-in-waiting` | 票交回超过 `--accept-after` 分钟总调度没验收 |
| `contract-changed` | 没结束的票，判法在派单后被改 |
| `auth-changed` | 授权一节的哈希变了，或这一节不见了 |
| `line-missing` | 登记的线的目录不在 |

时间窗到点后排着的作业只记一行说明，不算异常。
