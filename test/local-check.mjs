/**
 * 宿主端本地验证：不起 dsh，直接用假 ctx 驱动插件。
 *
 * 验证内容：
 * 1. apply() 能正常挂载并注册 11 条路由；
 * 2. 写路由的 loopback 网关与 GET-only 的方法限制；
 * 3. 找不到 checkout 时降级为 error 状态，而不是抛错。
 *
 * 脚本自我隔离：`DSH_HOME` 指向临时目录、checkout 指向不存在的位置，
 * 因此既不会写你真实的 `~/.dsh` 状态文件，也不会发起任何真实网络抓取
 * （所以它能安全地进 CI）。需要真实抓取的场景请用 test/live-upstream.mjs。
 *
 * 用法：node test/local-check.mjs
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离必须在加载插件模块之前生效：homeDir()/findCheckout() 在运行时读这些变量。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-gun-local-'))
process.env.DSH_GIT_UPDATE_NOTIFIER_PROXY = 'none'
process.env.DSH_GIT_UPDATE_NOTIFIER_ROOT = join(process.env.DSH_HOME, 'no-such-checkout')

const { apply } = await import('../lib/index.js')

let failed = 0
function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`)
    return
  }
  failed += 1
  console.error(`  ✗ ${message}`)
}

const routes = []
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect(fn) {
    fn()
    return () => {}
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
}

apply(ctx)

console.log('=== 1. 路由注册 ===')
assert(routes.length === 11, `注册了 11 条路由（实际 ${routes.length}）`)
for (const route of routes) console.log(`     ${route.kind.padEnd(6)} ${route.path}`)

function makeRes() {
  let body = ''
  return {
    res: {
      statusCode: 200,
      setHeader() {},
      end(chunk) {
        if (chunk !== undefined) body += String(chunk)
      },
    },
    text: () => body,
  }
}

async function call(path, method = 'POST', remoteAddress = '127.0.0.1') {
  // 真实 webserver 按 pathname 匹配路由、把 query 留给 handler —— 这里还原同一点。
  const pathname = path.split('?')[0]
  const route = routes.find((candidate) => candidate.path === pathname)
  if (route === undefined) throw new Error(`route not found: ${path}`)
  const { res, text } = makeRes()
  await route.handler({ method, url: path, socket: { remoteAddress } }, res)
  return { status: res.statusCode, body: text() }
}

console.log('\n=== 2. loopback 网关（写操作只允许本机来源）===')
const deniedUpdate = await call('/dsh-git-update-notifier/update', 'POST', '192.168.1.20')
assert(deniedUpdate.status === 403, `非本机来源触发 update 被拒（HTTP ${deniedUpdate.status}）`)
const deniedCheck = await call('/dsh-git-update-notifier/check', 'POST', '10.0.0.5')
assert(deniedCheck.status === 403, '非本机来源触发 check 同样被拒')
const deniedDismiss = await call('/dsh-git-update-notifier/dismiss', 'POST', '::ffff:8.8.8.8')
assert(deniedDismiss.status === 403, '非本机来源触发 dismiss 同样被拒')
const deniedSnooze = await call('/dsh-git-update-notifier/snooze?days=7', 'POST', '8.8.4.4')
assert(deniedSnooze.status === 403, '非本机来源触发 snooze 同样被拒')

console.log('\n=== 3. 回退入口 ===')
const rollbackNoPoint = await call('/dsh-git-update-notifier/rollback')
assert(rollbackNoPoint.status === 409, `尚无更新记录时回退被拒（HTTP ${rollbackNoPoint.status}）`)
const rollbackForeign = await call('/dsh-git-update-notifier/rollback', 'POST', '8.8.4.4')
assert(rollbackForeign.status === 403, '非本机来源触发回退同样被拒')
const targets = await call('/dsh-git-update-notifier/rollback/targets.json', 'GET')
assert(targets.status === 200, `可选目标路由可用（HTTP ${targets.status}）`)
const targetBody = JSON.parse(targets.body)
assert(Array.isArray(targetBody.targets), '可选目标以数组返回')
console.log(`     可选目标 ${targetBody.targets.length} 项：${targetBody.targets.map((item) => item.label).join(' / ') || '（无）'}`)
const badTarget = await call('/dsh-git-update-notifier/rollback?target=..%2F..%2Fetc', 'POST')
assert(badTarget.status === 400, `非法 target 被拒（HTTP ${badTarget.status}）`)

console.log('\n=== 4. 延期参数校验与上限 ===')
const snoozeWeek = await call('/dsh-git-update-notifier/snooze?days=7')
const weekBody = JSON.parse(snoozeWeek.body)
assert(snoozeWeek.status === 200 && weekBody.days === 7, `days=7 被接受（HTTP ${snoozeWeek.status}，days=${weekBody.days}）`)
assert(typeof weekBody.snoozeUntil === 'string' && weekBody.snoozeUntil !== '', '返回延期到期时间')
const snoozeMonth = await call('/dsh-git-update-notifier/snooze?days=999')
const monthBody = JSON.parse(snoozeMonth.body)
assert(monthBody.days === 30, `超大天数被钳制到一个月的上限 30（实际 ${monthBody.days}）`)
const statusAfterSnooze = await call('/dsh-git-update-notifier/status.json', 'GET')
const afterBody = JSON.parse(statusAfterSnooze.body)
assert(afterBody.snoozed === true, '快照反映为「已延期」')
assert(typeof afterBody.snoozeUntil === 'string', '快照带出延期到期时间')

const snoozeCancel = await call('/dsh-git-update-notifier/snooze?days=0')
const cancelBody = JSON.parse(snoozeCancel.body)
assert(snoozeCancel.status === 200 && cancelBody.cancelled === true,
  `days=0 表示取消延期（HTTP ${snoozeCancel.status}）`)
const canceledStatus = await call('/dsh-git-update-notifier/status.json', 'GET')
assert(JSON.parse(canceledStatus.body).snoozed === false, '取消后快照的 snoozed 变为 false')

const snoozeNegative = await call('/dsh-git-update-notifier/snooze?days=-1')
assert(snoozeNegative.status === 400, `days=-1 仍被拒绝（HTTP ${snoozeNegative.status}）`)
const snoozeMissing = await call('/dsh-git-update-notifier/snooze')
assert(snoozeMissing.status === 400, `缺少 days 被拒绝（HTTP ${snoozeMissing.status}）`)

console.log('\n=== 5. 方法限制 ===')
const wrongMethod = await call('/dsh-git-update-notifier/status.json', 'POST')
assert(wrongMethod.status === 405, `status.json 拒绝 POST（HTTP ${wrongMethod.status}）`)

console.log('\n=== 6. 找不到 checkout 时降级，而不是抛错 ===')
const checked = await call('/dsh-git-update-notifier/check')
const parsed = JSON.parse(checked.body)
assert(checked.status === 200, `check 返回 HTTP ${checked.status}`)
assert(parsed.status === 'error', `状态降级为 error（实际 ${parsed.status}）`)
assert(typeof parsed.message === 'string' && parsed.message !== '', '带上了可读的失败原因')

console.log('\n=== 7. GET status.json ===')
const status = await call('/dsh-git-update-notifier/status.json', 'GET')
assert(status.status === 200, `HTTP ${status.status}`)
assert(JSON.parse(status.body).day !== undefined, '返回了当天日期字段')

console.log('\n=== 8. 更新进度与中断下载 ===')
const progressIdle = await call('/dsh-git-update-notifier/progress.json', 'GET')
assert(progressIdle.status === 200, `进度路由可用（HTTP ${progressIdle.status}）`)
const idleBody = JSON.parse(progressIdle.body)
assert(idleBody.busy === false, '没有更新任务在跑时 busy 为 false')
assert(idleBody.progress === null, '没有任务时进度为 null')
assert(idleBody.pendingDownload === null || typeof idleBody.pendingDownload === 'object',
  '带出磁盘上的下载断点字段（跨进程可见）')
const progressPost = await call('/dsh-git-update-notifier/progress.json')
assert(progressPost.status === 405, `进度路由拒绝 POST（HTTP ${progressPost.status}）`)
const cancelIdle = await call('/dsh-git-update-notifier/download/cancel')
assert(cancelIdle.status === 409, `没有下载在跑时取消返回 409（实际 ${cancelIdle.status}）`)
const cancelForeign = await call('/dsh-git-update-notifier/download/cancel', 'POST', '8.8.4.4')
assert(cancelForeign.status === 403, '非本机来源触发取消被拒')
const cancelGet = await call('/dsh-git-update-notifier/download/cancel', 'GET')
assert(cancelGet.status === 405, `取消路由拒绝 GET（HTTP ${cancelGet.status}）`)

console.log('\n=== 9. 安装失败后的重试入口 ===')
const retryIdle = await call('/dsh-git-update-notifier/update/retry')
assert(retryIdle.status === 409, `没有安装失败记录时重试返回 409（实际 ${retryIdle.status}）`)
const retryForeign = await call('/dsh-git-update-notifier/update/retry', 'POST', '8.8.4.4')
assert(retryForeign.status === 403, '非本机来源触发重试被拒')
const retryGet = await call('/dsh-git-update-notifier/update/retry', 'GET')
assert(retryGet.status === 405, `重试路由拒绝 GET（HTTP ${retryGet.status}）`)

const statusBody = JSON.parse((await call('/dsh-git-update-notifier/status.json', 'GET')).body)
assert(statusBody.stagedPackage === null, '没有待安装的包时 stagedPackage 为 null')
assert(statusBody.lastUpdate === null || typeof statusBody.lastUpdate === 'object',
  '快照带出「上一次更新结论」字段')

console.log('\n=== 10. 失败诊断 ===')
const diagnostics = await call('/dsh-git-update-notifier/diagnostics.json', 'GET')
assert(diagnostics.status === 200, `诊断路由可用（HTTP ${diagnostics.status}）`)
const diagnosticsBody = JSON.parse(diagnostics.body)
assert(diagnosticsBody.ok === true, '返回 ok')
assert(diagnosticsBody.latest === null, '还没失败过时没有「最近一次现场」')
assert(diagnosticsBody.summary === null || typeof diagnosticsBody.summary === 'object', '带出失败摘要字段')
assert(diagnosticsBody.content === null, '没有诊断文件时内容为 null')
const diagnosticsPost = await call('/dsh-git-update-notifier/diagnostics.json')
assert(diagnosticsPost.status === 405, `诊断路由拒绝 POST（HTTP ${diagnosticsPost.status}）`)

console.log('')
if (failed > 0) {
  console.error(`${failed} 项失败`)
  process.exit(1)
}
console.log('全部通过。')
process.exit(0)
