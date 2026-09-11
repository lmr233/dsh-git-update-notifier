/**
 * dsh-git-update-notifier — 宿主端（node half）。
 *
 * 职责：
 * 1. 每日本地 **24 时**检查一次 dsh 本体是否有更新，并在 Web GUI 中询问；
 *    若 dsh 在午夜时没开着，启动后补检当天遗漏的那一次（去重按自然日）。
 * 2. 识别 dsh 的**部署形态**，据此选择检测源与更新动作：
 *
 *    | 形态     | 判定依据                    | 检测源       | 更新动作                 |
 *    |----------|-----------------------------|--------------|--------------------------|
 *    | `source` | 本包位于含 `.git` 的仓库内   | git 上游提交 | `git pull --ff-only`     |
 *    | `npx`    | 路径含 `_npx`（npx 缓存）    | npm registry | 在缓存目录 `npm install`  |
 *    | `npm`    | 其它 node_modules 安装       | npm registry | `npm install`（全局加 `-g`） |
 *
 *    源码形态下比对 git 提交才是正确语义（查 npm 会误报，`npm install` 还会破坏
 *    pnpm workspace 的链接结构）；而 npx / npm 安装拿到的是预构建发布包，没有
 *    `.git`，只能、也应该用 registry 版本比对。
 * 3. 通过 `ctx.webServer` 暴露只读/受控路由，供浏览器侧询问卡片使用；
 *    真正修改文件的动作（git pull / npm install）必须由用户点击触发。
 *
 * 代理：Windows 上 git 与 npm **都不读取系统代理设置**，因此插件自行探测系统代理，
 * 只在自身的子进程调用里生效（git 用 `-c http.proxy=…`，npm 用子进程环境变量），
 * **不修改用户的任何全局配置**。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { isNewer } from './semver.js'
import { fetchDistTags } from './registry.js'

export const name = 'dsh-git-update-notifier'

/** 需要 web 服务来承载询问卡片；没有 web 服务的 profile 会保持 PENDING（预期行为）。 */
export const inject = ['webServer']

/** 被跟踪的包：既用于定位本体，也用于 registry 查询。 */
const PACKAGE_NAME = '@deepseek-ai/dsh'

/** 路由前缀。webserver 的具名路由互不相交，取一个专属前缀即可。 */
const ROUTE_PREFIX = '/dsh-git-update-notifier'

/** 启动后延迟多久开始检查，避开 boot 高峰。 */
const STARTUP_DELAY_MS = 5_000

/** 单条子进程命令的超时。联网命令会重试，所以这里给足余量。 */
const COMMAND_TIMEOUT_MS = 120_000

/** npm install 需要下载与解包，给更长的超时。 */
const NPM_TIMEOUT_MS = 300_000

/** 同一个候选路径（经代理 / 直连）内的 `git fetch` 尝试次数。 */
const FETCH_ATTEMPTS = 2

/** 上游提交摘要最多展示多少条。 */
const MAX_SUBJECTS = 20

/** 延期上限：一个月。再多也按上限处理，避免被写成“永不提醒”。 */
const SNOOZE_MAX_DAYS = 30

/**
 * 插件两半的代码版本标记。
 *
 * 宿主半与客户端半的生效条件不同（宿主需重启 dsh，客户端刷新即可），所以用一个
 * 显式常量让两半互相对照：对不上时由设置页提示"该重启还是该刷新"。
 * 测试会断言两处常量一致，避免忘记同步。
 */
const CODE_VERSION = '0.2.0-dev.4'

/** 状态文件与插件同名。 */
const STATE_BASENAME = 'dsh-git-update-notifier.json'

/** 显式关闭代理探测的取值（`DSH_GIT_UPDATE_NOTIFIER_PROXY`）。 */
const PROXY_DISABLED = new Set(['none', 'off', 'direct', 'no', 'disable', 'disabled'])

/** Windows 系统代理所在的注册表键。 */
const WINDOWS_PROXY_KEY
  = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** npm 在 Windows 上是 .cmd 包装，spawn 不会自动补扩展名。 */
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm'

// ---------------------------------------------------------------------------
// 路径与状态文件
// ---------------------------------------------------------------------------

/** `$DSH_HOME`，与 harness 其余部分保持同一套回退。 */
function homeDir() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

function stateFile() {
  return join(homeDir(), STATE_BASENAME)
}

/** 读状态；文件缺失或损坏都退化成空对象，绝不因为状态文件让插件激活失败。 */
function readState() {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    // 首次运行或文件损坏：按空状态处理。
  }
  return {}
}

/** 写状态；失败只记日志，不影响插件其余功能。 */
function writeState(next, say) {
  try {
    const file = stateFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return true
  } catch (error) {
    say('warn', `写入状态文件失败：${describe(error)}`)
    return false
  }
}

/** 本地日期（YYYY-MM-DD）。每日检查按用户所在时区的自然日判定。 */
function today() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * 距离下一个本地 00:00（也就是今天的 24 时）还有多少毫秒。
 *
 * 用 Date 自身的进位规则实现：把小时设成 24 会自然滚到次日零点，
 * 因此夏令时切换等本地时间异常交给运行时处理，不必自己算。
 */
export function msUntilNextMidnight(now = new Date()) {
  const next = new Date(now.getTime())
  next.setHours(24, 0, 0, 0)
  return next.getTime() - now.getTime()
}

