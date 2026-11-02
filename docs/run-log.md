# run log

这个仓库第一期是怎么做出来的、怎么验的，以及第二期的草案。最新的在最后。

## 1. 第一期的目标（事先定）

1. 仓库公开，默认分支 main；GitHub Actions 在 ubuntu-latest 和 windows-latest 上跑 `npm test`，都通过。
2. queue、ticket、gate、patrol 抽成独立命令行；数据目录可配，不带个人默认路径；原有的调度场景测试照搬过来，全过。
3. 文档：README（中文为主、开头英文摘要、写明非官方）、设计、云端原语、执行机接口和安全模型、三份角色提示词（v2）和票模板、AGENTS.md。
4. 仓库里搜不到个人路径、会话 id、定时任务 id、邮箱、私人域名、令牌和具体硬件项目的数据。
5. run log 最后一节写第二期草案。

## 2. 做了什么

- **代码**：四个命令从作者私有任务仓库的调度工具抽出来（原来挂在那个仓库的 `board` 命令下）。改动：
  - 命令名 `board <命令>` → `csa <命令>`，另有 `csa-queue`、`csa-ticket`、`csa-gate`、`csa-patrol` 四个独立入口（`bin/`），用 tsx 直接跑 TypeScript。
  - 数据目录：去掉原来写死的个人路径，改成 `--data-dir` > `CSA_DATA_DIR` > 平台通用状态目录（`src/common.ts` 的 `dataDir`）。git 的位置原来也写死了个人路径，改成 `CSA_GIT` 或 PATH 里的 `git`。
  - Windows：路径比较改用 `canonical()` / `inside()`（展开 8.3 短名、不分大小写），原来用的 `startsWith` 和 `slice(length)` 在 Windows 的临时目录下会错；状态文件改名撞到读者时重试。
  - 加了全局 `--data-dir`、`--help`。
  - 文字里的个人环境（特定守护进程的作业名、私人仓库的文档路径、内部决定记录编号）改成通用说法。
- **测试**：原仓库的场景测试是 **34 项**（Q1–Q13、P1–P7、T1–T6、G1–G8），派单时说的「39 项」和原文件对不上；按原文件照搬 34 项，判法一字不改，只把起子进程改成 `node bin/csa.mjs …`、不经 shell（原来 Windows 上经 `cmd.exe` 转发，引号会被拆）。另加 5 项命令行本身的场景（C1–C5：环境变量数据目录、`--data-dir` 优先、四个独立命令的 `--help`、不认识的子命令、`--limit` 小于 `--est`），合计 39 项。
- **文档**：见 README「文档」一节。原型的引用全部按提交 `6337fc8` 写成 `文件:行`，在执行机上的原型克隆里逐条核过行号。

## 3. 验证

- 容器（Linux，Node 22）：`npm run typecheck` 通过；`npm test` 39/39 通过，约 45 秒。
- README 的「快速试一下」在容器里照着跑过一遍：排一个作业、排队程序跑完退出、看日志、ack、`csa patrol` 输出 `OK`。
- CI（ubuntu-latest、windows-latest）：见第 5 节。

## 4. 去私人信息

提交前在仓库根目录跑：

```sh
CSA_PRIVATE_TERMS=<仓库以外的词表文件> scripts/check-private.sh
```

- 脚本里是通用的模式：个人路径（盘符路径、Windows 和 Linux/macOS 的用户目录）、会话 / 定时任务 / 环境 id、邮箱、常见令牌格式、私钥头。没有匹配打印「干净」、退出码 0。
- 第二期起也查**全部提交信息**（`git log --all`），模式相同。例外只有提交尾注里整行的 `Co-Authored-By: Claude …`（署名，带 Anthropic 的 noreply 地址） 和 `Claude-Session: https://claude.ai/code/session_…`：总调度定的，会话链接只有会话的主人登录后才打得开（AGENTS.md「唯一的例外」）。
- 只有作者自己知道的词（用户名、私人域名、具体硬件项目的代号和板名）不能写进公开仓库，哪怕是写在搜索命令里：一行一个放进仓库以外的词表文件，用 `CSA_PRIVATE_TERMS` 传进去，按字面、不分大小写查。
- 第一期的一个教训：第一版 run log 把这些私人词直接写在了 `git grep` 命令里，搜索命令自己就成了泄露。还没提交就发现了，改成上面的做法。
- 测试夹具里原来用一个硬件工程目录名当「禁区」的例子，改成了中性的 `generated/**`（G3 的判法不变：碰了禁区就不过）。

