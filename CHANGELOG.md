# Changelog

本文件记录本插件的所有值得注意的变更。
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)，结构参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### 变更

- **每日检查的触发点改为本地 24 时**：不再只在启动时检查，而是每日本地 24 时定时触发。
  同时保留**启动补检**（今天还没检查过就补一次），避免 dsh 在午夜没开着时整天漏检。
  快照新增 `nextCheckAt` 字段，展示下次检查时间。

### 新增

- **npx / npm 安装形态支持**：识别 dsh 的部署形态（源码 checkout / npx 缓存 /
  npm 全局或项目安装），非源码形态改用 **npm registry** 比对版本，并支持在原地
  执行 `npm install` 升级。版本比较正确处理 rc / alpha 预发布排序（`rc.10 > rc.9`）。
- 新增两个环境变量：`DSH_GIT_UPDATE_NOTIFIER_CHANNEL`（`latest` / `next` / `alpha`）
  与 `DSH_GIT_UPDATE_NOTIFIER_REGISTRY`（指向镜像源）。

### 计划中

- 更新前预检：工作区是否干净、能否 `--ff-only` 快进
- 更新后引导重新构建，减少"拉取了但没生效"
- macOS 系统代理探测（`scutil --proxy`）
- 设置界面：检查开关、代理覆盖、上游分支
- 检查历史与诊断日志

详见 [ROADMAP.md](ROADMAP.md)。

## [0.1.0] - 2026-09-10

首个可用版本。

### 新增

- **宿主端每日检查**：每天首次启动时用 git 比对上游提交
  （`git fetch` + `git rev-list --count`），并按自然日去重——同一天内多次重启
  不重复检查，也不重复打扰。
- **代理自适应**：自动探测系统代理（Windows 注册表 / 标准环境变量），
  只在自身的 git 调用里以 `-c http.proxy` 生效，**不修改用户的任何 git 配置**；
  先试代理、失败回退直连；每次检查重新探测，中途开关代理能立刻感知。
- **checkout 定位**：解析 `$DSH_HOME/profiles/.../@deepseek-ai/dsh` 的 realpath
  （穿透 junction / 符号链接）再上溯到含 `.git` 的目录，无硬编码路径。
- **更新执行**：`git pull --ff-only`，只允许快进合并；因本机 dsh 本体是源码
  checkout，全程不碰 npm 与 `node_modules`。
- **HTTP 路由**：`status.json` / `check` / `update` / `dismiss`；
  三个写操作要求来源为 loopback，避免局域网客户端触发 git 操作。
- **客户端询问卡片**：手写 bundle（无构建步骤）注册到 `shell.overlay`，
  提供「立即更新 / 稍后 / 重新检查」，并展示分支、`短SHA → 短SHA`、
  落后提交数与上游提交摘要。
- **测试**：本地 bare 仓库端到端、客户端渲染、代理取值归一化、真实上游验证。

### 说明

- 检查失败（断网、代理不可用等）同样会显示卡片并给出「重新检查」，
  而不是静默无反应。
- 宿主端（`lib/index.js`）的改动需要重启 `dsh web` 才生效——Node 的 ESM
  模块缓存会持有已加载模块，卸载再重新挂载插件也不会重新 import。
  客户端半（`lib/client.js`）不受此限，刷新页面即可。

[0.1.0]: https://github.com/lmr233/dsh-git-update-notifier/releases/tag/v0.1.0