/** 延期是否仍然有效（为空或已过期都视为未延期）。 */
function isSnoozed(snoozeUntil) {
  if (typeof snoozeUntil !== 'string' || snoozeUntil === '') return false
  const until = new Date(snoozeUntil).getTime()
  return Number.isFinite(until) && until > Date.now()
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

/** 读取某个 dsh 包目录里的版本号。 */
function readPackageVersion(packageDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 定位 dsh 本体并判定部署形态
// ---------------------------------------------------------------------------

function realpathOf(path) {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** 从 `start` 逐级上溯，返回第一个含 `.git` 的目录。 */
function findGitRoot(start) {
  let current = resolve(start)
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/** 从任意起点（bin 入口或包目录）上溯，找到 `@deepseek-ai/dsh` 的包目录。 */
function findDshPackage(startPath) {
  let current = resolve(startPath)
  for (let depth = 0; depth < 10; depth += 1) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
        if (parsed.name === PACKAGE_NAME && typeof parsed.version === 'string') {
          return { dir: current, version: parsed.version }
        }
      } catch {
        // 忽略无法解析的 package.json，继续上溯。
      }
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/**
 * 找到"拥有这个 node_modules 的项目根"。
 *
 * - npx 缓存：`.../_npx/<hash>/node_modules/@deepseek-ai/dsh` → `_npx/<hash>`（有 package.json）
 * - 本地项目依赖：向上找到项目根
 * - 全局安装：一路到根都找不到 → 返回 undefined（据此判定为全局）
 */
function findProjectRoot(packageDir) {
  let current = dirname(packageDir)
  for (let depth = 0; depth < 8; depth += 1) {
    if (basename(current) !== 'node_modules' && existsSync(join(current, 'package.json'))) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/** 按路径特征判定形态。 */
function classifyLayout(packageDir) {
  const normalized = packageDir.replace(/\\/g, '/').toLowerCase()
  if (normalized.includes('/_npx/')) return 'npx'
  if (findGitRoot(packageDir) !== undefined) return 'source'
  return 'npm'
}

/**
 * 定位正在运行的 dsh 本体并判定形态。
 *
 * 首选 `process.argv[1]` —— 它直接指向真正在跑的那份 bin 入口，
 * 无论用户是源码启动、`npx` 启动还是全局安装。拿不到时才回退到
 * `$DSH_HOME/profiles/<profile>/node_modules/@deepseek-ai/dsh` 这条链接。
 */
function detectLayout() {
  let candidates = []

  const binPath = process.argv[1]
  if (typeof binPath === 'string' && binPath.trim() !== '') candidates.push(binPath)

  const home = homeDir()
  for (const linked of [
    join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh'),
    join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh'),
  ]) {
    const real = realpathOf(linked)
    if (real !== undefined) candidates.push(real)
  }

  // 显式指定时**独占**：不再回退到 argv / profile。否则既无法强制指向某个
  // 特定安装，测试也就没有可靠的隔离手段。
  const override = process.env.DSH_GIT_UPDATE_NOTIFIER_ROOT
  if (typeof override === 'string' && override.trim() !== '') candidates = [override.trim()]

  for (const candidate of candidates) {
    const found = findDshPackage(candidate)
    if (found === undefined) continue
    const kind = classifyLayout(found.dir)
    const projectRoot = kind === 'source' ? undefined : findProjectRoot(found.dir)
    return {
      kind,
      packageDir: found.dir,
      version: found.version,
      gitRoot: kind === 'source' ? findGitRoot(found.dir) : undefined,
      projectRoot,
      global: kind === 'npm' && projectRoot === undefined,
    }
  }
  return undefined
}

/** 部署形态的中文名，用于日志与卡片。 */
function layoutLabel(layout) {
  if (layout.kind === 'source') return '源码 checkout'
  if (layout.kind === 'npx') return 'npx 缓存'
  return layout.global ? 'npm 全局安装' : 'npm 项目依赖'
}

// ---------------------------------------------------------------------------
// 子进程
// ---------------------------------------------------------------------------

/**
 * 运行一条外部命令。永不抛错：把失败折叠成 `{ code, stdout, stderr }`，
 * 让调用方按业务语义处理（超时、非零退出、命令不存在）。
 */
function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS
  return new Promise((done) => {
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        windowsHide: true,
        shell: options.shell === true,
        env: {
          ...process.env,
          ...options.env,
          // 绝不因为缺少凭证而在后台请求输入。
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          // 提交摘要里不要转义非 ASCII 路径。
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.quotepath',
          GIT_CONFIG_VALUE_0: 'false',
          // 让 npm 也走同一份代理探测结果（npm 同样不读 Windows 系统代理）。
          ...(options.proxy === undefined
            ? {}
            : {
                HTTP_PROXY: options.proxy,
                HTTPS_PROXY: options.proxy,
                http_proxy: options.proxy,
                https_proxy: options.proxy,
              }),
        },
      })
    } catch (error) {
      done({ code: -1, stdout: '', stderr: describe(error) })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (code, extra) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done({ code, stdout, stderr: extra === undefined ? stderr : `${stderr}${extra}` })
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 进程可能已退出。
      }
      finish(-1, `\n[超时] ${command} ${args.join(' ')} 超过 ${timeoutMs}ms`)
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      finish(-1, `\n${describe(error)}`)
    })
    child.on('close', (code) => {
      finish(code === null ? -1 : code)
    })
  })
}

/**
 * 运行 git。`proxy` 给出时，用 `-c` 在本次调用内生效——不写入任何
 * 全局或仓库级 git 配置，用户的环境保持原样。
 */
function runGit(args, cwd, proxy) {
  const gitArgs = proxy === undefined
    ? args
    : ['-c', `http.proxy=${proxy}`, '-c', `https.proxy=${proxy}`, ...args]
  return runCommand('git', gitArgs, { cwd })
}

/**
 * 运行 npm；代理通过子进程环境变量传入。
 *
 * Windows 上 npm 是 `.cmd` 包装，Node 不允许不带 shell 直接 spawn（会 EINVAL），
 * 所以这里需要 `shell: true`。启用 shell 意味着参数会被拼进命令行，因此先做一次
 * 白名单校验：版本号来自 registry，受 semver 约束，只有整体安全时才走 shell。
 */
function runNpm(args, cwd, proxy) {
  const shellSafe = process.platform === 'win32'
    && args.every((arg) => /^[A-Za-z0-9@._/:=+-]+$/.test(arg))
  return runCommand(NPM_COMMAND, args, {
    cwd,
    proxy,
    timeoutMs: NPM_TIMEOUT_MS,
    shell: shellSafe,
  })
}

/** 报错时只保留尾部若干行，避免把整段输出塞进 UI。 */
function tail(text, maxLines = 6) {
  const lines = String(text).trim().split(/\r?\n/).filter((line) => line !== '')
  return lines.slice(-maxLines).join('\n')
}

// ---------------------------------------------------------------------------
// 代理探测（不修改任何持久配置）
// ---------------------------------------------------------------------------

/**
 * 归一化代理取值。
 *
 * 系统代理可能是 `127.0.0.1:7890`，也可能是 `http=a:1;https=b:2` 这种
 * 按协议分列的形式。测试里直接调用它。
 */
