/**
 * dsh-git-update-notifier — 宿主端（node half）。
 *
 * 职责：
 * 1. 每天首次启动流程里检查一次：本地 deepseek-harness checkout 相对
 *    `origin/<branch>` 是否落后（`git fetch` + `git rev-list --count`）。
 * 2. 把检查结果与"当天是否已询问"写进 `$DSH_HOME/dsh-git-update-notifier.json`，
 *    同一天内多次重启不重复打扰。
 * 3. 通过 `ctx.webServer` 暴露只读/受控路由，供浏览器侧询问卡片使用；
 *    真正修改工作区的只有 `git pull --ff-only`，且必须由用户点击触发。
 *
 * 设计取舍：
 * - 不做 `npm install`，不改 node_modules。本机 dsh 本体是源码 checkout
 *   （`@deepseek-ai/dsh` 只是指向它的 junction），所以"更新"唯一正确的
 *   语义就是推进这个 checkout 的提交。
 * - **不修改用户的全局 git 配置**。Windows 上 git 不读取系统代理设置，
 *   这会让开了代理的机器依然连不上 GitHub；本插件自行探测系统代理，
 *   只在自己的 git 调用里用 `-c http.proxy=...` 生效，并在经代理失败时
 *   回退直连。代理的开关随时变化都能自适应，且不留下任何全局痕迹。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const name = 'dsh-git-update-notifier'

/** 需要 web 服务来承载询问卡片；没有 web 服务的 profile 会保持 PENDING（预期行为）。 */
export const inject = ['webServer']

/** 路由前缀。webserver 的具名路由互不相交，取一个专属前缀即可。 */
const ROUTE_PREFIX = '/dsh-git-update-notifier'

/** 启动后延迟多久开始检查，避开 boot 高峰。 */
const STARTUP_DELAY_MS = 5_000

/** 单条 git 命令的超时。联网命令会重试，所以这里给足余量。 */
const GIT_TIMEOUT_MS = 120_000

/** 同一个候选路径（经代理 / 直连）内的 `git fetch` 尝试次数。 */
const FETCH_ATTEMPTS = 2

/** 上游提交摘要最多展示多少条。 */
const MAX_SUBJECTS = 20

/** 状态文件与插件同名。 */
const STATE_BASENAME = 'dsh-git-update-notifier.json'

/** 显式关闭代理探测的取值（`DSH_GIT_UPDATE_NOTIFIER_PROXY`）。 */
const PROXY_DISABLED = new Set(['none', 'off', 'direct', 'no', 'disable', 'disabled'])

/** Windows 系统代理所在的注册表键。 */
const WINDOWS_PROXY_KEY
  = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

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

/** 本地日期（YYYY-MM-DD）。"每天首次"按用户所在时区的自然日判定。 */
function today() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

// ---------------------------------------------------------------------------
// 定位 dsh 本体的源码 checkout
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

/**
 * 解析要被检查的 checkout 根目录。
 *
 * 当前部署里 `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh` 是指向
 * `<checkout>/apps/cli` 的 junction，所以 realpath 之后再上溯找 `.git`
 * 就能拿到真正要 `git pull` 的仓库根，无需任何硬编码路径。
 */
function findCheckout() {
  const override = process.env.DSH_GIT_UPDATE_NOTIFIER_ROOT
  if (typeof override === 'string' && override.trim() !== '') {
    const root = findGitRoot(override.trim())
    if (root !== undefined) return root
  }
  const home = homeDir()
  const candidates = [
    join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh'),
    join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh'),
  ]
  for (const candidate of candidates) {
    const real = realpathOf(candidate)
    if (real === undefined) continue
    const root = findGitRoot(real)
    if (root !== undefined) return root
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 子进程
// ---------------------------------------------------------------------------

/**
 * 运行一条外部命令。永不抛错：把失败折叠成 `{ code, stdout, stderr }`，
 * 让调用方按业务语义处理（超时、非零退出、命令不存在）。
 */
function runCommand(command, args, options = {}) {
  return new Promise((done) => {
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        windowsHide: true,
        env: {
          ...process.env,
          // 绝不因为缺少凭证而在后台请求输入。
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          // 提交摘要里不要转义非 ASCII 路径。
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.quotepath',
          GIT_CONFIG_VALUE_0: 'false',
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
      finish(-1, `\n[超时] ${command} ${args.join(' ')} 超过 ${GIT_TIMEOUT_MS}ms`)
    }, GIT_TIMEOUT_MS)

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

/** git 报错时只保留尾部若干行，避免把整段输出塞进 UI。 */
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
  // 本插件只访问 https 的 GitHub，优先挑 https，其次 http，最后 socks。
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
    log('info', `检测到系统代理：${system}（仅用于本插件的 git 调用，不改动你的 git 配置）`)
  }
  return system
}

function describeRoute(proxy) {
  return proxy === undefined ? '直连' : `经代理 ${proxy}`
}

// ---------------------------------------------------------------------------
// 检查与更新
// ---------------------------------------------------------------------------

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
 * `--no-tags` 避免为一个 tag 拉取无关对象。
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

/**
 * 构造一次检查结果。
 *
 * 每个分支都返回**同一组字段**（不适用的显式置 null）：状态文件是按
 * 「旧状态 + 本次增量」合并写出的，字段不齐就会把上一轮的结论残留下来
 * （例如这次抓取成功后，仍然显示上一次失败的原因和落后数）。
 */
function checkResult(fields) {
  return {
    status: 'error',
    proxy: null,
    viaProxy: false,
    branch: null,
    localHead: null,
    localSubject: null,
    localDate: null,
    remoteHead: null,
    behind: null,
    subjects: [],
    message: null,
    hint: null,
    checkedAt: new Date().toISOString(),
    ...fields,
  }
}

/** 检查上游是否有新提交。返回的增量会被写进状态文件并交给 UI。 */
async function inspect(root, options = {}) {
  const log = options.log ?? (() => {})
  const proxy = 'proxy' in options ? options.proxy : await detectProxy(log)
  const common = { root, proxy }

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
  })
}

