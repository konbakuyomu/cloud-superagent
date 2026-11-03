# cloud-superagent

> **English summary.** An **unofficial** adaptation of the dispatch design in DeepSeek's *Super-agent* research prototype ([deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype), commit `6337fc8`) to **Claude Code cloud sessions**. Three kinds of cloud sessions — a *router* that only dispatches, decides and talks to the user, one *worker* session per ticket, and a *watchdog* — coordinate through the cloud environment's `create_session` / `send_message` / `send_later` tools. Heavy work runs on a separate *executor machine* reached through an MCP daemon, where four deterministic CLIs keep the state: `csa queue` (one heavy job at a time, limits, curfews), `csa ticket` (per-line ledger with hash-locked acceptance criteria), `csa gate` (pre-hand-in checks, scope and forbidden-path checks) and `csa patrol` (code-only first-layer health check). This project is not affiliated with or endorsed by DeepSeek or Anthropic. Docs are in Chinese.

**非官方项目。** 和 DeepSeek、Anthropic 都没有关系，也没有经过它们认可。

## 这是什么

DeepSeek 公开过一个 Super-agent 研究原型：一个总控（Router）只派单，每张票一个干活的会话（Worker），作业在执行环境里跑，宿主进程管准入、排队和巡检。这个仓库把这套设计搬到 **Claude Code 的云端会话**上：

- **三类云端会话**
  - **总调度**：只做三件事——派单、拍板、跟用户说话。每一轮都短，不跑长命令，不为写票去读代码。
  - **子会话**：一张票一个。开工前核授权、核票；重活只经排队；交回前先过 gate；交回时写「下一步草案」。
  - **看门狗**：每 10 分钟跑一次巡检，有事推一下负责的会话；只在三种情况直接找用户。
- **执行机上的四个命令**（经 MCP 守护进程调用，例如 winhand；执行机上不需要登录 Claude）
  - `csa queue`：重作业一次只跑一个，跑完自动开下一个；超上限停整棵进程树；时间窗到点自己停；可以急停；开跑前可以先跑检查；作业结束写事件、可以触发钩子。
  - `csa ticket`：一条线的台账；派单时记下判法哈希，开工以后改判法能被查出来；`show` 给一张带下一跳的卡片；`dispatch --prepare` 建好这张票的 worktree。
  - `csa gate`：交回前照票里写定的检查逐条跑，再查改动范围和禁区。
  - `csa patrol`：巡检第一层，纯代码；没事只打一行 `OK`。

关键约束放在程序里，不靠模型自觉：排队、判法锁、gate、巡检都是确定性的；会话之间的消息只用来叫醒，状态都在执行机的文件里。

## 快速试一下

要 Node 20.6+ 和 git。

```sh
npm ci
npm test                      # 81 个场景，约 2.5 分钟

export CSA_DATA_DIR=$PWD/.csa-data
node bin/csa.mjs queue add --owner TEST --est 5s -- "echo hello"
node bin/csa.mjs queue run --idle-exit 3     # 排队程序：跑完排着的作业，空闲 3 秒后退出
node bin/csa.mjs queue log <作业 id>
node bin/csa.mjs queue ack <作业 id>
node bin/csa.mjs patrol                      # OK …
```

`npm install -g .` 之后有 `csa`，以及四个单独的命令 `csa-queue`、`csa-ticket`、`csa-gate`、`csa-patrol`。数据目录用 `--data-dir` 或 `CSA_DATA_DIR` 指定，默认是平台的通用状态目录。

## 文档

按这个顺序读：

1. [设计](docs/design.md)：原型的五个模块（领域模型、授权、执行、提示词、面板）逐条对到这里，写原型实际怎么做、哪些不照搬、为什么。
2. [云端原语](docs/cloud-primitives.md)：`create_session`、`send_message` 的 `now` / `next` / `later`、`send_later`、`create_trigger`、`subscribe_pr_activity`、`get_session` 的上下文用量。
3. [执行机接口和安全模型](docs/executor.md)：守护进程要提供什么，哪些能查出来、哪些拦不住。
4. [命令约定](docs/cli.md)：四个命令的参数、数据目录、状态和异常码。
5. [runbook](docs/runbook.md)：急停、恢复、时间窗和常见异常怎么处理。
6. [组合用模型](docs/models.md)：哪个角色用哪个模型、哪里能省、换看门狗之前的两段试验。
7. 角色提示词（v2.1）：[总调度](docs/roles/router.md)、[子会话](docs/roles/worker.md)、[看门狗](docs/roles/watchdog.md)；[票模板](templates/ticket.md)。
8. [run log](docs/run-log.md)：这个仓库怎么来的、验证记录、第二期的草案。

审代码的人和 Codex 先读 [AGENTS.md](AGENTS.md)。

## 来源

- 设计依据：DeepSeek 的研究原型 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)，提交 `6337fc8`。文中引用都写成 `文件:行`，没有照抄它的代码。
- 四个命令和 34 个场景测试最初写在作者的私有任务仓库里，这里抽出来、去掉个人路径，改成独立命令行。

## 许可

[MIT](LICENSE)。DeepSeek 原型本身也是 MIT（原型 `README.md:39`）；这里没有复制它的代码。