export function normalizeProxy(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return undefined

  const withScheme = (scheme, value) => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
    // socks5h 让 DNS 也走代理，直连被污染的域名时更可靠。
    if (scheme.startsWith('socks')) return `socks5h://${value}`
    return `http://${value}`
  }

  if (!text.includes('=')) return withScheme('http', text)

  const byScheme = new Map()
  for (const chunk of text.split(';')) {
    const trimmed = chunk.trim()
    if (trimmed === '') continue
    const at = trimmed.indexOf('=')
    if (at < 0) continue
    byScheme.set(trimmed.slice(0, at).trim().toLowerCase(), trimmed.slice(at + 1).trim())
  }
  // 本插件只访问 https 的 GitHub / npm registry，优先挑 https，其次 http，最后 socks。
  for (const scheme of ['https', 'http', 'socks5', 'socks', 'socks4']) {
    const value = byScheme.get(scheme)
    if (value !== undefined && value !== '') return withScheme(scheme, value)
  }
  return undefined
}

/** 环境变量里的代理；插件自己的变量优先级最高。 */
function proxyFromEnv() {
  const names = [
    'DSH_GIT_UPDATE_NOTIFIER_PROXY',
    'HTTPS_PROXY', 'https_proxy',
    'HTTP_PROXY', 'http_proxy',
    'ALL_PROXY', 'all_proxy',
  ]
  for (const name of names) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** Windows 系统代理（Internet 选项）。中文/英文 Windows 的值名同为 ASCII。 */
async function probeWindowsProxy() {
  if (process.platform !== 'win32') return undefined
  const result = await runCommand('reg', ['query', WINDOWS_PROXY_KEY])
  if (result.code !== 0) return undefined
  if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(result.stdout)) return undefined
  const match = result.stdout.match(/ProxyServer\s+REG_SZ\s+(.+)/i)
  return match === null ? undefined : normalizeProxy(match[1].trim())
}

/**
 * 解析本次要用的代理。
 *
 * 优先级：`DSH_GIT_UPDATE_NOTIFIER_PROXY`（显式覆盖，设成 none/off/direct
 * 可彻底关闭探测）→ 标准代理环境变量 → Windows 系统代理。
 * 每次检查都重新探测，因此用户中途开关代理能立刻被感知。
 */
async function detectProxy(log = () => {}) {
  const raw = process.env.DSH_GIT_UPDATE_NOTIFIER_PROXY
  if (typeof raw === 'string' && PROXY_DISABLED.has(raw.trim().toLowerCase())) return undefined

  const fromEnv = proxyFromEnv()
  if (fromEnv !== undefined) {
    const normalized = normalizeProxy(fromEnv)
    if (normalized !== undefined) return normalized
  }

  const system = await probeWindowsProxy()
  if (system !== undefined) {
    log('info', `检测到系统代理：${system}（仅用于本插件的子进程调用，不改动你的 git / npm 配置）`)
  }
  return system
}

function describeRoute(proxy) {
  return proxy === undefined ? '直连' : `经代理 ${proxy}`
}

/** npm registry 的发布通道，可用环境变量切换（dsh 的 latest 常落后于 next）。 */
function channelName() {
  const fromEnv = process.env.DSH_GIT_UPDATE_NOTIFIER_CHANNEL
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return 'latest'
}

// ---------------------------------------------------------------------------
// 检查结果
// ---------------------------------------------------------------------------

/**
 * 构造一次检查结果。
 *
 * 每个分支都返回**同一组字段**（不适用的显式置 null）：状态文件是按
 * 「旧状态 + 本次增量」合并写出的，字段不齐就会把上一轮的结论残留下来
 * （例如换了安装形态，却仍显示上一次的 git 落后数）。
 */
function checkResult(fields) {
  return {
    status: 'error',
    layout: null,
    source: null,
    packageDir: null,
    localVersion: null,
    remoteVersion: null,
    // git 侧
    branch: null,
    localHead: null,
    localSubject: null,
    localDate: null,
    remoteHead: null,
    behind: null,
    subjects: [],
    // npm 侧
    channel: null,
    target: null,
    tags: null,
    installKind: null,
    // 通用
    proxy: null,
    viaProxy: false,
    message: null,
    hint: null,
    snoozeUntil: null,
    checkedAt: new Date().toISOString(),
    ...fields,
  }
}

// ---------------------------------------------------------------------------
// 检查：源码形态走 git
// ---------------------------------------------------------------------------

/**
 * 读取某个 git ref 上的 dsh 版本号。
 *
 * 用「包目录相对仓库根」的路径去取，因此不依赖 checkout 的具体结构；
 * 读不到时返回 undefined，由调用方回退到提交号展示。
 */
async function readVersionAtRef(root, packageDir, ref) {
  const relativeDir = relative(root, packageDir).replace(/\\/g, '/')
  const manifest = relativeDir === '' ? 'package.json' : `${relativeDir}/package.json`
  const result = await runGit(['show', `${ref}:${manifest}`], root)
  if (result.code !== 0) return undefined
  try {
    const parsed = JSON.parse(result.stdout)
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/** 读取当前分支名；detached HEAD 时 rev-parse 会返回 HEAD。 */
async function currentBranch(root) {
  const result = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root)
  if (result.code !== 0) return { ok: false, message: tail(result.stderr) }
  const branch = result.stdout.trim()
  return { ok: true, branch: branch === '' ? 'HEAD' : branch }
}

/**
 * 抓取上游。`git fetch` 只写 `.git`（更新 FETCH_HEAD 与远端跟踪引用），
 * 不碰工作区，所以这一步可以无人值守地每天做一次。
 *
 * 先试探测到的代理，再回退直连；同一候选内做退避重试以吸收网络抖动。
 */
async function fetchUpstream(root, branch, log, proxy) {
  const candidates = proxy === undefined ? [undefined] : [proxy, undefined]
  let last = { code: -1, stdout: '', stderr: '' }

  for (const [index, candidate] of candidates.entries()) {
    const tries = index === 0 ? FETCH_ATTEMPTS : 1
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      last = await runGit(['fetch', '--quiet', '--no-tags', 'origin', branch], root, candidate)
      if (last.code === 0) return { ok: true, proxy: candidate, attempts: attempt }
      if (attempt < tries) {
        const wait = attempt * 2_000
        log('warn', `${describeRoute(candidate)} git fetch 第 ${attempt}/${tries} 次失败，`
          + `${wait}ms 后重试：${tail(last.stderr, 2)}`)
        await delay(wait)
      }
    }
    if (index === 0 && candidates.length > 1) {
      log('warn', `${describeRoute(candidate)} 抓取失败，回退直连再试一次`)
    }
  }

  return { ok: false, attemptedProxy: proxy, stderr: last.stderr }
}

