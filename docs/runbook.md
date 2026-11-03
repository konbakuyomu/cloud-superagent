# runbook：急停、恢复和常见的处理

出事时照着做。命令都在执行机上经守护进程跑，数据目录用 `CSA_DATA_DIR` 或 `--data-dir` 指定。命令的细节见 [命令约定](cli.md)。

## 急停：用户说「全部停下」「执行机要离线」

谁来做：总调度。用户的话只有总调度接；子会话和看门狗不自己急停。

1. **停执行机上的作业**：

   ```
   csa queue pause --note "<用户原话和时刻>"
   ```

   - 在跑的作业几秒内被停掉，记 `killed`，原因 `pause`。**不会自动重排**。
   - 排着的作业都不开。排队程序随后自己退出，执行机可以关。
   - 排队程序没在跑也照样能设上：下次起来它先看到急停，什么都不开。
2. **停会话**：用 `send_message`（priority `now`）告诉每个子会话三件事：
   - 停手；
   - 用一两分钟把当前状态写进 run log；
   - 本地提交，只提交写明的路径。

   等它们回「收到」。看门狗照常巡检。急停中 `csa patrol` 多记一行「急停中」，不报 `runner-down`、`pc-idle`；别的异常照报（被急停停掉的作业会报 `finished-unacked`）。看门狗按 [watchdog.md](roles/watchdog.md) 的「急停中」那一行办：不推子会话，判法和授权的异常照样报总调度。
3. **执行机真的要离线时**：告诉会话们离线期间不要经守护进程碰执行机，执行机连不上是预期的。看门狗连不上两轮本来要推用户的手机，这次先跟它说一声不用推。
4. 用一句话告诉用户：停了哪些作业、哪些会话已经停手。

**为什么急停不自动重排**：急停常常是因为作业本身有问题（跑偏了、占满了资源），自动重排会在恢复时把问题带回来。是否重排由负责的子会话看过日志以后决定。

## 恢复

谁来做：总调度，**等用户说了**再做。转述的不算，要用户在总调度的会话里说。

1. 执行机回来以后，先看一眼状态：

   ```
   csa patrol
   csa queue list
   ```

2. 解除急停：

   ```
   csa queue resume
   ```

   输出里说排队程序没在跑，就用守护进程的后台作业开 `csa queue run`。
3. 告诉被停掉作业的子会话（`csa queue list` 里 `killed`、原因「急停」的那些）：
   - 看日志：`csa queue log <作业 id>`；
   - 要接着跑，就重新 `csa queue add`；
   - 处理完 `csa queue ack <作业 id>`。
4. 告诉其余子会话可以接着做。看门狗照常。

## 时间窗（用户说「执行机最多用到 7 点」）

```
csa queue curfew --no-start-after 06:45 --kill-at 06:50 --note "<用户原话>"
```

- 已经过了的钟点：刚过去 30 分钟以内的按「现在」算，会打一行「刚过去」的提示，看到提示要确认是不是本意。更早过去的算明天。要明天的同一钟点，写完整时刻（`2026-11-03T06:45`）。
- 立刻生效写 `now`。
- 到点以后一直停着，用户说执行机恢复了再 `csa queue curfew --clear`。

急停和时间窗的区别：时间窗是事先定好的到点停，按估时挑放得下的作业接着跑；急停是马上全停。

## 常见的异常

| 看到 | 做什么 |
|---|---|
| `csa patrol` 报 `runner-down` | 用守护进程的后台作业开 `csa queue run`。急停中不会报这一条 |
| 作业记 `lost` | 排队程序重启前作业就在跑，后来进程不见了，退出码不明。负责的会话看日志判断，要的话重排 |
| 作业记 `skipped` | `--if` 的检查没过或超时，原因在 `reason` 里，检查的输出在作业日志里 |
| `contract-changed` | 票的判法在派单后被改了。总调度看是谁改的；开工前要补判法，走 `csa ticket amend` |
| `auth-changed` | 授权一节变了。是用户改的，总调度重跑 `csa ticket init … --auth-file …`；不是，告诉用户 |
| 等锁超时 | 数据目录里 `*.lock` 目录超过 30 秒会被当作过期自动清掉。一直等不到，先看是不是有卡住的 `csa` 进程 |
| 结束钩子一直报退出码 | 看 `logs/hooks.log`。钩子坏了不影响排队，可以先 `csa queue config --clear-on-end` |

## 发布类动作出了岔子

例如推错了仓库、评论发到了公开的地方。先停手，告诉总调度，由总调度告诉用户。**不要自己删仓库、删分支、改历史去补救**：这些也是发布类动作，同样要用户本人在执行动作的那个会话里点头。

## 从原来的 `board` 命令切到 `csa`

给已经在用原来那个任务仓库里 `board queue / ticket / gate / patrol` 的线（下称「原仓库」）。`csa` 就是从那里抽出来的，数据格式兼容。所以**不用搬数据**：让 `csa` 指向原来的数据目录，切的只是命令。

### 先决条件（缺一条就不切）

