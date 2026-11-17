# Changelog

本插件遵循 [Semantic Versioning](https://semver.org/)。日期为发布日期。

## [0.2.1] - 2026-11-17

### Added

- HTTP `POST /safety-restart/restart` 新增可选 `sessionId` 字段：带上即写续作标记，重启后该会话被 `followup` 自动唤醒并收到「重启过了」。此前 HTTP 入口硬编码不写续作标记（`fire('ui:'+reason, null)`），只有工具路径能触发完整回环——外部调用方（模型后台脚本、自动化任务）从此获得与工具路径相同的行为。不传 `sessionId` 则维持旧行为（纯重启、无接续）。

## [0.2.0] - 2026-11-17

开源化整理版本。核心逻辑与 0.1.5 一致（已在 DSH 0.2.2-rc.3 / Windows 桌面端完整端到端验证），本版不含行为变更，只有工程化改进与文档补全。

### Changed

- 设置页入口改挂 `settings.plugins.tab`（设置 → 插件 → 「安全重启」独立页）。此前的 `settings.plugin.item` 槽位在部分版本上不存在，卡片永远渲染不出来。
- 注释与文档专业化：去除会话痕迹，保留全部技术依据（每条注释仍对应实测结论）。

### Added

- `CHANGELOG.md`、完整 `README.md`（含排障表与已知限制）、`LICENSE` 双版权声明（原作者 + 贡献者）。
- `package.json` 补全仓库元数据（repository / bugs / homepage / keywords / files 白名单）。

### Fixed（回溯 0.1.x 系列，均已包含在本版）

- **桌面端 `app.relaunch()` 不可达**（宿主跑在 Electron utilityProcess 子进程，插件进程拿不到 `electron` 模块）：新增一次性 detached helper 兜底，关停走阶梯 —— WM_CLOSE → 宽限 3s → 仍活才 `taskkill /F` → 清理同 exe 孤儿子进程 → 按关闭前读取的真实命令行拉起新实例（剥掉 `ELECTRON_RUN_AS_NODE` 防假启动）。桌面壳"点 × = 藏托盘不死"（托盘常驻）是这一阶梯存在的原因。
- **续作消息不显身**：`agent.inject()` 只塞收件箱不唤醒驱动器；改用 `agent.followup()`（唤醒驱动器，会话里立刻显身）。
- **投递消息被 V4 校验拒收**：source 从 retired 的 `{kind:'plugin'}` 改为 producer-owned 的 `{kind:'plugin:dsh-safety-restart'}`。
- **熔断计数翻倍**：一次重启在审计里留多条记录，计数只认 `kind:"restart" && phase:"scheduled"` 那一条。
- **web 端 helper 起来后老进程不退**：老进程必须自己退出（helper 等的是"旧 pid 死掉"），`delayMs` 后 `process.exit(0)`。

## [0.1.5] - 2026-11-17

- 投递消息 source 改为 producer-owned 形状（`plugin:<name>`），通过 session format v4 校验。端到端验证通过。

## [0.1.4] - 2026-11-17

- 续作投递从 `inject` 改为 `followup` 优先（唤醒驱动器）；`followup` 不可用时退回 `inject`。

## [0.1.3] - 2026-11-17

- 桌面端 helper 关停阶梯：温和关窗 → 宽限 → 必要时强杀 → 清孤儿 → 按真实命令行拉起；拉起前剥离 `ELECTRON_RUN_AS_NODE`。

## [0.1.2] - 2026-11-17

- 桌面端 helper 兜底路径（`app.relaunch()` 不可达时），早期版本：温和关窗（后被托盘实证证死，由 0.1.3 阶梯取代）。

## [0.1.1] - 2026-11-16

- 客户端半声明注入 `@deepseek-ai/dsh-client-ui-settings`（无注入则客户端模块不会挂进设置页）。

## [0.1.0] - 2026-11-16

- 首版：`safety_restart` 工具、四道闸、续作标记、双端重启路径、审计日志、web/CLI 端口健康检查、46 条判定边界自检。
