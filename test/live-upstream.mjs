/**
 * 真实上游验证：用真实系统代理探测 + 真实 deepseek-harness checkout，
 * 走一遍完整检查链路，确认"经代理抓取上游"真的能跑通。
 *
 * 与 e2e-local-repo.mjs 的区别：那个用本地 file:// 仓库保证可重复；
 * 这个用真实远端，验证代理探测与回退逻辑，因此依赖网络。
 *
 * 副作用：会真实执行 git fetch（只写 .git，不动工作区），
 * 并把检查结果写进真实的 $DSH_HOME 状态文件——这正是插件在真机上的行为。
 *
 * 用法：node test/live-upstream.mjs
 */

import { apply } from '../lib/index.js'

const routes = []
const logs = []

const ctx = {
  logger: {
    info: (m) => { logs.push(`info  ${m}`); console.log(`  ${m}`) },
    warn: (m) => { logs.push(`warn  ${m}`); console.log(`  ${m}`) },
    error: (m) => { logs.push(`error ${m}`); console.log(`  ${m}`) },
  },
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

console.log('=== 挂载宿主端插件（真实 DSH_HOME / 真实 checkout / 真实系统代理）===')
apply(ctx)

function makeRes() {
  let body = ''
  return {
    res: {
      statusCode: 200,
      setHeader() {},
      end(chunk) { if (chunk !== undefined) body += String(chunk) },
    },
    text: () => body,
  }
}

async function call(path, method = 'POST', remoteAddress = '127.0.0.1') {
  const route = routes.find((candidate) => candidate.path === path)
  if (route === undefined) throw new Error(`route not found: ${path}`)
  const { res, text } = makeRes()
  await route.handler({ method, socket: { remoteAddress } }, res)
  return { status: res.statusCode, body: JSON.parse(text()) }
}

console.log('\n=== POST /check（真实 git fetch，经探测到的代理）===')
const checked = await call('/dsh-git-update-notifier/check')
console.log(`\nHTTP ${checked.status}`)
console.log(JSON.stringify(checked.body, null, 2))

const body = checked.body

// 成功时必须没有上一轮失败残留的说明字段（快照是磁盘态 + 本次增量合并的）。
if ((body.status === 'update-available' || body.status === 'up-to-date')
  && body.message !== null && body.message !== undefined) {
  console.error(`\n✗ 成功结果里残留了 message：${body.message}`)
  process.exit(1)
}

if (body.status === 'update-available') {
  console.log(`\n✓ 经代理抓取成功：上游领先 ${body.behind} 个提交`)
  console.log(`  本地 ${String(body.localHead).slice(0, 9)} → 远端 ${String(body.remoteHead).slice(0, 9)}`)
  console.log(`  viaProxy = ${body.viaProxy}，proxy = ${body.proxy}`)
  if (Array.isArray(body.subjects) && body.subjects.length > 0) {
    console.log('  最新提交：')
    for (const line of body.subjects.slice(0, 5)) console.log(`    ${line}`)
  }
} else if (body.status === 'up-to-date') {
  console.log(`\n✓ 经代理抓取成功：已是最新（${String(body.localHead).slice(0, 9)}，viaProxy=${body.viaProxy}）`)
} else {
  console.log(`\n✗ 检查未成功（status=${body.status}）：${body.message}`)
  console.log(`  proxy = ${body.proxy}`)
  process.exit(1)
}

if (body.viaProxy !== true) {
  console.log('\n注意：这次是直连成功的，没走代理。')
}

process.exit(0)
