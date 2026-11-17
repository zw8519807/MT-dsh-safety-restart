# dsh-safety-restart

**English TL;DR** — A safe, seamless restart plugin for DeepSeek Harness (DSH). The agent can restart the host itself — the only way host-half code changes take effect — and gets woken up in the original session afterwards to continue. Before restarting it must pass four gates: restart-loop breaker, other sessions mid-turn, unresolvable profile bundles, and no reliable relaunch means available. Any gate that fails means **refuse with a reason**, never force through. Desktop prefers Electron `app.relaunch()` and falls back to a one-shot detached helper that performs a ladder shutdown (graceful close → grace period → force kill if still alive → orphan cleanup) and respawns with the same command line; web/CLI uses a detached helper with a port health check. After the restart, the original session automatically receives a follow-up prompt.

---

DSH 的**安全无感重启**插件。

## 它解决什么

改完**宿主半**（`index.js` / `lib/*.js`）必须**整进程重启**才生效。这不是洁癖，是实测：

> 回收渲染器进程只会重载外壳。插件确实会重新 `apply`、日志也照打，**但服务请求的那张路由表仍然是更早那次 apply 的** —— 新加的路由一律 404，而返回的是插件自己那句 `not found`，看起来像"路由写错了"，其实是"根本没走到新 handler"。

而在此之前 agent 没有重启的手段：只能让用户去点。这个插件把它变成一次工具调用。

## 特性一览

- **四道安全闸**：任何一道不过都拒绝重启并说明原因（见下文）。
- **无感接续**：重启前写续作标记，重启后原会话自动收到一条续作提示并被唤醒，接着干没做完的事。
- **双端路径**：桌面端走 Electron 正路 / helper 兜底；web / CLI 端走 detached helper + 端口健康检查。
- **全程留痕**：每次重启的每一步（闸门判定、helper 动作、拉起结果）都追加进审计日志。
- **设置页卡片**：设置 → 插件 → 「安全重启」页，运行环境、熔断计数、最近审计、一键重启。
- **诚实失败**：拒绝时返回结构化 `{ refused, gate, why }`，模型能看懂"这是拒绝，不是失败"。

## 四道闸（"安全"具体是什么）

每一条都对应一次真实踩坑，不是设想出来的风险。

| 闸 | 拒绝条件 | 为什么 |
|---|---|---|
| **重启循环熔断** | 窗口内已重启 ≥ `loopMax`（默认 3 次 / 10 分钟） | 一个起不来的配置会让每次启动都失败，而 agent 看到失败只会想再重启 —— 那是重启风暴，代价是机器一直在 boot |
| **有别的会话在跑一轮** | 除调用方外还有会话处于 `turn/start` 之后未 `turn/end`（除非 `force: true`） | 盲着重启会把别人正在做的事**从中间切断**，而且切断后那一轮的工具调用结果未知 |
| **profile 的 bundle 表解析不了** | 某个 bundle 在 `node_modules` 里不存在、或入口文件不存在；**或者根本找不到 profile 根目录 / 读不到它的 bundle 表**（`checked:false` 一律拒绝） | 重启进一个坏掉的 profile，得到的是**起不来的 app** —— 连报错界面都没有；而"没查到"不等于"检查通过"—— 未知状态应当拒绝，不是绿灯 |
| **安排不出可靠的拉起手段** | 桌面端取不到主进程 pid / 写不了或起不了 helper | **绝不硬杀且不拉起**：把 app 关掉而不拉起来，是把可恢复的状态变成不可恢复的 |

任一不过就是**拒绝重启并说明原因**，返回里带 `gate` 与 `why`。拒绝不是失败 —— 那道闸就是为了不让你把环境弄成不好收拾的样子。

## 无感在哪

1. 重启前写**续作标记**（会话 id），重启后把"你已经重启过、请继续"投回**原来那个会话**。
   顺序是刻意的：**先写标记，再拉起**。反过来会在进程先退出时丢掉标记。