/** 源码形态：比对 git 上游提交。 */
async function inspectSource(layout, { log, proxy }) {
  const root = layout.gitRoot
  const common = {
    layout: layout.kind,
    source: 'git',
    packageDir: layout.packageDir,
    localVersion: layout.version,
    proxy,
  }

  const branchInfo = await currentBranch(root)
  if (!branchInfo.ok) {
    return checkResult({ ...common, message: `读取当前分支失败：${branchInfo.message}` })
  }
  const { branch } = branchInfo

  const localHead = (await runGit(['rev-parse', 'HEAD'], root)).stdout.trim()
  const localSubject = (await runGit(['log', '-1', '--pretty=format:%s'], root)).stdout.trim()
  const localDate = (await runGit(['log', '-1', '--date=short', '--pretty=format:%ad'], root)).stdout.trim()
  const local = { ...common, branch, localHead, localSubject, localDate }

  const fetched = await fetchUpstream(root, branch, log, proxy)
  if (!fetched.ok) {
    return checkResult({
      ...local,
      message: `git fetch origin ${branch} 抓取失败（${describeRoute(proxy)}）：${tail(fetched.stderr)}`,
      hint: proxy === undefined
        ? '请确认这台机器能访问远端；若已开启代理，可用 DSH_GIT_UPDATE_NOTIFIER_PROXY 显式指定代理地址。'
        : `已尝试经代理 ${proxy} 与直连。请确认代理是否可用，或用 DSH_GIT_UPDATE_NOTIFIER_PROXY 覆盖。`,
    })
  }

  const remoteHead = (await runGit(['rev-parse', 'FETCH_HEAD'], root)).stdout.trim()
  // 上游版本号：FETCH_HEAD 刚被 fetch 更新，此刻读取才准（放在 fetch 之前读到的是上一次的值）。
  const remoteVersion = await readVersionAtRef(root, layout.packageDir, 'FETCH_HEAD')
  const countResult = await runGit(['rev-list', '--count', 'HEAD..FETCH_HEAD'], root)
  const behind = Number.parseInt(countResult.stdout.trim(), 10)
  if (!Number.isFinite(behind)) {
    return checkResult({
      ...local,
      remoteHead,
      message: `统计落后提交数失败：${tail(countResult.stderr)}`,
    })
  }

  let subjects = []
  if (behind > 0) {
    const logResult = await runGit(
      ['log', `--max-count=${MAX_SUBJECTS}`, '--pretty=format:%h %s', 'HEAD..FETCH_HEAD'],
      root,
    )
    subjects = logResult.stdout.split(/\r?\n/).filter((line) => line.trim() !== '')
  }

  return checkResult({
    ...local,
    status: behind > 0 ? 'update-available' : 'up-to-date',
    viaProxy: fetched.proxy !== undefined,
    remoteHead,
    behind,
    subjects,
    remoteVersion,
  })
}

// ---------------------------------------------------------------------------
// 检查：npx / npm 形态走 registry
// ---------------------------------------------------------------------------

/** npx / npm 形态：比对 npm registry 上的发布版本。 */
async function inspectPackage(layout, { log, proxy }) {
  const channel = channelName()
  const common = {
    layout: layout.kind,
    source: 'npm',
    packageDir: layout.packageDir,
    localVersion: layout.version,
    installKind: layout.global ? 'global' : layout.kind === 'npx' ? 'npx-cache' : 'project',
    channel,
    proxy,
  }

  log('info', `查询 npm registry：${PACKAGE_NAME} 的 ${channel} 通道`)
  const fetched = await fetchDistTags(PACKAGE_NAME, proxy)
  if (!fetched.ok) {
    return checkResult({
      ...common,
      message: `查询 npm registry 失败：${fetched.error}`,
      hint: '可用 DSH_GIT_UPDATE_NOTIFIER_REGISTRY 指向镜像源（如 https://registry.npmmirror.com）。',
    })
  }

  const tags = fetched.tags
  const target = typeof tags[channel] === 'string' ? tags[channel] : undefined
  if (target === undefined) {
    return checkResult({
      ...common,
      tags,
      viaProxy: fetched.viaProxy,
      message: `registry 上没有 ${channel} 通道`,
      hint: `可用通道：${Object.keys(tags).join('、')}`,
    })
  }

  const newer = isNewer(target, layout.version)
  if (newer === undefined) {
    return checkResult({
      ...common,
      tags,
      target,
      viaProxy: fetched.viaProxy,
      message: `无法比较版本：本地 ${layout.version} 与 registry ${target}`,
    })
  }

  return checkResult({
    ...common,
    status: newer ? 'update-available' : 'up-to-date',
    tags,
    target,
    viaProxy: fetched.viaProxy,
  })
}

/** 检查入口：按形态分发。 */
async function inspect(layout, options = {}) {
  const log = options.log ?? (() => {})
  const proxy = 'proxy' in options ? options.proxy : await detectProxy(log)
  if (layout.kind === 'source') return inspectSource(layout, { log, proxy })
  return inspectPackage(layout, { log, proxy })
}

// ---------------------------------------------------------------------------
// 更新
// ---------------------------------------------------------------------------