/** 用户确认后执行更新。只允许快进合并，绝不产生意外 merge commit。 */
async function applyUpdate(root, branch, options = {}) {
  const log = options.log ?? (() => {})
  const proxy = 'proxy' in options ? options.proxy : await detectProxy(log)

  const pullResult = await runGit(['pull', '--ff-only', 'origin', branch], root, proxy)
  if (pullResult.code !== 0) {
    return {
      ok: false,
      message: `git pull --ff-only 失败（${describeRoute(proxy)}）：${tail(pullResult.stderr)}`,
      output: tail(`${pullResult.stdout}\n${pullResult.stderr}`, 12),
      hint: '本地可能有未提交改动或分支已分叉，请手动处理后重试。',
    }
  }

  const after = await inspect(root, { log, proxy })
  return {
    ok: true,
    message: `已更新到 ${after.localHead === undefined ? '新版本' : after.localHead.slice(0, 9)}`
      + `（${after.behind > 0 ? `仍落后 ${after.behind} 个提交` : '已与上游一致'}）`,
    output: tail(`${pullResult.stdout}\n${pullResult.stderr}`, 12),
    // 源码 checkout 的运行产物是构建出来的：拉取后需要重新构建并重启才生效。
    needsRestart: true,
    after,
  }
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

/** 写路由只接受本机来源，避免局域网里的其它客户端触发 git 操作。 */
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

  const snapshot = () => {
    const merged = { ...readState(), ...(lastResult ?? {}) }
    return {
      ...merged,
      day: today(),
      checkedToday: merged.lastCheckDate === today(),
      root: merged.root ?? findCheckout() ?? null,
    }
  }

  const doDailyCheck = async (reason) => {
    const day = today()
    const state = readState()
    if (reason === 'startup' && state.lastCheckDate === day) {
      say('info', `今天（${day}）已经检查过，跳过启动检查`)
      return snapshot()
    }

    const root = findCheckout()
    if (root === undefined) {
      lastResult = {
        lastCheckDate: day,
        lastCheckAt: new Date().toISOString(),
        status: 'error',
        message: '未能定位 dsh 本体的源码 checkout。',
        hint: '可设置 DSH_GIT_UPDATE_NOTIFIER_ROOT 指向 checkout 根目录。',
      }
      writeState({ ...state, ...lastResult }, say)
      say('warn', String(lastResult.message))
      return snapshot()
    }

    say('info', `检查上游更新：${root}`)
    const result = await inspect(root, { log: say })
    // 已经有结果就问一次；同一天内不因为多次重启反复询问。
    // 成功时显式把 message/hint 置空：快照是「磁盘状态 + 本次增量」合并的，
    // 不清就会把上一轮失败的说明残留下来。
    lastResult = {
      ...result,
      message: result.message ?? null,
      hint: result.hint ?? null,
      lastCheckDate: day,
      lastCheckAt: new Date().toISOString(),
      dismissed: false,
    }
    writeState({ ...state, ...lastResult }, say)

    if (result.status === 'update-available') {
      say('warn', `上游有 ${result.behind} 个新提交（本地 ${String(result.localHead).slice(0, 9)}`
        + ` → 远端 ${String(result.remoteHead).slice(0, 9)}，${describeRoute(result.proxy)}），已在 Web GUI 中询问。`)
    } else if (result.status === 'up-to-date') {
      say('info', `已是最新（${result.branch} @ ${String(result.localHead).slice(0, 9)}，${describeRoute(result.proxy)}）`)
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

  // 每天首次启动检查：延迟到 boot 稳定之后，且随插件卸载一起清理。
  ctx.effect(() => {
    const timer = setTimeout(() => {
      void runDailyCheck('startup').catch((error) => say('error', `启动检查异常：${describe(error)}`))
    }, STARTUP_DELAY_MS)
    return () => {
      clearTimeout(timer)
    }
  }, `${name}: 每日首次启动检查`)

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
      const root = findCheckout()
      if (root === undefined) {
        sendJson(res, 500, { code: 'no-checkout', message: '未能定位 dsh 本体的源码 checkout' })
        return
      }
      const branchInfo = await currentBranch(root)
      if (!branchInfo.ok) {
        sendJson(res, 500, { code: 'no-branch', message: branchInfo.message })
        return
      }

      say('info', `用户确认更新，执行 git pull --ff-only origin ${branchInfo.branch}`)
      pending = applyUpdate(root, branchInfo.branch, { log: say })
      let result
      try {
        result = await pending
      } catch (error) {
        result = { ok: false, message: describe(error) }
      } finally {
        pending = null
      }

      if (result.ok && result.after !== undefined) {
        // 更新后 lastResult 应反映新的 HEAD。
        lastResult = {
          ...result.after,
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

  say('info', '已挂载：每天首次启动检查上游提交，并在 Web GUI 中询问是否更新')
}