2. 投递用 `agent.followup()`（唤醒驱动器，会话里立刻显身）而不是 `agent.inject()`（只塞收件箱不唤醒 —— 实测消息会永远趴在收件箱里）。消息 source 用 producer-owned 形状 `plugin:dsh-safety-restart`，过 session format v4 校验。
3. 续作提示里明确要求：重启前**结果未知**的工具调用不要盲目重试，先核查实际影响。
4. 标记消费掉就删；标记文件损坏时返回空数组而不是抛 —— 重启后的启动不能因为读标记而挂。

## 两条重启路径

| 环境 | 机制 | 细节 |
|---|---|---|
| **桌面端**（Electron 内嵌宿主） | 优先 `app.relaunch()` + 延迟 `app.quit()`；不可达时**一次性 detached helper 兜底** | 在宿主跑于 Electron utilityProcess 子进程的版本上（如 0.2.2-rc.3），插件进程拿不到 `electron` 模块 —— 正路不可达。helper 的关停走**阶梯**：WM_CLOSE（点 × 语义）→ 宽限 3s → 仍活才 `taskkill /F` → 清理同 exe 的孤儿子进程（防双宿主抢 profile）→ 按关闭前尽力读取的**真实命令行**拉起新实例（并剥掉 `ELECTRON_RUN_AS_NODE`，防止新实例以纯 node 模式假启动）。桌面 webServer 端口每次启动都变，健康检查退化为"新进程活过 10 秒" |
| **web / CLI** | detached helper（`detached:true` + `stdio:'ignore'` + `unref()`），老进程随后自己退出 | helper 必须在**父进程死掉之后**继续活着；它等旧 pid 退出 → 用**同一份 `execPath` / `execArgv` / `argv`** 拉起新实例 → 等它活过 10 秒 → **若命令行里推得出 web 端口（`--port` 或默认 3080）再等端口恢复（健康检查）** → 把结果写进审计 |

**关停哲学**：红线不是"绝不硬杀"，而是"**绝不硬杀且不拉起**"。只要有续作标记在先、拉起命令在后，硬杀就是把"要重启"变成"重启完成"。helper 全链条仍守住：先温和 → 宽限 → 必要时才强杀 → 清孤儿 → 按真实命令行拉起；拉不起来就在审计里如实记失败，绝不假装成功。

## 装

要求：DSH ≥ 0.1.0-rc.6（`@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-llm` peer）。已在 **DSH 0.2.2-rc.3 / Windows 桌面端**完整验证。

```bash
# 方式一：npm pack 出 tgz 后装进 profile
npm pack   # 得到 dsh-safety-restart-x.y.z.tgz
# 用 DSH 的 plugin_manager install_bundle 指向该 tgz

# 方式二：git clone 后 link: 进 profile dependencies，并加进 dsh.profile.bundles
```

装完**必须重启一次** app —— 插件自己也要先被加载才谈得上重启。

## 用

Agent 侧（工具）：

```
safety_restart({ reason: "改了宿主半的 index.js，让新路由生效" })
safety_restart({ reason: "...", force: true })   // 即使有别的会话在跑一轮也重启
safety_restart({ reason: "...", delayMs: 3000 }) // 延迟退出，给结果回传留更多时间
```

人侧：设置 → 插件 → 「安全重启」页（运行环境、熔断计数、最近一次审计、立即重启）。

HTTP（web 端；**只接受本机请求**，反代/远程访问会被 403）：

```
GET  /safety-restart/status    # { ok, mode, loop, busy, audit, resumePending }
POST /safety-restart/restart   # body { "reason": "ui", "sessionId": "session-..."? }；被闸门拒绝返回 409 + 拒绝原因
                               # sessionId 可选：带上即写续作标记，重启后该会话自动接续（与工具路径同回环）；不传则纯重启
```

## 审计与状态文件

都在 `$DSH_HOME`（默认 `~/.dsh`）：

| 文件 | 内容 |
|---|---|
| `safety-restart-audit.jsonl` | 只追加。**一次重启算一次**的判定是 `kind:"restart" && phase:"scheduled"`；其余（`helper` / `exit` / `quit` / `refused` / `resume` / `relaunch`）都是诊断信息 |
| `safety-restart-resume.json` | 续作标记（待叫醒的会话 id），消费后删除 |
| `safety-restart-helper.mjs` | 每次重启前生成的一次性 helper（自覆盖） |
| `safety-restart.json` | 可选配置（见下） |