/** 源码形态：只允许快进合并，绝不产生意外 merge commit。 */
async function applyGitUpdate(layout, { log, proxy }) {
  const root = layout.gitRoot
  const branchInfo = await currentBranch(root)
  if (!branchInfo.ok) return { ok: false, message: branchInfo.message }
  const { branch } = branchInfo

  const pullResult = await runGit(['pull', '--ff-only', 'origin', branch], root, proxy)
  if (pullResult.code !== 0) {
    return {
      ok: false,
      message: `git pull --ff-only 失败（${describeRoute(proxy)}）：${tail(pullResult.stderr)}`,
      output: tail(`${pullResult.stdout}\n${pullResult.stderr}`, 12),
      hint: '本地可能有未提交改动或分支已分叉，请手动处理后重试。',
    }
  }

  const after = await inspect(layout, { log, proxy })
  return {
    ok: true,
    message: `已更新到 ${after.localHead === undefined ? '新版本' : after.localHead.slice(0, 9)}`
      + `（${after.behind > 0 ? `仍落后 ${after.behind} 个提交` : '已与上游一致'}）`,
    output: tail(`${pullResult.stdout}\n${pullResult.stderr}`, 12),
    // 源码是构建产物之外的输入：拉取后需要重新构建并重启才生效。
    needsRestart: true,
    after,
  }
}

/**
 * npx / npm 形态：在拥有该 node_modules 的项目里安装指定版本。
 *
 * npx 缓存目录自带 `package.json`，所以原地 `npm install` 之后，下次
 * `npx @deepseek-ai/dsh web` 会复用同一缓存目录并跑到新版本；全局安装则加 `-g`。
 */
async function applyPackageUpdate(layout, { log, proxy }) {
  const channel = channelName()
  const fetched = await fetchDistTags(PACKAGE_NAME, proxy)
  if (!fetched.ok) {
    return { ok: false, message: `查询 npm registry 失败：${fetched.error}` }
  }
  const target = typeof fetched.tags[channel] === 'string' ? fetched.tags[channel] : undefined
  if (target === undefined) {
    return { ok: false, message: `registry 上没有 ${channel} 通道` }
  }
  if (isNewer(target, layout.version) !== true) {
    return { ok: false, message: `本地已是 ${channel} 通道最新（${layout.version}）` }
  }

  const spec = `${PACKAGE_NAME}@${target}`
  const args = ['install', spec]
  if (layout.global) args.push('-g')
  const cwd = layout.global ? undefined : layout.projectRoot
  if (!layout.global && cwd === undefined) {
    return {
      ok: false,
      message: '未能确定安装位置（项目根目录）',
      hint: '可用 DSH_GIT_UPDATE_NOTIFIER_ROOT 指向 @deepseek-ai/dsh 包目录。',
    }
  }

  log('info', `执行 ${NPM_COMMAND} ${args.join(' ')}${cwd === undefined ? '' : `（于 ${cwd}）`}`)
  const result = await runNpm(args, cwd, proxy)
  if (result.code !== 0) {
    return {
      ok: false,
      message: `npm install ${spec} 失败：${tail(result.stderr)}`,
      output: tail(`${result.stdout}\n${result.stderr}`, 12),
      hint: '可改用 DSH_GIT_UPDATE_NOTIFIER_REGISTRY 指向更快的镜像后重试。',
    }
  }

  const installed = readPackageVersion(layout.packageDir) ?? target
  return {
    ok: true,
    message: `已更新到 ${installed}（${layout.global ? 'npm 全局' : layout.kind === 'npx' ? 'npx 缓存' : '项目依赖'}）`,
    output: tail(`${result.stdout}\n${result.stderr}`, 12),
    // 需要重新启动 dsh 才会跑到新版本；npx 形态请重新执行 npx 命令。
    needsRestart: true,
    after: checkResult({
      layout: layout.kind,
      source: 'npm',
      packageDir: layout.packageDir,
      localVersion: installed,
      installKind: layout.global ? 'global' : layout.kind === 'npx' ? 'npx-cache' : 'project',
      channel,
      target,
      status: 'up-to-date',
      proxy,
    }),
  }
}

/**
 * 生成一个**不依赖 dsh 运行**的回退脚本。
 *
 * 更新之后 dsh 若起不来（新版本有 bug、插件报错等），插件自己也跑不起来，
 * 所以回退入口必须落在 dsh 之外：一个可以直接双击或命令行运行的脚本。
 */
function writeRollbackScript(rollback, say) {
  try {
    const isWindows = process.platform === 'win32'
    const file = join(homeDir(), isWindows ? 'dsh-rollback.cmd' : 'dsh-rollback.sh')
    const lines = []
    lines.push(isWindows ? '@echo off' : '#!/bin/sh')
    if (isWindows) lines.push('chcp 65001 >nul')
    lines.push('# dsh-git-update-notifier 生成的回退脚本')
    lines.push('# 用途：dsh 更新后无法启动时，直接运行本脚本回到更新前的状态。')
    lines.push(`# 生成时间：${rollback.at}`)
    lines.push(`# 回退目标：${rollback.from}  ->  ${rollback.to}`)
    lines.push('')
    if (rollback.layout === 'source') {
      lines.push(`cd "${rollback.gitRoot}"`)
      lines.push(`git reset --hard ${rollback.head}`)
      lines.push('')
      lines.push(`echo 已把源码回退到 ${rollback.head}`)
      lines.push('echo 请重新构建（pnpm build:lib）并重启 dsh web')
    } else {
      const where = rollback.global ? rollback.projectRoot ?? rollback.packageDir : rollback.projectRoot
      if (typeof where === 'string' && where !== '') lines.push(`cd "${where}"`)
      const flag = rollback.global ? ' -g' : ''
      lines.push(`npm install${flag} ${PACKAGE_NAME}@${rollback.version}`)
      lines.push('')
      lines.push(`echo 已回退到 ${rollback.version}`)
      lines.push('echo 请重启 dsh')
    }
    if (isWindows) lines.push('pause')
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
    say('info', `已生成回退脚本：${file}`)
    return file
  } catch (error) {
    say('warn', `生成回退脚本失败：${describe(error)}`)
    return null
  }
}