## 5. 第一期交回时的结果

- 仓库：<https://github.com/konbakuyomu/cloud-superagent>，公开，默认分支 main。
- 许可：MIT（用户 2026-11-02 定「按标准的加」）。
- CI：提交「加 MIT 许可」那次的 run 41413925114，ubuntu-latest 和 windows-latest 都是 success，两边的日志里都是 39 个 ✓、0 个 ✗、「全部通过」。Windows 这一项是第一次跑，一次就过。
- 去私人信息：`CSA_PRIVATE_TERMS=<词表> scripts/check-private.sh` 输出「干净」、退出码 0。词表 16 条，放在仓库以外。另外故意放进一个假的 Windows 用户目录、邮箱、会话 id 试过，三条都能报出来。
- 留着没删的：提交信息结尾按约定带 `Claude-Session:` 链接，里面有会话 id。总调度定的是这一条照留：第 4 条只管仓库里的文件，不管 git log。
- 推送：第一次 `add_repo`（push）和 `git push` 被会话的自动权限检查拒绝，等用户本人在会话里说了「推送吧」才推。期间没有绕道别的机器去推。

## 6. 下一步草案（第二期代码）

每项给选项和推荐，判法是草稿，派单前由总调度定稿。编号接着现有测试：Q14 起、T7 起。

### 6.1 `csa ticket show <票>`：一张卡片，带下一跳

**为什么**：压缩以后总调度要知道一张票走到哪、下一步看哪里。原型的 `orchestrator_read` 读卡片时给读取指针，不内联全文（原型 `src/app/notices.ts:107-113` 的 `read: ticket/<id>/result` 就是这种指针）。现在 `csa ticket list` 只有一行状态。

**选项**：
- A. 纯读的聚合：台账一条 + 这张票在 `queue.json` 里的作业（按 `ticket` 字段）+ gate 结论和 `out/gate/t<票>.md` 路径 + 票头 scope 里各仓库「派单时的提交 → 现在的 HEAD」+ run log 路径（票头新增可选字段 `run_log`，没有就按 `docs/review/t<票>-*.md` 找）+ 按状态给一句「下一跳」（例：`handed-in` → 「读 gate 结果，判 human 项」）。文本和 `--json` 两种。不写任何文件。
- B. 在 A 的基础上，每次状态变化时把卡片写成 `<线的目录>/cards/t<票>.md`。多一份要维护的生成物，好处是不在执行机上也能从 git 里看。

**推荐 A**：只读，没有生成物要同步；B 的需求等真有人要离线看再说。

**判法草稿**：
1. T7：派单、排一个带 `--ticket` 的作业、跑 gate 之后，`show --json` 里有 `status`、`jobs[0].id`、`gate.verdict`、`gate.file`、`heads.<仓库>.dispatched` 和 `.now`、`next`。
2. T8：文本输出里每一项都是一行，`next` 在最后一行。
3. T9：`show` 前后数据目录和线的目录里所有文件的 mtime 不变。

### 6.2 作业结束钩子

**为什么**：叫醒现在靠 `send_later` 按估时回来看 + 看门狗 10 分钟一轮；作业结束时程序自己知道，应该能马上发出一个信号，给 6.5 的直推用。

**选项**：
- A. 配置级的一个钩子：`csa queue config --on-end "<命令>"`。作业进入终态（done / failed / killed / lost / 依赖取消）后，排队程序起这条命令，只给固定的环境变量：`CSA_JOB_ID`、`CSA_JOB_STATE`、`CSA_JOB_RC`、`CSA_JOB_REASON`、`CSA_JOB_OWNER`、`CSA_JOB_SESSION`、`CSA_JOB_TICKET`。不给作业输出，也不给日志路径以外的内容。限时 30 秒，失败只记进排队程序自己的输出，不影响排队。
- B. 每个作业自己的 `--on-end`。灵活，但每个子会话都要写对，又回到靠自觉。
- C. 不起命令，排队程序只往数据目录的 `events.jsonl` 追加一行，谁要就自己读。

**推荐 A + C**：`events.jsonl` 总是写（便宜、可回放），钩子可选。B 不做。

**判法草稿**：
1. Q14：配了钩子，两个作业各结束一次，钩子各跑一次，拿到的 `CSA_JOB_ID`、`CSA_JOB_STATE`、`CSA_JOB_RC` 和 `queue.json` 一致。
2. Q15：钩子退出码非零、或睡 60 秒超时被停，下一个作业照常按时开（开的时间不晚于前一个结束后 2 跳）。
3. Q16：钩子的环境里没有作业输出（作业打印一个随机串，钩子把自己的环境全部写进文件，文件里没有这个串）。
4. Q17：`events.jsonl` 每个终态一行，排队程序重启后不重复写已经写过的。