- **用户定好用哪个分支**：`main` 或 `phase3-models`。急停、`--line`、`ticket show` 只在 `phase3-models` 上有；合不合进 `main`，要用户本人在执行合并的会话里说。
- **执行机上的队列排空**：`board patrol` 显示排队程序没在跑、正在跑的是「无」、排着 0 项。不在作业中途切。
- **核一下执行机上原仓库的调度代码**：`csa` 是按某一版原仓库的 `scripts/dispatch/` 抽出来的。执行机上的原仓库要是之后又改过 `queue.json` 或 `ledger.json` 的字段，先对一遍差别再切。

### 起 `csa`：不装到全局

推荐**不全局安装**，每次用完整路径跑：

1. 在执行机上找一个仓库以外的目录（例如守护进程的 scratch 目录），克隆这个仓库，检出用户定的分支。然后跑：

   ```
   npm ci
   npm test
   ```

   `npm test` 约 2.5 分钟，只在系统临时目录里建、删它自己的文件。
2. 之后每条命令都写成 `node <克隆目录>\bin\csa.mjs <命令> …`。数据目录每次用 `--data-dir <原来的目录>` 传，或者在同一条命令前面临时设 `CSA_DATA_DIR`。

`npm install -g .`、把 `csa` 放进 PATH、设一个永久的环境变量，都算**改执行机上仓库以外的设置**，要用户点头才做。不做这几样，就什么都不用卸。

### 数据目录：指向原来的那个

- `--data-dir` 填原仓库原来的数据目录，也就是它的 `BOARD_DISPATCH_DIR`，没设就是它代码里的默认值。这样会接着用原来的：
  - `queue.json`：排队记录；
  - `logs/`：作业输出；
  - `runner.json`：排队程序的心跳；
  - `config.json`：登记的线、排队页另写的路径、默认 shell；
  - `queue.md`：排队页。
- **台账 `ledger.json` 和 gate 结果不在数据目录**，在线的目录和线所在的仓库里，原地不动。`csa ticket list --line <线>` 应该和 `board ticket list --line <线>` 列出一样的票。
- **判法哈希不变**：票头没写 `model`、`effort` 的票，`csa` 算出来的哈希和 `board` 一样，所以已经派出的票不会报 `contract-changed`。
- 第一次起 `csa queue run` 时，已经结束、还没写过事件的老作业，会各往 `events.jsonl` 补一行（不起钩子，钩子还没配）。要是想先配钩子，先跑 `csa queue config --on-end …`：这一步会把老作业记成「开钩子以前就结束了」，什么都不补。

### 切的步骤

1. **核对**。用 `csa` 读一遍，应该和 `board` 看到的一样：

   ```
   csa queue status --data-dir <原来的目录>
   csa patrol --data-dir <原来的目录>
   csa ticket list --line <线> --data-dir <原来的目录>
   ```

2. **试通**。排一个一秒就完的空作业，写上 `--line`：

   ```
   csa queue add --owner TEST --est 5s --line <线> --data-dir <原来的目录> -- <命令>
   ```

   用守护进程的后台作业开 `node <克隆目录>\bin\csa.mjs queue run --idle-exit 5 --data-dir <原来的目录>`（winhand：`job_start`）。再跑 `csa queue log <作业 id>` 看输出，最后 `csa queue ack <作业 id>`。
3. **改会话的命令**：
   - 告诉每个子会话和看门狗，从现在起 `board queue / ticket / gate / patrol` 一律换成 `node <克隆目录>\bin\csa.mjs …`，加 `--data-dir`；
   - 排作业带 `--line`；
   - 急停用 `csa queue pause`。

   看门狗的开场说明换成 v2.1 的 [watchdog.md](roles/watchdog.md)。
4. **从这时起，执行机上只用 `csa` 起排队程序，不再用 `board queue run`**。两边认同一个 `runner.json`，所以同一时间只会有一个排队程序在跑。但别让两个工具同时写排队和台账：Windows 上两边规范路径的写法不完全一样，台账锁的名字可能对不上。

### 回退：切回 `board`

1. `csa queue pause`，等在跑的停下（或者等它跑完）。然后用守护进程停掉 `csa` 的排队程序（winhand：`job_stop`）。
2. **处理 `board` 不认识的东西**：
   - 排着、带 `--if` 的作业：`board` 会**不检查就直接跑**。先 `csa queue cancel` 掉，回退以后用 `board queue add` 重排；
   - 急停：`board` 不认识，会照常开作业。确认 `csa queue status` 里 `paused` 是 null 以后再回退；不是，就先 `csa queue resume`，同时手上不留排着的作业；
   - 记成 `skipped` 的老作业：`board` 的排队页里显示不出状态名，不影响排队，可以不管；
   - `events.jsonl`、`config.json` 里的 `on_end`：`board` 不用，留着不碍事。
3. 用 `board queue run` 起排队程序，照旧告诉各会话换回 `board` 的命令。
4. `csa` 的克隆目录留着就行：它不在 PATH 里，也没改任何设置，不用卸。