/** 回退到上一次更新前的状态，与更新一样按形态分发。 */
async function applyRollback(rollback, options = {}) {
  const log = options.log ?? (() => {})
  const proxy = 'proxy' in options ? options.proxy : await detectProxy(log)

  if (rollback.layout === 'source') {
    if (typeof rollback.head !== 'string' || rollback.head === '') {
      return { ok: false, message: '回退点缺少提交号，无法回退' }
    }
    log('info', `回退源码到 ${rollback.head}`)
    const reset = await runGit(['reset', '--hard', rollback.head], rollback.gitRoot)
    if (reset.code !== 0) {
      return {
        ok: false,
        message: `git reset --hard 失败：${tail(reset.stderr)}`,
        output: tail(`${reset.stdout}\n${reset.stderr}`, 12),
      }
    }
    return {
      ok: true,
      message: `源码已回退到 ${rollback.head.slice(0, 9)}（${rollback.from}）；重新构建并重启 dsh 后生效。`,
      needsRestart: true,
      output: tail(`${reset.stdout}\n${reset.stderr}`, 12),
    }
  }

  if (typeof rollback.version !== 'string' || rollback.version === '') {
    return { ok: false, message: '回退点缺少版本号，无法回退' }
  }
  const args = ['install', `${PACKAGE_NAME}@${rollback.version}`]
  if (rollback.global) args.push('-g')
  const cwd = rollback.global ? undefined : rollback.projectRoot
  if (!rollback.global && cwd === undefined) {
    return { ok: false, message: '回退点缺少安装位置，无法回退' }
  }
  const installed = await runNpm(args, cwd, proxy)
  if (installed.code !== 0) {
    return {
      ok: false,
      message: `npm install ${rollback.version} 失败：${tail(installed.stderr)}`,
      output: tail(`${installed.stdout}\n${installed.stderr}`, 12),
    }
  }
  return {
    ok: true,
    message: `已回退到 ${rollback.version}；重启 dsh 后生效。`,
    needsRestart: true,
    output: tail(`${installed.stdout}\n${installed.stderr}`, 12),
  }
}

/**
 * 列出可回退的目标。
 *
 * 源码形态给最近的若干提交；npx / npm 形态给最近的若干发布版本（用 npm view 取，
 * 自己拉 packument 太重）。目标由用户挑选，所以这里只负责"有什么可选"。
 */
async function listRollbackTargets(layout, options = {}) {
  const log = options.log ?? (() => {})
  const proxy = 'proxy' in options ? options.proxy : await detectProxy(log)

  if (layout.kind === 'source') {
    // 跳过当前 HEAD：回退到"现在"没有意义。
    const result = await runGit(['log', '--max-count=7', '--skip=1', '--date=short',
      '--pretty=format:%H|%h|%ad|%s'], layout.gitRoot)
    if (result.code !== 0) {
      return { ok: false, message: `读取提交历史失败：${tail(result.stderr)}`, targets: [] }
    }
    const targets = result.stdout.split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const parts = line.split('|')
        const sha = parts[0] ?? ''
        const short = parts[1] ?? sha.slice(0, 9)
        const date = parts[2] ?? ''
        const subject = parts.slice(3).join('|').slice(0, 60)
        return { id: sha, label: `${short} ${date} ${subject}`.trim(), kind: 'commit' }
      })
    return { ok: true, layout: layout.kind, current: layout.version, targets }
  }

  const viewed = await runNpm(['view', PACKAGE_NAME, 'versions', '--json'], undefined, proxy)
  if (viewed.code !== 0) {
    return { ok: false, message: `读取版本列表失败：${tail(viewed.stderr)}`, targets: [] }
  }
  let versions
  try {
    versions = JSON.parse(viewed.stdout)
  } catch {
    return { ok: false, message: '版本列表解析失败', targets: [] }
  }
  if (!Array.isArray(versions)) versions = [versions]
  const targets = versions
    .filter((v) => typeof v === 'string' && v !== '' && v !== layout.version)
    .slice(-8)
    .reverse()
    .map((v) => ({ id: v, label: v, kind: 'version' }))
  return { ok: true, layout: layout.kind, current: layout.version, targets }
}