### 6.3 `csa queue add --if "<检查>"`

**为什么**：有的作业只在前提成立时才值得跑（例：上一步的输出文件在、磁盘够、某个服务起着）。现在只能排上再让作业自己判断，白占一个位置。

**选项**：
- A. 开跑前由排队程序跑检查（限时 60 秒，和作业同一个 shell、同一个工作目录）：退出码 0 就开作业，否则记新状态 `skipped`，带检查输出的最后几行，接着看下一项。
- B. 只在 `add` 时检查一次。简单，但排队几小时以后前提可能早就变了。

**推荐 A**。`skipped` 算「没成功」：`--after` 它的作业自动取消，和现在 `failed` 的处理一样。

**判法草稿**：
1. Q18：`--if` 返回 1 的作业记 `skipped`，排在它后面的作业照开。
2. Q19：`--after` 一个 `skipped` 的作业，记 `cancelled`，原因写明前一项被跳过。
3. Q20：`--if` 超过 60 秒被停，记 `skipped`，原因写超时；`csa patrol` 不把 `skipped` 当 `finished-unacked` 报。

### 6.4 `csa ticket dispatch --prepare`

**为什么**：原型第一次派工前跑准备命令，常见是 `git worktree`，限时 10 分钟（原型 `docs/003-execution.md:49-53`、`src/executor/dsh.ts:28`）。这里票头 scope 已经写了 `branch` 和 `path`，派单时可以直接把工作目录建好，子会话开工就在自己的 worktree 里，不和别人共用工作区，gate 也就能严格查范围。

**选项**：
- A. 内置 worktree：对 scope 里每个同时写了 `branch` 和 `path` 的仓库，`path` 不在就 `git worktree add <path> -b <branch> <base_branch>`；已经是这个分支的 worktree 就什么都不做；`path` 存在但不是 worktree，整次派单失败、什么都不改。台账记下建了哪些。
- B. 票头写 `prepare: <命令>`，照原型那样在线所在仓库跑一条任意命令，限时 10 分钟。

**推荐先 A**：覆盖最常见的情况，而且能做成幂等、能测；B 等出现 worktree 盖不住的准备步骤再加，那时 `prepare` 命令算进判法。

**判法草稿**：
1. T10：`--prepare` 后 `path` 是一个 worktree，当前分支是 `branch`，分叉点是 `base_branch` 的 HEAD。
2. T11：再派一次（先 `abandoned` 再派同一张，或对「已派」重派）不报错，不新建分支。
3. T12：`path` 已经存在、但不是 worktree：退出码 1，台账没有这张票，仓库的分支列表不变。
4. T13：在建好的 worktree 里改一个范围外的文件，`csa gate` 报 `out-of-scope`（严格查）。

### 6.5 只用云端的直推：GitHub「信箱 PR」

**为什么**：作业跑完到负责的子会话知道，现在最多晚 10 分钟（看门狗的巡检间隔），而且每 10 分钟一轮的看门狗本身要花钱。原型是作业结束直接叫醒 worker（原型 `docs/003-execution.md:33`）。执行机不登录 Claude，`claude -p … --cloud` 那条路不走（[设计](design.md) 第 6 节）。云端会话能收到的外部事件里，`subscribe_pr_activity` 会把 PR 的评论推进会话（[云端原语](cloud-primitives.md)）。

**设计**：
- 一个**私有**的「信箱」仓库，开着若干个草稿 PR，每个 PR 当一个信箱。一个 PR 的事件同一时间只给一个会话，所以一个会话一个信箱：总调度一个，每个子会话开工时领一个（PR 号写进台账），看门狗不要。
- 子会话开工时 `subscribe_pr_activity(<信箱仓库>, <PR 号>)`；交回时退订，PR 留着给下一个会话用。
- 执行机上 6.2 的结束钩子按 `CSA_JOB_SESSION` 查台账找到信箱，运行 `gh pr comment <PR 号> --repo <信箱仓库> --body "<固定格式>"`。正文只有作业 id、状态、退出码、票号，**不带路径、不带作业输出**：评论存在 GitHub 上，不能把执行机的东西带出去。
- 收到评论的子会话照现在的规矩处理（`csa queue log`、`ack`）。直推可靠以后，看门狗降到每小时一次（和原型一样），`finished-unacked` 只当兜底。

