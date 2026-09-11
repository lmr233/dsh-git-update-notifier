# dsh-git-update-notifier

[![CI](https://github.com/lmr233/dsh-git-update-notifier/actions/workflows/ci.yml/badge.svg)](https://github.com/lmr233/dsh-git-update-notifier/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-git-update-notifier.svg)](https://www.npmjs.com/package/dsh-git-update-notifier)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![powered by dsh](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

> 仓库：<https://github.com/lmr233/dsh-git-update-notifier> · MIT License
>
> 鉴于目前dsh更新频率高，但在目前的插件中并没有针对dsh更新推送的插件，所以制作了此插件用来检查并更新dsh，这是本人第一个作品，纯ai，如有意见可提出

每天**本地时间 24 时**检查一次 dsh 本体有没有更新（那时 dsh 没开着的话，下次启动时补检）；有的话在 Web GUI 右下角弹一张卡片，**由你决定**是立即更新、延期，还是稍后再说。更新本身支持**断点续传**（中断了就从断点接着下）、**安装前校验**（sha512 / sha1 / 包内身份三层）、**安装失败后的重试与回退**，以及**失败诊断**（完整现场落盘，可展开复制）。它也**检测自己**有没有新版 —— 见[插件自身的更新](#插件自身的更新)。当前版本 **`0.2.8`**。

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
| 点「立即更新」 | **先下载到本地（可断点续传）并校验**，再安装：源码形态执行 `git fetch` + `git merge --ff-only`（只允许快进，绝不生成意外 merge commit）；npx / npm 形态下载目标版本的 tarball、校验 `integrity` / `shasum` / 包内身份后，安装这份**校验过的本地包** |
| 更新中被打断 | 下载进度落在 `.part.json` 里 —— 网络断开、主动「中断下载」、甚至 dsh 重启，下次都**从断点继续**；「中断并丢弃断点」才从头再来 |
| 安装阶段失败 | 保留已校验的包并记下"更新前"的回退点，设置页给出「**重试安装**」（复用本地包，不重新下载）与「**回退到更新前**」两个按钮，并标出这是第几次尝试 |
| 任一阶段失败 | 把完整现场写进 `$DSH_HOME/dsh-git-update-notifier-logs/`：命令、退出码、完整 stdout / stderr、形态与路径、（合并失败时）`git status --short`。设置页给出诊断文件路径与「**查看完整报错**」，点开即可复制去检修 |
| 插件自己有新版 | 设置页显示「插件自身有新版：X → Y（来源）」，并给出「**更新插件**」；更新的是宿主端代码，所以同样要**重启 `dsh web`** |
| 点「延期…」 | 选择 1 天 / 3 天 / 1 周 / 2 周 / **1 个月**；到期前不再弹浮层卡片，设置页仍可查看与手动更新（**上限一个月**，超出按上限处理）；延期期间可随时「取消延期」恢复提醒 |
| 点「稍后」 | 当天不再询问；次日 24 时（或次日启动时的补检）重新检查 |
| 检查失败（如断网） | 弹一张**低调的失败卡片**（带原因与「重新检查」），而不是静默无反应 |

卡片的展示内容随形态变化：源码形态显示分支、**`本地版本 → 上游版本`**（两端都取自各自的 `package.json`，上游那份从 `FETCH_HEAD` 读取；读不到时回退到提交号）、落后提交数与上游提交摘要；npx / npm 形态显示发布通道与 `本地版本 → registry 版本`。两种形态都会显示安装方式与包位置。

### 设置页也有一个入口

除浮层卡片外，插件还在**设置 → 更新**注册了一个常驻区块（`settings.section` 席位）：

- **状态框**：当前状态（有可用更新 / 已是最新 / 检查失败）、安装方式、分支与**版本号**（源码形态为「当前版本 → 上游版本」）或发布通道与版本（npx / npm 形态）、上次与下次检查时间、包位置；
- **常驻结果行**：用一句人话写明最近一次检测的结论，例如「已是最新（`0.1.5-rc.2 @ c291e7961`）」或
  「发现新版本 `0.1.5-rc.1 → 0.1.5-rc.2`（上游领先 2 个提交）」。因此自动检测遇到「已是最新」时
  虽然不弹卡片，打开设置仍然看得见结论；
- **「手动检测更新」按钮**：随时触发一次检查，**不受「每天一次」限制**；点击后按钮变「检测中…」，
  完成后在区块内写明结果（成功或失败），不会"点了没反应"；
- **延期按钮（常驻）**：无论当前有没有更新都能点，可选 1 天 / 3 天 / 1 周 / 2 周 / 1 个月 —— 即使现在已是最新，也可以提前把未来一段时间的提醒压掉。期间不再弹浮层卡片（设置页显示「已延期至」），并可随时「**取消延期**」恢复提醒；
- 检测到可更新时，额外出现「立即更新」按钮。

浮层卡片只在"需要你决定"时冒出来，设置页区块则随时可查 —— 两者读的是同一份状态。

### 两半自检

插件的宿主半与客户端半**生效条件不同**：宿主半改动需要**重启 `dsh web`**，客户端半**刷新页面**即可。
两半各带一个 `CODE_VERSION` 常量（测试强制它们保持一致），版本对不上时设置页会直接说明原因：

> 插件两半版本不一致：宿主端（旧版，无版本标记），客户端 `0.2.0`。
> 宿主端的改动需要**重启 dsh web** 才生效（仅刷新页面不够）。

### 更新失败时的回退

更新是不可逆的写操作，因此做了三层保障：

1. **更新前**记录回退点 —— 源码形态记提交号，npx / npm 形态记版本号；
2. 更新成功后，在 `$DSH_HOME` 落一个**不依赖 dsh 运行**的回退脚本
   （`dsh-rollback.cmd` / `dsh-rollback.sh`）—— dsh 若起不来，插件自己也跑不起来，
   所以回退入口必须落在 dsh 之外；
3. dsh 能正常启动时，设置页显示「上次更新：X → Y」，并提供**常驻**的「**回退…**」入口：
   点开后自选目标 —— 源码形态列出上游最近的若干**版本号**（逐个取各提交自己的 `package.json`），
   npx / npm 形态列出已发布的历史版本 ——
   选中后按钮写明「确认回退到 X」再执行；不选目标时回退到上面记录的更新前那一刻。
   同时给出上面那个脚本的路径。
4. **安装失败也能回退**：回退点不再只在更新成功后记录 —— 安装阶段（`npm install` / 快进合并）
   失败时同样把它正式记下来，所以那一刻就能直接「回退到更新前」，而不必等到"更新成功之后"。
   失败现场还会保留已校验的包，供「重试安装」复用。

### 插件自身的更新

除了 dsh 本体，插件也**检测自己**有没有新版 —— 否则它就是个"只盯着别人的更新、自己却停在旧版"的工具。

难点在于**它是怎么被装进来的**：可能是 git 检出，可能是 profile 里声明的 `github:` 或 npm 依赖，也可能只是被手工复制进 `node_modules` 的一份副本。所以先判形态，再决定去哪儿问版本：

| 自身形态 | 判定依据 | 远端来源 | 「更新插件」的动作 |
|---|---|---|---|
| git 检出 | 自己所在目录（或上溯）有 `.git` | git 上游 | `git fetch` + `merge --ff-only` |
| npm 依赖 | 宿主清单里声明为本包（semver / `^` / `~`） | npm registry | `pnpm add` / `npm install`（按宿主目录的包管理器） |
| github 依赖 | 宿主清单里声明为 `github:` / git URL | GitHub | 同上，spec 为 `github:<仓库>#v<目标版本>` |
| 手工副本 | 目录在，但宿主清单里没有声明 | **只用 GitHub 兜底** | 不自动更新，给出手动做法 |

第三列的动作会**先判定宿主目录归谁管**：dsh 的 profile 是 pnpm 管理的，在那里跑 `npm install` 会打乱它的 `node_modules` 与 lockfile —— 所以有 `pnpm-workspace.yaml` / `pnpm-lock.yaml` 就走 `pnpm add`，否则才用 `npm install`。

关键在最后一行：手工副本没有任何声明可查，GitHub 的 release / tag 就成了唯一来源；而既然不知道这份副本从哪来，插件就**不做**自动替换，只如实说明并给出建议（例如 `dsh plugin add github:lmr233/dsh-git-update-notifier`）。

设置页会显示「插件自身已是最新（X）」或「插件自身有新版：X → Y（来源）」。这条检查与 dsh 本体的检查**互不影响** —— 它失败只记一条日志。

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

### 从 npm 安装（推荐）

```sh
dsh plugin --profile web add dsh-git-update-notifier
```

从 registry 安装不只是省事：插件的**自身更新检测**会因为能查到 npm 上的版本而更可靠 ——
GitHub 的匿名 API 每小时只有 60 次额度，共享出口 IP（校园网 / 公司网 / 运营商 NAT）很容易被耗尽，
届时「插件市场」和别处的更新检测都会失败。

### 从 GitHub 安装

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
| `DSH_GIT_UPDATE_NOTIFIER_GITHUB_API` | GitHub API 基址，默认 `https://api.github.com`（指向镜像或本地 mock；插件自身的更新检测用它） |
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
| `/dsh-git-update-notifier/update` | POST | 下载 + 校验 + 安装（源码形态为 `git fetch` + 快进合并） |
| `/dsh-git-update-notifier/progress.json` | GET | 更新在途进度与磁盘上的下载断点（供设置页轮询） |
| `/dsh-git-update-notifier/download/cancel` | POST | 中断下载：默认保留断点，`?discard=1` 连断点一起丢弃 |
| `/dsh-git-update-notifier/dismiss` | POST | 当天不再询问 |
| `/dsh-git-update-notifier/snooze?days=N` | POST | 延期 N 天（1–30，超出按上限；`days=0` 取消延期） |
| `/dsh-git-update-notifier/rollback` | POST | 回退：带 `?target=<提交号\|版本号>` 回退到指定目标，不带则回退到更新前记录的点 |
| `/dsh-git-update-notifier/plugin/update` | POST | 更新**插件自己**：git 检出走快进合并，npm / github 依赖走 `npm install`；手工副本明确拒绝 |
| `/dsh-git-update-notifier/diagnostics.json` | GET | 最近一次失败的完整现场（命令、退出码、完整输出），或磁盘上诊断文件的内容 |
| `/dsh-git-update-notifier/update/retry` | POST | 安装失败后**只重试安装**：复用已校验的本地包（源码形态复用 `FETCH_HEAD`），不重新下载 |
| `/dsh-git-update-notifier/rollback/targets.json` | GET | 列出可选回退目标（源码形态逐个读取提交自己的版本号展示，npx / npm 形态取历史版本） |

上面所有写路由都要求来源是 loopback（`127.0.0.1` / `::1`），局域网里的其它客户端拿不到触发 git 操作的能力。

## 已知限制

- **校验依赖 registry 提供凭据**。npm 官方的 `dist` 一定带 `integrity`（或至少 `shasum`）；如果某个镜像两者都不给，插件会**拒绝安装并说明原因**，而不是"假装校验通过"。
- **断点只对同一版本、同一 URL 有效**。目标版本变了（或 tarball 地址变了）就重新下载 —— 拼不同版本的字节没有意义。
- **更新后需要重新构建并重启才生效**。`git pull` 只推进源码；`dsh` 运行的是构建产物，拉取后需自行 `pnpm build:lib`（或对应构建命令）并重启 `dsh web`。卡片在更新成功后会明确提示这一点。
- **只做快进合并**。本地有未提交改动或分支已分叉时，快进合并会失败并在卡片上显示原因，不会尝试自动解决。
- **进程常驻不重启时按日定时触发**。触发点是**电脑本地时间每天 24 时**（启动时补检当天遗漏的那次），不是"每次启动"；可用设置页的「手动检测更新」或直接 POST `/check` 随时触发。
- 需要 web profile：宿主端 `inject: ['webServer']`，在没有 web 服务的 profile 里会保持 PENDING。
- 代理自动探测目前覆盖 Windows（注册表）与环境变量；Linux 走环境变量，macOS 的系统代理（`scutil --proxy`）尚未覆盖。

## 卸载

```sh
dsh plugin --profile web remove dsh-git-update-notifier
```

再删掉 `$DSH_HOME/dsh-git-update-notifier.json`、下载缓存目录 `$DSH_HOME/dsh-git-update-notifier-downloads/`（里面是已校验过的更新包与可能残留的 `.part` 断点），以及诊断日志目录 `$DSH_HOME/dsh-git-update-notifier-logs/`。

## 开发与验证

```sh
npm test                    # 跑完所有离线测试（CI 里用的就是这个）
npm run check               # 只做语法检查
npm run test:live           # 真实上游：经系统代理抓取真实 GitHub（依赖网络，不进 CI）

# 也可以单独跑某一个：
node test/proxy-parse.mjs    # 代理取值归一化（纯函数，不联网）
node test/download.mjs       # 下载器：断点续传的几条现实路径（本地 http server 扮演 tarball 端点）
node test/verify.mjs         # 包校验：篡改、身份不符、缺凭据（手写最小 UStar tar 构造用例）
node test/selfcheck.mjs      # 插件自身：形态判定（普通 / pnpm / github: 声明）与 GitHub 查询回退
node test/client-render.mjs  # 客户端：模块协议登记、导出形态、卡片各状态与按钮请求
node test/local-check.mjs    # 宿主端：路由注册与 loopback 网关
node test/e2e-local-repo.mjs # 端到端：本地 bare 仓库验证检测→更新→失败时字段清空
```

`test/download.mjs` 同样不依赖外网：本地 http server 可以按指令"发一半就掐断"、"忽略 `Range`"、"谎报区间"、"慢慢发以便中途取消"，于是续传的每条分支都被真实走了一遍。

`test/verify.mjs` 手写最小 UStar tar + gzip 造出合法的 npm tarball，再精确地篡改一个字节、改掉版本号、抽掉校验凭据，验证每种坏包都会被拦下。

`test/e2e-local-repo.mjs` 不依赖外网：它自己造一个 bare 仓库与两个 clone，让 local 落后 upstream 一个提交，然后用假 ctx 驱动真实的 `apply()`，断言 `behind=1`、`/update` 真的推进了 HEAD、当天第二次启动只跳过不重复检查，以及抓取失败时成功态字段（`behind`/`subjects`/`remoteHead`）会被清空。

## 目录结构

```
dsh-git-update-notifier/
├── package.json        # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml    # 插入本插件行的组合层
├── lib/
│   ├── index.js        # 宿主端：代理探测、形态识别、检测、状态持久化、更新/回退/重试、诊断日志、HTTP 路由
│   ├── download.js     # 带 Range 断点续传的下载器（跨进程断点、可取消）
│   ├── verify.js       # 更新包校验（sha512 / sha1 / 包内身份）与最小 tar 读取
│   ├── selfcheck.js    # 插件自身的定位、安装形态判定与 GitHub 版本查询
│   ├── registry.js     # registry 查询（dist-tags、单版本 manifest）
│   ├── semver.js       # 预发布排序的最小实现
│   └── client.js       # 客户端：手写 bundle，shell.overlay 询问卡片
└── test/               # 可独立运行的验证脚本
```

两半都是纯手写 JavaScript，**没有构建步骤**；客户端只 `require('react')`（由外壳的模块表提供）。

## 版本与路线图

- 当前版本：`0.2.9`（发布归档：[v0.2.9](docs/releases/v0.2.9.md)、[v0.2.8](docs/releases/v0.2.8.md)、[v0.2.7](docs/releases/v0.2.7.md)、[v0.2.6](docs/releases/v0.2.6.md)、[v0.2.5](docs/releases/v0.2.5.md)、[v0.2.0](docs/releases/v0.2.0.md)、[v0.1.0](docs/releases/v0.1.0.md)）
- 后续计划：[ROADMAP.md](ROADMAP.md)
- 变更记录：[CHANGELOG.md](CHANGELOG.md)
