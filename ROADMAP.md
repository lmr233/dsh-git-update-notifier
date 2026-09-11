# Roadmap

## v0.2.0（开发中）

> 版本号已升至 `0.2.0-dev`。以下条目按预期价值排序，实际范围以发布时的 CHANGELOG 为准。

### 已完成（未发布）

- [x] **npx / npm 安装形态支持**：识别部署形态（源码 checkout / npx 缓存 / npm 安装），
  非源码形态改用 npm registry 比对版本并支持原地 `npm install` 升级；
  新增 `DSH_GIT_UPDATE_NOTIFIER_CHANNEL` 与 `DSH_GIT_UPDATE_NOTIFIER_REGISTRY` 两个环境变量。

### 计划

- [ ] **更新前预检**：把目前手工做的三项检查内置进卡片 —— 工作区是否干净、能否 `--ff-only` 快进、
  落后提交数；不满足时提前说明原因，而不是等 `git pull` 失败。
- [ ] **更新后引导重新构建**：检测构建产物是否滞后于源码（比对 `apps/cli/lib` 与源码 mtime / 版本），
  给出确切的重新构建命令，减少"拉取了但没生效"的困惑。
- [ ] **macOS 系统代理探测**：补齐 `scutil --proxy`，使代理自适应在三平台一致
  （当前仅 Windows 注册表 + 环境变量）。
- [ ] **设置界面**：接入 `settings.section` slot，提供检查开关、代理覆盖、上游分支、静默时段等配置，
  取代目前只能靠环境变量覆盖的方式。
- [ ] **检查历史与诊断日志**：记录最近 N 次检查与操作（时间、结果、是否经代理、耗时），
  在设置页可查看，便于排查"为什么今天没弹卡片"。
- [ ] **提交列表可展开**：卡片默认只显示若干条摘要，点开可查看完整列表，并尽量关联对应 CHANGELOG。

### 待讨论

- **进程常驻时的定时复查**：v0.1.0 只在"每天首次启动"检查。若需要长期常驻也能收到提醒，
  可增加可选的定时器（例如每 24h 一次），并与"每天首次"互斥避免重复打扰。
- **多 checkout / 多分支支持**：当前只跟踪本机 dsh 本体所在的那一个 checkout。
- **英文界面**：目前卡片与日志为中文，可接入 `locale` 服务做 i18n。
- **发布到 npm**：让使用者可以直接 `dsh plugin add dsh-git-update-notifier`，
  无需 `github:` 前缀（需要移除 `package.json` 的 `private: true`）。

## v0.1.0（已发布 · 2026-09-10）

源码 checkout 形态下的每日上游检查：git 比对、代理自适应、Web GUI 询问卡片、
`git pull --ff-only` 更新、loopback 受控路由、离线测试与 CI。
详见 [docs/releases/v0.1.0.md](docs/releases/v0.1.0.md)。
