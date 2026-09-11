# dsh-git-update-notifier

[![CI](https://github.com/lmr233/dsh-git-update-notifier/actions/workflows/ci.yml/badge.svg)](https://github.com/lmr233/dsh-git-update-notifier/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![powered by dsh](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

> 仓库：<https://github.com/lmr233/dsh-git-update-notifier> · MIT License

每天**首次启动 dsh** 时，用 git 检查 DeepSeek Harness 上游有没有新提交；有的话在 Web GUI 右下角弹一张卡片，**由你决定**是立即更新还是稍后再说。

## 为什么用 git，而不是查 npm

社区里已有多个"检查 dsh 更新"的插件（`dsh-update-checker`、`dsh-auto-update` 等），它们清一色对比 **npm registry 上的 `@deepseek-ai/dsh`**。这对本机不适用：

```
~/.dsh/profiles/node_modules/@deepseek-ai/dsh
  → Junction → <checkout>\apps\cli          # 只是指向源码 checkout 的链接
```

本机 dsh 本体跑的是**源码 checkout**（git remote 指向 `deepseek-ai/deepseek-harness`），所以：

- 查 npm 会**误报**——本地往往是 tag 之后又多走了若干提交的构建，npm 上并没有对应版本；
- "更新"若是执行 `npm install`，会**往源码仓库里装包**，破坏 pnpm workspace 的链接结构。

所以对**源码形态**，插件只做一件事：把这个 checkout 的提交推进到 `origin/<branch>`，全程不碰 npm、不碰 `node_modules`。

而对于 `npx @deepseek-ai/dsh web` 或 npm 安装出来的形态（拿到的是预构建包、没有 `.git`），则改用 npm registry 比对版本 —— 见[支持的安装形态](#支持的安装形态)。

## 行为

| 时机 | 动作 |
|---|---|
| 每日本地 **24 时** | 到点自动检查一次；若那时 dsh 没开着，启动后**补检**当天遗漏的一次。同一自然日内只检查一次 |
| 发现可更新 | 在 `shell.overlay`（整帧最上层，点击穿透）渲染询问卡片 |
| 点「立即更新」 | 源码形态执行 `git pull --ff-only origin <branch>`（只允许快进，绝不生成意外 merge commit）；npx / npm 形态执行 `npm install @deepseek-ai/dsh@<目标版本>` |
| 点「延期…」 | 选择 1 天 / 3 天 / 1 周 / 2 周 / **1 个月**；到期前不再弹浮层卡片，设置页仍可查看与手动更新（**上限一个月**，超出按上限处理） |
| 点「稍后」 | 当天不再询问；次日 24 时（或次日启动时的补检）重新检查 |
| 检查失败（如断网） | 弹一张**低调的失败卡片**（带原因与「重新检查」），而不是静默无反应 |

卡片的展示内容随形态变化：源码形态显示分支、**`本地版本 → 上游版本`**（两端都取自各自的 `package.json`，上游那份从 `FETCH_HEAD` 读取；读不到时回退到提交号）、落后提交数与上游提交摘要；npx / npm 形态显示发布通道与 `本地版本 → registry 版本`。两种形态都会显示安装方式与包位置。

### 设置页也有一个入口

除浮层卡片外，插件还在**设置 → 更新**注册了一个常驻区块（`settings.section` 席位）：

- **状态框**：当前状态（有可用更新 / 已是最新 / 检查失败）、安装方式、分支与**版本号**（源码形态为「当前版本 → 上游版本」）或发布通道与版本（npx / npm 形态）、上次与下次检查时间、包位置；
- **「手动检测更新」按钮**：随时触发一次检查，**不受「每天一次」限制**；
- **延期按钮**：可选择 1 天 / 3 天 / 1 周 / 2 周 / 1 个月，期间不再弹浮层卡片（设置页仍显示「已延期至」）；
- 检测到可更新时，额外出现「立即更新」按钮。

浮层卡片只在"需要你决定"时冒出来，设置页区块则随时可查 —— 两者读的是同一份状态。

## 支持的安装形态

插件会识别 dsh 的**实际部署形态**，据此选择检测源与更新动作：

| 形态 | 判定依据 | 检测源 | 更新动作 |
|---|---|---|---|
| 源码 checkout | 包位于含 `.git` 的仓库内 | git 上游提交 | `git pull --ff-only` |
| npx 缓存 | 路径含 `_npx`（`npx @deepseek-ai/dsh web` 的产物） | npm registry | 在缓存目录 `npm install` |
| npm 安装 | 其它 `node_modules` 安装 | npm registry | `npm install`（全局加 `-g`） |

为什么必须分开：源码形态比对 git 提交才是正确语义（查 npm 会误报，`npm install` 还会破坏 pnpm workspace 的链接结构）；而 npx / npm 安装拿到的是**预构建发布包**、没有 `.git`，只能也应该用 registry 版本比对。

形态优先通过 `process.argv[1]`（真正在跑的那份 bin 入口）识别 —— 它对源码启动、`npx` 启动、全局安装都成立；识别不到时才回退到 profile 里的 `@deepseek-ai/dsh` 链接。

npx 缓存的更新是**原地**的：缓存目录自带 `package.json`，在其中 `npm install @deepseek-ai/dsh@<版本>` 之后，下次 `npx @deepseek-ai/dsh web` 会复用同一缓存目录并跑到新版本。

### 发布通道

dsh 处于 developer preview，registry 上的 `latest` **常常不是最新** —— 实测有一段时间 `latest = 0.1.5-rc.1` 而 `next` 已是 `0.1.5-rc.2`。默认跟随 `latest`，需要跟进时可切换通道：

```sh
DSH_GIT_UPDATE_NOTIFIER_CHANNEL=next   # latest | next | alpha
```

### registry 镜像

网络受限时用镜像源（也能让测试指向本地 mock 以离线运行）：

```sh
DSH_GIT_UPDATE_NOTIFIER_REGISTRY=https://registry.npmmirror.com
```

## 代理

Windows 上 **git 不读取系统代理设置**，所以开了代理的机器往往依然连不上 GitHub。本插件**不修改你的任何 git 配置**，而是自己探测代理，只在自身的 git 调用里以 `-c http.proxy=...` 生效：

探测顺序：

1. `DSH_GIT_UPDATE_NOTIFIER_PROXY` —— 显式指定；设成 `none` / `off` / `direct` 可**彻底关闭代理探测**
2. 标准环境变量 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`
3. **Windows 系统代理**（Internet 选项注册表键）

细节：

- 每次检查都重新探测，所以你中途开关代理、换端口都能被立刻感知，无需重配置。
- **先试代理，失败自动回退直连**（同一候选内还会退避重试以吸收网络抖动）。
- 系统代理可能是 `127.0.0.1:7890`，也可能是 `http=a:1;https=b:2` 的分列形式；后者优先挑 `https`，`socks=` 会映射成 `socks5h://`（DNS 也走代理）。
- 探测到代理时会在日志里打印一行，便于确认走的是哪条路。

## 安装

本包是一个**组合包**（bundle）：`package.json` 里声明了 `dsh.bundle.patch`，profile 列出它时会应用 `cordis.patch.yml` 这一层。

### 从 GitHub 安装（推荐）

```sh
dsh plugin --profile web add github:lmr233/dsh-git-update-notifier
```

### 从本地目录安装

```sh
dsh plugin --profile web add <本包所在目录>
```

> 本包是纯手写 JavaScript、**没有构建步骤**，所以 git 安装拿到源码即可直接运行：
> 不需要 TypeScript 插件那样的 `prepare` 构建，也不需要 pnpm 的 `allowBuilds` 授权。

装完**重启 `dsh web`** 并刷新页面。

### 手动安装

把整个包目录复制进 `%USERPROFILE%\.dsh\profiles\web\node_modules\`，然后往
`%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-git-update-notifier
      name: 'dsh-git-update-notifier'
```

> 不要直接在 `~/.dsh/profiles` 下跑 `npm install`——那个目录没有 `package.json`，npm 会剪掉整个 `node_modules`。

### 改动宿主端代码后必须重启

宿主端的模块会被 Node 的 ESM 缓存持有，**卸载再重新挂载插件并不会重新 import 模块**（实测：把 `insert` 块删掉再加回来，插件确实卸载又加载了，但跑的还是旧代码）。所以 `lib/index.js` 的任何改动都需要重启 `dsh web` 才生效。客户端半（`lib/client.js`）不受此限，刷新页面即可。

### 验证配置层

```sh
dsh --profile web --dump-config   # 应能看到 dsh-git-update-notifier 这一层
```

## 配置

全部通过环境变量覆盖，无需改代码：

| 变量 | 作用 |
|---|---|
| `DSH_GIT_UPDATE_NOTIFIER_PROXY` | 指定代理；`none`/`off`/`direct` 表示关闭探测 |
| `DSH_GIT_UPDATE_NOTIFIER_ROOT` | 直接指定 `@deepseek-ai/dsh` 包目录（**独占**：设置后不再自动探测其它候选） |
| `DSH_GIT_UPDATE_NOTIFIER_CHANNEL` | npm registry 的发布通道，默认 `latest` |
| `DSH_GIT_UPDATE_NOTIFIER_REGISTRY` | registry 基址，默认 `https://registry.npmjs.org` |
| `DSH_HOME` | 决定状态文件位置（默认 `~/.dsh`） |

**checkout 是怎么找到的**：读取 `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh`，对其 `realpath`（解析 junction / 符号链接），再逐级上溯到第一个含 `.git` 的目录。因此没有任何硬编码路径，换机器也能自动适配。找不到时才需要 `DSH_GIT_UPDATE_NOTIFIER_ROOT`。

### 状态文件

`$DSH_HOME/dsh-git-update-notifier.json`：

```json
{
  "status": "update-available",
  "branch": "master",
  "localHead": "aa8262ec091698bae9a6b04773a6b5b06ad4aef2",
  "remoteHead": "c291e7961a515f6d7af9304e7fd1d257929aef26",
  "behind": 134,
  "subjects": ["c291e7961a ..."],
  "proxy": "http://127.0.0.1:7890",
  "viaProxy": true,
  "lastCheckDate": "2026-09-10",
  "dismissed": false
}
```

删掉它即可让插件在下次启动时重新检查。

## HTTP 路由（宿主端）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/dsh-git-update-notifier/status.json` | GET | 当前检查快照 |
| `/dsh-git-update-notifier/check` | POST | 强制重新检查（无视"今天已检查过"） |
| `/dsh-git-update-notifier/update` | POST | 执行 `git pull --ff-only` |
| `/dsh-git-update-notifier/dismiss` | POST | 当天不再询问 |

三个 POST 都要求来源是 loopback（`127.0.0.1` / `::1`），局域网里的其它客户端拿不到触发 git 操作的能力。

## 已知限制

- **更新后需要重新构建并重启才生效**。`git pull` 只推进源码；`dsh` 运行的是构建产物，拉取后需自行 `pnpm build:lib`（或对应构建命令）并重启 `dsh web`。卡片在更新成功后会明确提示这一点。
- **只做快进合并**。本地有未提交改动或分支已分叉时，`git pull --ff-only` 会失败并在卡片上显示原因，不会尝试自动解决。
- **进程常驻不重启时不会检查**。触发点是"每天首次启动"，长期不重启 dsh 就不会有新检查；可用卡片上的「重新检查」或直接 POST `/check` 手动触发。
- 需要 web profile：宿主端 `inject: ['webServer']`，在没有 web 服务的 profile 里会保持 PENDING。
- 代理自动探测目前覆盖 Windows（注册表）与环境变量；Linux 走环境变量，macOS 的系统代理（`scutil --proxy`）尚未覆盖。

## 卸载

```sh
dsh plugin --profile web remove dsh-git-update-notifier
```

再删掉 `$DSH_HOME/dsh-git-update-notifier.json`。

## 开发与验证

```sh
npm test                    # 跑完所有离线测试（CI 里用的就是这个）
npm run check               # 只做语法检查
npm run test:live           # 真实上游：经系统代理抓取真实 GitHub（依赖网络，不进 CI）

# 也可以单独跑某一个：
node test/proxy-parse.mjs    # 代理取值归一化（纯函数，不联网）
node test/client-render.mjs  # 客户端：模块协议登记、导出形态、卡片各状态与按钮请求
node test/local-check.mjs    # 宿主端：路由注册与 loopback 网关
node test/e2e-local-repo.mjs # 端到端：本地 bare 仓库验证检测→更新→失败时字段清空
```

`test/e2e-local-repo.mjs` 不依赖外网：它自己造一个 bare 仓库与两个 clone，让 local 落后 upstream 一个提交，然后用假 ctx 驱动真实的 `apply()`，断言 `behind=1`、`/update` 真的推进了 HEAD、当天第二次启动只跳过不重复检查，以及抓取失败时成功态字段（`behind`/`subjects`/`remoteHead`）会被清空。

## 目录结构

```
dsh-git-update-notifier/
├── package.json        # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml    # 插入本插件行的组合层
├── lib/
│   ├── index.js        # 宿主端：代理探测、git 检测、状态持久化、更新执行、HTTP 路由
│   └── client.js       # 客户端：手写 bundle，shell.overlay 询问卡片
└── test/               # 可独立运行的验证脚本
```

两半都是纯手写 JavaScript，**没有构建步骤**；客户端只 `require('react')`（由外壳的模块表提供）。

## 版本与路线图

- 当前版本：`0.2.0-dev`（v0.1.0 的完整归档见 [docs/releases/v0.1.0.md](docs/releases/v0.1.0.md)）
- 后续计划：[ROADMAP.md](ROADMAP.md)
- 变更记录：[CHANGELOG.md](CHANGELOG.md)
