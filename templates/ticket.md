---
ticket: <票号>
line: <线的 id，和 csa ticket init 登记的一样>
owner: <负责的子会话代号，例：B>          # 换人只改这一行，判法哈希不变
authority: CLAUDE.md#授权（第 <起>–<止> 行）  # 子会话开工前在执行机上核对这一节
scope:                                    # 能改哪些仓库的哪些路径；仓库名默认是线所在仓库上一级目录里同名的文件夹
  <代码仓库>: { branch: <这张票的分支>, base_branch: main, path: <worktree 目录，可省；写了 dispatch --prepare 就建它>, paths: ["src/<模块>*.ts", "test/<模块>*.test.mjs"] }
  <线所在仓库>: { paths: ["docs/review/t<票号>-*.md", "<线的目录>/issues/<票号>-*.md"] }   # 共用工作区默认只提示，要严格查加 strict: true
forbid: ["<生成物或不许碰的目录>/**", "git push", "批量删除"]   # 路径 glob 由 gate 查，其余留给总调度
publish: []                              # 发布类动作：不许就写 []。要的话一项一行：- { repo: <owner/name>, actions: [push, pr] }
                                          # 动作只能是 create-repo、visibility、push、pr、comment、upload；写了只是「可以问」，
                                          # 每一件仍要用户本人在执行动作的那个会话里说，总调度不转述同意
run_log: docs/review/t<票号>-run.md        # 可省；csa ticket show 用它给出 run log 的位置
# model: opus                             # 可省；不写就用这条线参数里的子会话默认模型。和 owner 一样不算进判法。这一期做票的子会话不降模型（docs/models.md）
pc_budget: <执行机作业总时长，例：2 × 15 min>
stop_if: ["要花钱", "要动执行机上仓库以外的设置", "判法写的前提不成立"]
---

# <票号>: <一句话说清做什么>（<线>，子会话 <X>）

**Why:**
- <为什么做；出处：决定记录、上一张票的 run log 第几节>

**What to build:**
- <做什么；只读还是会改；默认行为变不变>

**达标（事先定，跑完照判，不改）：**
1. <可以量的判法，例：两次输出逐字节相同>
2. <例：单次用时不超过 900 s>
3. <例：关键指标不比基线差 5 % 以上>

```gate
- id: 1-<短名>
  run: <在执行机上跑的检查命令，只读作业的结果，不重跑重活>
  cwd: <相对线所在仓库的根目录，可省>
  timeout: 5m
  expect: { exit: 0 }
- id: 2-<短名>
  run: <另一条检查>
  expect: { exit: 0, stdout: "<输出里必须出现的正则>" }
- id: 3-<短名>
  human: <要总调度判的那一条，例：归因说得通>
```

**Blocked by:** <前置票，没有写「无」>

**Status:** 排队（子会话 <X>，<日期 时间> 开）