## 配置

```json
{
  "loopWindowMs": 600000,
  "loopMax": 3,
  "delayMs": 1500,
  "busyStaleMs": 1800000
}
```

| 键 | 含义 |
|---|---|
| `loopWindowMs` | 熔断计数窗口（默认 10 分钟） |
| `loopMax` | 窗口内允许的真重启次数（默认 3） |
| `delayMs` | "发起重启"到"真的退出"之间的等待，留出时间把工具结果回传给模型。设成 0 会让结果大概率丢掉 |
| `busyStaleMs` | busy 记录的过期时间（默认 30 分钟），防止一条漏掉的 `turn/end` 把闸门永久焊死 |

## 已知限制（如实写，不粉饰）

- **桌面端关停阶梯是 Windows 专属**（`taskkill` + PowerShell CIM 读命令行/枚举子进程）。桌面 DSH 本身就主要跑在 Windows；web / CLI 端的"等退出 + 同命令行拉起"路径是跨平台的。
- **`busy` 只覆盖本进程启动之后的轮次。** 它是按 `session/event` 维护的，更早就在跑的会话不在里面。所以第二道闸是"尽力而为"，不是权威快照。
- **bundle 体检是轻量的**：它只证明"包在、入口文件在"，**不证明它能被 import 成功**，更不证明客户端半在 slot 契约上是对的。要那一层需要完整的 bundle scan。
- **web 健康检查是"端口恢复"，不是"HTTP 200"。** helper 只做 TCP 连接探测。它证明的是 *web 在监听*，不是 *web 健康*。端口怎么推：`--port <n>` / `--port=<n>` 优先，否则 argv 里有 `web` 子命令默认 3080，推不出来就跳过健康检查退回 10 秒存活检查。**宁可不探测也不探测错误的端口**。
- **web 端退出是 `process.exit(0)`（非优雅）。** 会话日志是只追加的 jsonl，写到哪算哪；工具结果在 `delayMs` 之前已回传；尾巴真被截了也有续作提示兜。不退就永远重启不成，那才是真的坏。
- **客户端半按当前版本验证过的契约写，并带防御**：slot 注册同时给 `id` 与 `key`（兼容 list / keyed 两类契约），整个 `apply` 包在 try/catch 里 —— 契约再漂，结果也只是"没有这一页"，不会牵连界面。

## 排障

| 现象 | 先看什么 |
|---|---|
| 工具返回 `refused: true` | 返回里的 `gate` + `why` 就是答案；审计日志里有完整判定链 |
| 重启后没有续作提示 | 看 `safety-restart-resume.json` 是否还在（还在 = 目标会话没出现）；审计里找 `resume` 条目 |
| helper 报 `old pid still alive — giving up` | 桌面端强杀也失败了（权限/安全软件拦截）；如实失败，不会硬拉 —— 手动重启后查 `taskkill` 被拦原因 |
| 新实例"活着但 app 没起来" | 审计里有 `spawned pid ... alive` 但界面没出 —— 检查是否环境带了 `ELECTRON_RUN_AS_NODE`（插件已自动剥离，出现此象说明路径异常） |

## 自检

```bash
node scripts/run-all.mjs
```

46 条断言，都是"闸门的判定边界"：熔断窗口与计数口径、`checked:false` 的诚实降级、标记损坏不抛、生成的 helper 是合法 ESM（含带健康检查端口的变体与关停阶梯变体）、`--port` 推端口的解析规则、调用方自身的排除等（其中依赖 `@deepseek-ai/dsh-tools` 的一组在未装该 peer 的环境自动跳过）。

## 更新日志

见 [CHANGELOG.md](./CHANGELOG.md)。

## 致谢与许可

基于 [Dayi-Z/dsh-safety-restart](https://github.com/Dayi-Z/dsh-safety-restart)（MIT）重构与扩展：阶梯关停、续作接续、bundle 体检、设置页与自检体系均在本仓库中演化。感谢原作者的开源工作。

MIT — 见 [LICENSE](./LICENSE)。
