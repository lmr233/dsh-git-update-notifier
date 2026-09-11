/**
 * 端到端验证：用本地 bare 仓库模拟"上游有新提交"的真实场景。
 *
 * 不依赖外网，因此可重复。验证内容：
 * 1. 检测出现在 update-available、behind 正确、提交摘要正确；
 * 2. POST /update 真的推进了本地 checkout 的 HEAD；
 * 3. POST /dismiss 让当天不再询问；
 * 4. 同一天内"第二次启动"只跳过、不重复 fetch（用户选定的触发语义）。
 *
 * 用法：node test/e2e-local-repo.mjs
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 放在系统临时目录下：跨平台（Windows 与 CI 的 Linux runner 都能跑），
// 也不会污染仓库或用户工作区。
const ROOT = join(tmpdir(), 'dsh-git-update-notifier-e2e')
const UPSTREAM = join(ROOT, 'upstream.git')
const LOCAL = join(ROOT, 'local')
const OTHER = join(ROOT, 'other')

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function fail(message) {
  console.error(`\n✗ 断言失败：${message}`)
  process.exit(1)
}

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`)
    return
  }
  fail(message)
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// ---------------------------------------------------------------- 造两个仓库
console.log('=== 1. 构造本地仓库：local 落后 upstream 一个提交 ===')
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })

git(['init', '--bare', '--initial-branch=master', UPSTREAM], ROOT)
git(['clone', UPSTREAM, LOCAL], ROOT)
git(['config', 'user.email', 'test@example.com'], LOCAL)
git(['config', 'user.name', 'Test'], LOCAL)
// 让这个模拟仓库能被识别为"dsh 本体的源码 checkout"：形态判定会读取
// package.json 的 name 是否等于 @deepseek-ai/dsh。
writeFileSync(join(LOCAL, 'package.json'),
  `${JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.1' }, null, 2)}\n`)
writeFileSync(join(LOCAL, 'a.txt'), 'one\n')
git(['add', '.'], LOCAL)
git(['commit', '-m', 'first commit'], LOCAL)
git(['push', 'origin', 'master'], LOCAL)

git(['clone', UPSTREAM, OTHER], ROOT)
git(['config', 'user.email', 'test@example.com'], OTHER)
git(['config', 'user.name', 'Test'], OTHER)
writeFileSync(join(OTHER, 'b.txt'), 'two\n')
// 顺带把上游版本号抬高一档，用来验证「版本号方式」的展示。
writeFileSync(join(OTHER, 'package.json'),
  `${JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.2' }, null, 2)}\n`)
git(['add', '.'], OTHER)
git(['commit', '-m', 'upstream: 新增 b.txt'], OTHER)
git(['push', 'origin', 'master'], OTHER)

console.log(`  local    = ${git(['rev-parse', 'HEAD'], LOCAL)}`)
console.log(`  upstream = ${git(['rev-parse', 'HEAD'], UPSTREAM)}`)

// ---------------------------------------------------------------- 驱动插件
console.log('\n=== 2. 用假 ctx 挂载宿主端插件 ===')
process.env.DSH_HOME = join(ROOT, 'dsh-home')
process.env.DSH_GIT_UPDATE_NOTIFIER_ROOT = LOCAL
// 本地 file:// 仓库与代理无关，显式关闭探测以保证测试结果纯净。
process.env.DSH_GIT_UPDATE_NOTIFIER_PROXY = 'none'

const { apply } = await import('../lib/index.js')

const logs = []
const routes = []

function makeCtx() {
  return {
    logger: {
      info: (m) => logs.push(`info  ${m}`),
      warn: (m) => logs.push(`warn  ${m}`),
      error: (m) => logs.push(`error ${m}`),
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
}

apply(makeCtx())
assert(routes.length === 4, `注册了 4 条路由（实际 ${routes.length}）`)

function makeRes() {
  let body = ''
  return {
    res: {
      statusCode: 200,
      headers: {},
      setHeader(name, value) { this.headers[name] = value },
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

// ---------------------------------------------------------------- 检查
console.log('\n=== 3. POST /check：应发现落后 1 个提交 ===')
const checked = await call('/dsh-git-update-notifier/check')
console.log(`  HTTP ${checked.status}  status=${checked.body.status}  behind=${checked.body.behind}`)
assert(checked.body.status === 'update-available', 'status 是 update-available')
assert(checked.body.behind === 1, 'behind 等于 1')
assert(Array.isArray(checked.body.subjects) && checked.body.subjects.length === 1,
  '取到 1 条上游提交摘要')
assert(String(checked.body.subjects[0]).includes('新增 b.txt'), `摘要内容正确：${checked.body.subjects[0]}`)
assert(checked.body.branch === 'master', '分支识别为 master')
assert(checked.body.source === 'git', `检测源为 git（实际 ${checked.body.source}）`)
assert(checked.body.layout === 'source', `形态识别为源码 checkout（实际 ${checked.body.layout}）`)
assert(checked.body.localVersion === '0.0.1', `本地版本为 0.0.1（实际 ${checked.body.localVersion}）`)
assert(checked.body.remoteVersion === '0.0.2', `上游版本为 0.0.2（实际 ${checked.body.remoteVersion}）`)

console.log('\n=== 4. GET /status.json：checkedToday 应为 true ===')
const status = await call('/dsh-git-update-notifier/status.json', 'GET')
assert(status.body.checkedToday === true, 'checkedToday 为 true（今天已检查）')
assert(status.body.dismissed === false, 'dismissed 为 false（尚未处理）')

// ---------------------------------------------------------------- 更新
console.log('\n=== 5. POST /update：应真的推进 HEAD ===')
const headBefore = git(['rev-parse', 'HEAD'], LOCAL)
const updated = await call('/dsh-git-update-notifier/update')
const headAfter = git(['rev-parse', 'HEAD'], LOCAL)
console.log(`  HTTP ${updated.status}  ${updated.body.message}`)
assert(updated.status === 200 && updated.body.ok === true, '更新返回成功')
assert(headBefore !== headAfter, `HEAD 已推进：${headBefore.slice(0, 9)} → ${headAfter.slice(0, 9)}`)
assert(headAfter === git(['rev-parse', 'HEAD'], UPSTREAM), '本地 HEAD 与上游一致')
assert(updated.body.needsRestart === true, '提示需要重新构建并重启')

const afterUpdate = await call('/dsh-git-update-notifier/status.json', 'GET')
assert(afterUpdate.body.dismissed === true, '更新后当天不再询问')

// ---------------------------------------------------------------- 稍后
console.log('\n=== 6. POST /dismiss：写回状态且幂等 ===')
const dismissed = await call('/dsh-git-update-notifier/dismiss')
assert(dismissed.status === 200 && dismissed.body.ok === true, 'dismiss 返回成功')

// ------------------------------------------------- 同一天内第二次启动
console.log('\n=== 7. 模拟当天第二次启动：应跳过、不重复检查 ===')
const logCountBefore = logs.filter((line) => line.includes('检查更新：')).length
apply(makeCtx())
await sleep(6_500)
const skipLogged = logs.some((line) => line.includes('跳过启动补检'))
const logCountAfter = logs.filter((line) => line.includes('检查更新：')).length
assert(skipLogged, '第二次启动打印了「跳过启动补检」')
assert(logCountAfter === logCountBefore, '第二次启动没有再执行实际检查')

// ---------------------------------------------------------------- 安全
console.log('\n=== 8. 非本机来源应被拒绝 ===')
const denied = await call('/dsh-git-update-notifier/update', 'POST', '10.0.0.5')
assert(denied.status === 403, '非 loopback 的写请求返回 403')

console.log('\n=== 9. 抓取失败时，成功态的字段必须被清空 ===')
git(['remote', 'set-url', 'origin', join(ROOT, 'missing.git')], LOCAL)
const failedAgain = await call('/dsh-git-update-notifier/check')
console.log(`  status=${failedAgain.body.status}`)
assert(failedAgain.body.status === 'error', '抓取失败时 status 为 error')
assert(typeof failedAgain.body.message === 'string' && failedAgain.body.message !== '', '带上了失败原因')
assert(failedAgain.body.behind === null, `behind 被清空（实际 ${JSON.stringify(failedAgain.body.behind)}）`)
assert(Array.isArray(failedAgain.body.subjects) && failedAgain.body.subjects.length === 0, 'subjects 被清空')
assert(failedAgain.body.remoteHead === null, 'remoteHead 被清空')
git(['remote', 'set-url', 'origin', UPSTREAM], LOCAL)

console.log('\n全部断言通过。\n')
console.log('--- 插件日志 ---')
for (const line of logs) console.log(`  ${line}`)
process.exit(0)
