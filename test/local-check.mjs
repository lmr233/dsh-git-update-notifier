/**
 * 宿主端本地验证：不起 dsh，直接用假 ctx 驱动插件。
 *
 * 验证内容：
 * 1. apply() 能正常挂载并注册 4 条路由；
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
assert(routes.length === 4, `注册了 4 条路由（实际 ${routes.length}）`)
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
  const route = routes.find((candidate) => candidate.path === path)
  if (route === undefined) throw new Error(`route not found: ${path}`)
  const { res, text } = makeRes()
  await route.handler({ method, socket: { remoteAddress } }, res)
  return { status: res.statusCode, body: text() }
}

console.log('\n=== 2. loopback 网关（写操作只允许本机来源）===')
const deniedUpdate = await call('/dsh-git-update-notifier/update', 'POST', '192.168.1.20')
assert(deniedUpdate.status === 403, `非本机来源触发 update 被拒（HTTP ${deniedUpdate.status}）`)
const deniedCheck = await call('/dsh-git-update-notifier/check', 'POST', '10.0.0.5')
assert(deniedCheck.status === 403, '非本机来源触发 check 同样被拒')
const deniedDismiss = await call('/dsh-git-update-notifier/dismiss', 'POST', '::ffff:8.8.8.8')
assert(deniedDismiss.status === 403, '非本机来源触发 dismiss 同样被拒')

console.log('\n=== 3. 方法限制 ===')
const wrongMethod = await call('/dsh-git-update-notifier/status.json', 'POST')
assert(wrongMethod.status === 405, `status.json 拒绝 POST（HTTP ${wrongMethod.status}）`)

console.log('\n=== 4. 找不到 checkout 时降级，而不是抛错 ===')
const checked = await call('/dsh-git-update-notifier/check')
const parsed = JSON.parse(checked.body)
assert(checked.status === 200, `check 返回 HTTP ${checked.status}`)
assert(parsed.status === 'error', `状态降级为 error（实际 ${parsed.status}）`)
assert(typeof parsed.message === 'string' && parsed.message !== '', '带上了可读的失败原因')

console.log('\n=== 5. GET status.json ===')
const status = await call('/dsh-git-update-notifier/status.json', 'GET')
assert(status.status === 200, `HTTP ${status.status}`)
assert(JSON.parse(status.body).day !== undefined, '返回了当天日期字段')

console.log('')
if (failed > 0) {
  console.error(`${failed} 项失败`)
  process.exit(1)
}
console.log('全部通过。')
process.exit(0)
