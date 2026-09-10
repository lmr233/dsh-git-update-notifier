# Changelog

本文件记录本插件的所有值得注意的变更。
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)，结构参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