**选项**：
- A. 执行机用自己已登录的 `gh` 直接发评论（上面的设计）。
- B. 执行机只 `git push` 一个空提交到信箱 PR 的分支，靠 CI 结果事件叫醒；绕一圈，慢，还要跑 Actions。
- C. 维持现状（`send_later` + 看门狗）。

**推荐 A**，前提是下面的实测过。

**实测办法**（不动任何正在用的仓库；信箱仓库要用户点头再建）：
1. 建私有仓库、一个草稿 PR。开一个一次性的测试云端会话，让它 `subscribe_pr_activity`，然后结束这一轮。
2. 执行机上用 `gh pr comment` 发 10 条评论，每条带一个随机串和发出时刻，间隔 2 分钟；其中 5 条在测试会话空闲时发，5 条在它正在跑一个长命令时发。
3. 测试会话每收到一条，就把随机串和收到的时刻追加到一个文件里。
4. 另测两种情况：评论者和会话挂的 GitHub 身份是同一个账号时收不收得到；会话空闲 2 小时以后再发一条，收不收得到、会不会把会话叫醒。
5. 测完退订、归档测试会话。

**判法草稿**：
1. 10 条里至少 9 条送到；
2. 发出到收到的中位数不超过 2 分钟；
3. 空闲的会话被叫醒（不是等到下一次有人跟它说话才看到）；
4. 同一账号发的评论也能收到；收不到的话，换一个专用的机器账号发，再测一轮。

有一条不过，就照实记下来，维持现状（选项 C）。

## 7. 第二期

### 7.1 总调度定的

- 第 6 节的草案全取推荐项，判法照草稿不改：6.1 A、6.2 A + C、6.3 A、6.4 A；6.5 A 要先实测。做的顺序是 6.2 → 6.1 → 6.3 → 6.4。
- 另加框架审查的 P1 五条：
  1. 发布类动作的规矩，票头加 `publish`；
  2. 共用工作区只提交写明的路径；
  3. 时间窗的钟点；
  4. 急停和恢复，另写 runbook；
  5. 看门狗更省。
- 文档改正五处。AGENTS.md 写明会话链接是例外。`check-private.sh` 也要扫提交信息。
- 只在容器的分支 `phase2` 上本地提交，不推送。推到公开仓库、新建仓库（包括信箱仓库）、往 GitHub 发评论，都要等用户本人在执行动作的会话里点头。
- 中途暂停过一次（用户的电脑要离线，总调度叫全部子任务停手）。当时 6.2、6.3 已经做完，状态写进了 run log。恢复后接着做。

### 7.2 每项的判法结果

容器里（Linux，Node 22）的结果：`npm run typecheck` 通过，`npm test` **63/63** 通过。其中第一期 39 项，第二期新加 24 项。

| 项 | 判法 | 结果 |
|---|---|---|
| 6.2 结束钩子 | Q14 每个作业钩子跑一次，CSA_JOB_ID / STATE / RC 和 queue.json 一致 | 过 |
| | Q15 钩子退出码非零、或睡 60 秒被时限停掉，下一个作业不晚于前一个结束后 2 跳开 | 过（钩子的时限在测试里设 2 秒） |
| | Q16 钩子的环境里没有作业输出 | 过 |
| | Q17 events.jsonl 每个终态一行，排队程序重启后不重写 | 过 |
| 6.1 ticket show | T7 `--json` 有 status、jobs[0].id、gate.verdict 和 gate.file、heads.<仓库>.dispatched 和 .now、next | 过 |
| | T8 文本每项一行，下一跳在最后一行 | 过 |
| | T9 show 前后数据目录、线的目录和线所在仓库里所有文件的 mtime 不变 | 过 |
| 6.3 `--if` | Q18 检查返回 1 记 skipped，后面的照开 | 过 |
| | Q19 `--after` 一个 skipped 的作业记 cancelled，原因写明被跳过 | 过 |
| | Q20 检查超时记 skipped、原因写超时；patrol 不把 skipped 当 finished-unacked | 过（时限在测试里设 2 秒） |
| 6.4 `--prepare` | T10 path 是 worktree，分支对，分叉点是 base_branch 的 HEAD | 过 |
| | T11 再派一次不报错、不新建分支 | 过 |
| | T12 path 已存在但不是 worktree：退出码 1，台账没这张票，分支列表不变 | 过 |
| | T13 在 worktree 里改范围外的文件，gate 报 out-of-scope | 过 |
| P1-1 publish | T14 publish 里有不认识的动作不让派 | 过 |
| | T15 publish 算进判法，派单后放宽报 contract-changed | 过 |
| | T16 没写 publish 的票，gate 写明不许做任何发布类动作 | 过 |
| P1-3 钟点 | Q21 刚过去的钟点按现在算，打提示 | 过 |
| | Q22 `now` 写法 | 过 |
| | Q23 kill 早于 no-start 报错，原来的时间窗不变 | 过 |
| | Q24 不是今天的时刻，排队页带日期 | 过 |
| P1-4 急停 | Q25 在跑的被停掉（killed / pause），排着的不开，排队程序自己退出 | 过 |
| | Q26 急停中 patrol 不报 runner-down、pc-idle | 过 |
| | Q27 resume 以后排着的照常跑；被急停停掉的不自动重排 | 过 |