/** 更新入口：按形态分发。 */
async function applyUpdate(layout, options = {}) {
  const log = options.log ?? (() => {})
  const proxy = 'proxy' in options ? options.proxy : await detectProxy(log)
  if (layout.kind === 'source') return applyGitUpdate(layout, { log, proxy })
  return applyPackageUpdate(layout, { log, proxy })
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/** 写路由只接受本机来源，避免局域网里的其它客户端触发安装操作。 */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export function apply(ctx) {
  const say = (level, message) => {
    const line = `[${name}] ${message}`
    const logger = ctx.logger
    const method = level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'info'
    if (logger !== undefined && typeof logger[method] === 'function') logger[method](line)
    else if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }

  /** 正在执行的更新任务：并发点击时复用同一个 promise。 */
  let pending = null

  /** 正在执行的检查任务：启动检查与手动重新检查并发时复用同一个 promise。 */
  let pendingCheck = null

  /**
   * 本次进程内的最近一次检查增量。状态文件写不进去时（例如 home 只读），
   * 当前进程的 UI 仍然拿得到结果，不必依赖一次成功的磁盘写。
   */
  let lastResult = null

  /** 最近一次探测到的部署形态（快照要用它的标签）。 */
  let lastLayout = null

  /** 下一次计划中的检查时间（本地 24 时），供快照展示。 */
  let nextCheckAt = null

  const snapshot = () => {
    const merged = { ...readState(), ...(lastResult ?? {}) }
    if (lastLayout === null) lastLayout = detectLayout() ?? null
    return {
      ...merged,
      day: today(),
      checkedToday: merged.lastCheckDate === today(),
      // 兜底：进程刚重启、本次检查还没跑过时，状态文件里可能还没有这些字段。
      layout: merged.layout ?? lastLayout?.kind ?? null,
      source: merged.source
        ?? (lastLayout === null ? null : lastLayout.kind === 'source' ? 'git' : 'npm'),
      layoutLabel: lastLayout === null ? null : layoutLabel(lastLayout),
      nextCheckAt,
      // 延期期间不再弹浮层卡片，但设置页照旧可查、可手动更新。
      snoozeUntil: merged.snoozeUntil ?? null,
      snoozed: isSnoozed(merged.snoozeUntil),
      codeVersion: CODE_VERSION,
      rollback: merged.rollback ?? null,
      packageDir: merged.packageDir ?? lastLayout?.packageDir ?? null,
      localVersion: merged.localVersion ?? lastLayout?.version ?? null,
      channel: merged.channel ?? channelName(),
    }
  }

  const doDailyCheck = async (reason) => {
    const day = today()
    const state = readState()
    if (reason === 'startup' && state.lastCheckDate === day) {
      say('info', `今天（${day}）已经检查过，跳过启动补检`)
      return snapshot()
    }

    const layout = detectLayout()
    lastLayout = layout ?? null
    if (layout === undefined) {
      lastResult = {
        lastCheckDate: day,
        lastCheckAt: new Date().toISOString(),
        status: 'error',
        message: '未能定位正在运行的 dsh 本体。',
        hint: '可设置 DSH_GIT_UPDATE_NOTIFIER_ROOT 指向 @deepseek-ai/dsh 包目录。',
      }
      writeState({ ...state, ...lastResult }, say)
      say('warn', String(lastResult.message))
      return snapshot()
    }

    say('info', `检查更新：${layoutLabel(layout)}（${layout.packageDir}，本地 ${layout.version}）`)
    const result = await inspect(layout, { log: say })
    lastResult = {
      ...result,
      lastCheckDate: day,
      lastCheckAt: new Date().toISOString(),
      dismissed: false,
    }
    writeState({ ...state, ...lastResult }, say)

    if (result.status === 'update-available') {
      if (result.source === 'git') {
        say('warn', `上游有 ${result.behind} 个新提交（本地 ${String(result.localHead).slice(0, 9)}`
          + ` → 远端 ${String(result.remoteHead).slice(0, 9)}，${describeRoute(result.proxy)}），已在 Web GUI 中询问。`)
      } else {
        say('warn', `registry 的 ${result.channel} 通道为 ${result.target}`
          + `（本地 ${result.localVersion}，${describeRoute(result.proxy)}），已在 Web GUI 中询问。`)
      }
    } else if (result.status === 'up-to-date') {
      const where = result.source === 'git'
        ? `${result.branch} @ ${String(result.localHead).slice(0, 9)}`
        : `${result.channel} ${result.localVersion}`
      say('info', `已是最新（${where}）`)
    } else {
      say('warn', `检查失败：${result.message}`)
    }
    return snapshot()
  }

  /** 检查入口：同一时刻只允许一趟检查在跑，并发调用复用同一个 promise。 */
  const runDailyCheck = (reason) => {
    if (pendingCheck !== null) return pendingCheck
    pendingCheck = doDailyCheck(reason).finally(() => {
      pendingCheck = null
    })
    return pendingCheck
  }

  /**
   * 每日检查的主触发点：**本地时间 24 时**（即次日 00:00）。
   *
   * 每次触发后重新计算下一次的等待时长，而不是用固定的 24h 间隔 —— 这样
   * 夏令时切换或系统时间被改动，触发点都不会漂移。
   */
  ctx.effect(() => {
    let timer = null
    const scheduleMidnight = () => {
      const wait = msUntilNextMidnight()
      const nextAt = new Date(Date.now() + wait)
      nextCheckAt = nextAt.toISOString()
      say('info', `下次自动检查：${nextAt.toLocaleString('zh-CN')}（本地 24 时，约 ${Math.round(wait / 60_000)} 分钟后）`)
      timer = setTimeout(() => {
        void runDailyCheck('midnight')
          .catch((error) => say('error', `24 时检查异常：${describe(error)}`))
          .finally(scheduleMidnight)
      }, wait)
    }
    scheduleMidnight()
    return () => {
      if (timer !== null) clearTimeout(timer)
    }
  }, `${name}: 每日 24 时检查`)

  /**
   * 启动补检：今天（自 00:00 起）还没检查过就补一次。
   *
   * 需要它是因为 dsh 未必在午夜时开着 —— 只靠 24 时定时器的话，
   * "白天启动、睡前关闭"的用法会永远等不到检查。重复打扰仍由 lastCheckDate 拦掉。
   */
  ctx.effect(() => {
    const timer = setTimeout(() => {
      void runDailyCheck('startup').catch((error) => say('error', `启动补检异常：${describe(error)}`))
    }, STARTUP_DELAY_MS)
    return () => {
      clearTimeout(timer)
    }
  }, `${name}: 启动补检`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/status.json`,
    handler: (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { code: 'method-not-allowed', message: 'GET only' })
        return
      }
      sendJson(res, 200, snapshot())
    },
  }), `${name}: GET status.json`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/check`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { code: 'method-not-allowed', message: 'POST only' })
        return
      }
      if (!isLoopback(req)) {
        sendJson(res, 403, { code: 'forbidden', message: '仅允许本机访问' })
        return
      }
      try {
        sendJson(res, 200, await runDailyCheck('manual'))
      } catch (error) {
        sendJson(res, 500, { code: 'check-failed', message: describe(error) })
      }
    },
  }), `${name}: POST check`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/update`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { code: 'method-not-allowed', message: 'POST only' })
        return
      }
      if (!isLoopback(req)) {
        sendJson(res, 403, { code: 'forbidden', message: '仅允许本机访问' })
        return
      }
      if (pending !== null) {
        sendJson(res, 409, { code: 'busy', message: '已有更新任务在执行' })
        return
      }

      const layout = detectLayout()
      lastLayout = layout ?? null
      if (layout === undefined) {
        sendJson(res, 500, { code: 'no-layout', message: '未能定位正在运行的 dsh 本体' })
        return
      }

      say('info', `用户确认更新（${layoutLabel(layout)}）`)
      // 回退点必须在更新**之前**取：更新完成后旧版本/旧提交就取不到了。
      const rollbackBase = {
        layout: layout.kind,
        packageDir: layout.packageDir,
        gitRoot: layout.gitRoot,
        projectRoot: layout.projectRoot,
        global: layout.global,
        version: layout.version,
        head: layout.kind === 'source'
          ? (await runGit(['rev-parse', 'HEAD'], layout.gitRoot)).stdout.trim()
          : null,
      }

      pending = applyUpdate(layout, { log: say })
      let result
      try {
        result = await pending
      } catch (error) {
        result = { ok: false, message: describe(error) }
      } finally {
        pending = null
      }

      if (result.ok && result.after !== undefined) {
        // 更新后 lastResult 应反映新的版本 / HEAD，并记下回退点。
        const rollback = {
          ...rollbackBase,
          from: rollbackBase.version,
          to: result.after.localVersion ?? layout.version,
          at: new Date().toISOString(),
        }
        rollback.script = writeRollbackScript(rollback, say)
        lastResult = {
          ...result.after,
          rollback,
          dismissed: true,
          lastCheckDate: today(),
          lastCheckAt: new Date().toISOString(),
        }
      } else {
        // 用户已经做过决定：当天不再弹卡片（无论成功还是失败）。
        lastResult = {
          ...(lastResult ?? {}),
          dismissed: true,
          lastCheckDate: today(),
          lastCheckAt: new Date().toISOString(),
        }
      }
      writeState({ ...readState(), ...lastResult }, say)

      if (result.ok) say('info', String(result.message))
      else say('warn', String(result.message))
      sendJson(res, result.ok ? 200 : 500, result)
    },
  }), `${name}: POST update`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/dismiss`,
    handler: (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { code: 'method-not-allowed', message: 'POST only' })
        return
      }
      if (!isLoopback(req)) {
        sendJson(res, 403, { code: 'forbidden', message: '仅允许本机访问' })
        return
      }
      lastResult = { ...(lastResult ?? {}), dismissed: true }
      writeState({ ...readState(), ...lastResult }, say)
      say('info', '用户选择了稍后提醒，今天不再询问')
      sendJson(res, 200, { ok: true })
    },
  }), `${name}: POST dismiss`)

  // 延期更新：用户给出天数，最长一个月。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/snooze`,
    handler: (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { code: 'method-not-allowed', message: 'POST only' })
        return
      }
      if (!isLoopback(req)) {
        sendJson(res, 403, { code: 'forbidden', message: '仅允许本机访问' })
        return
      }
      const url = new URL(String(req.url), 'http://localhost')
      const requested = Number.parseInt(url.searchParams.get('days') ?? '', 10)
      if (!Number.isFinite(requested) || requested < 0) {
        sendJson(res, 400, { code: 'bad-days', message: 'days 必须是 ≥0 的整数（0 表示取消延期）' })
        return
      }
      if (requested === 0) {
        // 0 天 = 取消延期：清掉到期时间，恢复浮层提醒。
        lastResult = { ...(lastResult ?? {}), snoozeUntil: null }
        writeState({ ...readState(), ...lastResult }, say)
        say('info', '用户取消了延期，恢复提醒')
        sendJson(res, 200, { ok: true, days: 0, snoozeUntil: null, cancelled: true })
        return
      }
      // 上限一个月：再多也按上限处理，避免被写成"永不提醒"。
      const days = Math.min(Math.floor(requested), SNOOZE_MAX_DAYS)
      const until = new Date(Date.now() + days * 86_400_000)
      lastResult = { ...(lastResult ?? {}), snoozeUntil: until.toISOString() }
      writeState({ ...readState(), ...lastResult }, say)
      say('info', `用户选择延期 ${days} 天，至 ${until.toLocaleString('zh-CN')}`)
      sendJson(res, 200, { ok: true, days, snoozeUntil: until.toISOString() })
    },
  }), `${name}: POST snooze`)
  // 回退到上一次更新前的状态；dsh 起不来时可改用生成的回退脚本。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/rollback`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { code: 'method-not-allowed', message: 'POST only' })
        return
      }
      if (!isLoopback(req)) {
        sendJson(res, 403, { code: 'forbidden', message: '仅允许本机访问' })
        return
      }
      const url = new URL(String(req.url), 'http://localhost')
      const requested = (url.searchParams.get('target') ?? '').trim()
      const fallback = readState().rollback
      // 既没指定目标、也没有更新记录时直接拒掉 —— 这时连形态都不必探测。
      if (requested === '' && (fallback === null || fallback === undefined)) {
        sendJson(res, 409, { code: 'no-rollback', message: '没有可回退的更新记录，也没有指定目标' })
        return
      }
      // 目标会拼进命令，先做一遍不依赖安装形态的字符白名单：明显非法的输入
      // 在任何环境下都该是 400，而不是等探测失败后变成 500。
      if (requested !== '' && !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(requested)) {
        sendJson(res, 400, { code: 'bad-target', message: 'target 只能是提交号或版本号' })
        return
      }
      const layout = detectLayout()
      if (layout === undefined) {
        sendJson(res, 500, { code: 'no-layout', message: '未能定位 dsh 本体' })
        return
      }

      let plan
      if (requested !== '') {
        // 用户自选目标：格式必须严格，因为下面会拼进命令。
        if (layout.kind === 'source') {
          if (!/^[0-9a-f]{7,40}$/i.test(requested)) {
            sendJson(res, 400, { code: 'bad-target', message: 'target 必须是提交号（7-40 位十六进制）' })
            return
          }
          plan = { layout: 'source', gitRoot: layout.gitRoot, head: requested, from: requested.slice(0, 9) }
        } else {
          if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(requested)) {
            sendJson(res, 400, { code: 'bad-target', message: 'target 必须是合法的版本号' })
            return
          }
          plan = { layout: layout.kind, packageDir: layout.packageDir, projectRoot: layout.projectRoot, global: layout.global, version: requested, from: requested }
        }
      } else {
        plan = fallback
      }

      say('info', `用户确认回退到 ${plan.from}`)
      let result
      try {
        result = await applyRollback(plan, { log: say })
      } catch (error) {
        result = { ok: false, message: describe(error) }
      }
      // 回退点用掉即清，避免重复回退到同一个旧状态。
      lastResult = {
        ...(lastResult ?? {}),
        rollback: null,
        dismissed: true,
        lastCheckDate: today(),
        lastCheckAt: new Date().toISOString(),
      }
      writeState({ ...readState(), ...lastResult }, say)
      if (result.ok) say('info', String(result.message))
      else say('warn', String(result.message))
      sendJson(res, result.ok ? 200 : 500, result)
    },
  }), `${name}: POST rollback`)
  // 自选回退目标：列出最近可回退的提交 / 版本。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/rollback/targets.json`,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { code: 'method-not-allowed', message: 'GET only' })
        return
      }
      const layout = detectLayout()
      if (layout === undefined) {
        sendJson(res, 200, { ok: false, message: '未能定位 dsh 本体', targets: [] })
        return
      }
      try {
        sendJson(res, 200, await listRollbackTargets(layout, { log: say }))
      } catch (error) {
        sendJson(res, 500, { ok: false, message: describe(error), targets: [] })
      }
    },
  }), `${name}: GET rollback targets`)
  say('info', '已挂载：每日本地 24 时检查 dsh 更新（启动时补检当天遗漏；'
    + '源码走 git，npx / npm 安装走 registry）')
}