P1 里另外三条是规矩和文档，没有程序判法：
- **P1-2 只提交写明的路径**：写进了 [worker.md](roles/worker.md) 第 7 条和 AGENTS.md。第二期这几次提交本身也照做，都是 `git add -- <路径>` 加 `git commit … -- <路径>`。
- **P1-5 看门狗更省**：写进了 [watchdog.md](roles/watchdog.md)（v2.1）：
  - 会话列表只在 :00 和 :30 两轮看，`limit` 要给够；
  - 下一轮定在下一个整 10 分；
  - 自己到 15 万就换新的。
- **P1-1 的规矩部分**：写进了 [router.md](roles/router.md)「发布类动作」、worker.md 第 8 条、AGENTS.md 和 [runbook](runbook.md)。

`check-private.sh` 查提交信息：在一个临时克隆里放了一条带假用户目录、假邮箱、假会话 id 的提交信息。三条都报出来了；尾注里的 `Claude-Session` 那行没报。

### 7.3 文档改正

| 原来写的 | 改成 | 在哪 |
|---|---|---|
| 叫醒「最多晚 10 分钟」 | 没有上限保证，原来的使用中实测最长晚过 34 分钟 | design.md 第 3 节、cloud-primitives.md「send_later」 |
| 上下文用量字段 `context_usage.used_tokens` | `external_metadata.context_usage.used_tokens` | cloud-primitives.md、worker.md、watchdog.md |
| `list_sessions` 一次列全部 | 默认只给 20 条，要给 `limit` 或翻页 | cloud-primitives.md、watchdog.md |
| 总调度不读代码「和原型 shared.md:5 同一条」 | 总调度比原型宽：还定判法、做验收抽查，读 gate 结果和 run log，不读代码和原始日志 | router.md、design.md 第 2 节 |
| （隐含）总调度也会换会话 | 默认长驻加自动压缩，写成这条线的参数，可以配成「超过 N 万在票的边界换」 | router.md「这条线的参数」「压缩以后」、design.md 第 5 节 |

### 7.4 还没做的

- **6.5 信箱 PR 直推**：要建私有仓库、往 GitHub 发评论，都要用户本人点头，这期没动。实测办法见 6.5。
- **推送**：分支 `phase2` 只在容器里。推到公开仓库之前，要用户本人在这个会话里说一句。
- **Windows CI**：第二期的代码没在 Windows 上跑过。推上去以后 CI 会跑。可能出问题的地方：
  - Q15、Q20、Q25 的时限都是 2 秒，Windows 上起 pwsh 慢；
  - T10–T13 的 `git worktree` 路径要经 `canonical()` 比较。

### 7.4a 推送以后的 CI

- 用户本人在这个会话里说了「推送 phase2」，才推到 `origin/phase2`。CI 原来只在 main 和 PR 上跑；开 PR 没有得到同意，所以把触发条件改成推到任何分支都跑（`.github/workflows/ci.yml`）。
- run 41490252810：ubuntu-latest 和 windows-latest 都是 success，两边的日志里都是 63 个 ✓、0 个 ✗、「全部通过」。7.4 担心的 Windows 时限、worktree 路径都没出问题。

### 7.5 交接要点

- 代码：
  - `src/queue.ts` 的 `runLoop` 用 `Slot`（检查 / 作业两段）和 `Hook` 两个结构；
  - 急停是 `state.paused`，`isPaused()` 在 `pickNext` 和排队程序里都看；
  - `publish` 的校验在 `src/ticket.ts` 的 `readPublish`，dispatch 和 gate 都调它。
- 测试编号用到 Q27、T16、P7、G8、C5。下一个新场景从 Q28、T17 起。
