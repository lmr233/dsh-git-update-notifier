/**
 * npx / npm 形态的检测测试。
 *
 * 全程离线：registry 用一个本地 HTTP server 顶替，本体用一个临时目录伪造出
 * npx 缓存的目录形状（`.../_npx/<hash>/node_modules/@deepseek-ai/dsh`）。
 * 因此这个用例可以安全地进 CI。
 *
 * 覆盖：
 * 1. 形态识别 —— `_npx` 路径判为 npx；无项目根且非源码判为 npm 全局；
 * 2. 检测源切换 —— 非源码形态走 registry，而不是 git；
 * 3. 通道选择 —— 默认 latest，可用环境变量切到 next / alpha；
 * 4. semver 结论真正驱动 status（可升级 / 已最新）；
 * 5. registry 不可达时降级为 error 而不是抛错。
 *
 * 用法：node test/npm-layout.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0
function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`)
    return
  }
  failed += 1
  console.error(`  ✗ ${message}`)
}

// ------------------------------------------------------------ 本地 mock registry
let distTags = { latest: '0.2.0', next: '0.3.0', alpha: '0.3.0-alpha.1' }
let registryOnline = true

const server = http.createServer((req, res) => {
  if (!registryOnline) {
    req.socket.destroy()
    return
  }
  if (req.url.includes('/dist-tags')) {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(distTags))
    return
  }
  res.statusCode = 404
  res.end('{}')
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const registryUrl = `http://127.0.0.1:${server.address().port}`
console.log(`本地 mock registry：${registryUrl}\n`)

// ------------------------------------------------------------ 伪造安装目录
const ROOT = mkdtempSync(join(tmpdir(), 'dsh-gun-npm-'))

/** 造一个 npx 缓存形状的安装：`<root>/_npx/<hash>/node_modules/@deepseek-ai/dsh`。 */
function makeNpxInstall(version, hash = 'abcdef0123456789') {
  const project = join(ROOT, '_npx', hash)
  const pkgDir = join(project, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(project, 'package.json'),
    `${JSON.stringify({ dependencies: { '@deepseek-ai/dsh': `^${version}` }, _npx: { packages: ['@deepseek-ai/dsh'] } }, null, 2)}\n`)
  writeFileSync(join(pkgDir, 'package.json'),
    `${JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' } }, null, 2)}\n`)
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  writeFileSync(join(pkgDir, 'lib', 'bin.js'), '// stub\n')
  return pkgDir
}

/** 造一个全局安装形状：`<root>/global/lib/node_modules/@deepseek-ai/dsh`（各级都无 package.json）。 */
function makeGlobalInstall(version) {
  const prefix = join(ROOT, 'global')
  const pkgDir = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'),
    `${JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' } }, null, 2)}\n`)
  return pkgDir
}

const npxInstall = makeNpxInstall('0.1.5-rc.1')
const globalInstall = makeGlobalInstall('0.1.5-rc.1')

// ------------------------------------------------------------ 驱动插件
process.env.DSH_HOME = join(ROOT, 'dsh-home')
process.env.DSH_GIT_UPDATE_NOTIFIER_PROXY = 'none'
process.env.DSH_GIT_UPDATE_NOTIFIER_REGISTRY = registryUrl
process.env.DSH_GIT_UPDATE_NOTIFIER_ROOT = npxInstall

const { apply } = await import('../lib/index.js')

const routes = []
const logs = []
const ctx = {
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
apply(ctx)

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

async function call(path, method = 'POST') {
  const route = routes.find((candidate) => candidate.path === path)
  if (route === undefined) throw new Error(`route not found: ${path}`)
  const { res, text } = makeRes()
  await route.handler({ method, socket: { remoteAddress: '127.0.0.1' } }, res)
  return { status: res.statusCode, body: JSON.parse(text()) }
}

console.log('=== 1. npx 缓存形态：识别 + 走 registry ===')
delete process.env.DSH_GIT_UPDATE_NOTIFIER_CHANNEL
let checked = await call('/dsh-git-update-notifier/check')
console.log(`  layout=${checked.body.layout}  source=${checked.body.source}  installKind=${checked.body.installKind}`)
console.log(`  local=${checked.body.localVersion}  channel=${checked.body.channel}  target=${checked.body.target}  status=${checked.body.status}`)
assert(checked.body.layout === 'npx', '形态识别为 npx 缓存')
assert(checked.body.source === 'npm', '检测源切换为 npm（而非 git）')
assert(checked.body.installKind === 'npx-cache', '安装类型为 npx-cache')
assert(checked.body.localVersion === '0.1.5-rc.1', '读到本地版本')
assert(checked.body.channel === 'latest', '默认使用 latest 通道')
assert(checked.body.status === 'update-available', 'latest=0.2.0 高于本地 → 有更新')
assert(checked.body.target === '0.2.0', '目标版本取自 latest')
assert(checked.body.layoutLabel === 'npx 缓存', '带上了可读的形态标签')

console.log('\n=== 2. 通道切换（dsh 的 latest 常落后于 next）===')
process.env.DSH_GIT_UPDATE_NOTIFIER_CHANNEL = 'next'
checked = await call('/dsh-git-update-notifier/check')
assert(checked.body.channel === 'next', '环境变量切到 next 通道')
assert(checked.body.target === '0.3.0', '目标版本取自 next')
process.env.DSH_GIT_UPDATE_NOTIFIER_CHANNEL = 'alpha'
checked = await call('/dsh-git-update-notifier/check')
assert(checked.body.target === '0.3.0-alpha.1', '目标版本取自 alpha')
delete process.env.DSH_GIT_UPDATE_NOTIFIER_CHANNEL

console.log('\n=== 3. 已是最新时不报更新 ===')
distTags = { latest: '0.1.5-rc.1', next: '0.1.5-rc.2' }
checked = await call('/dsh-git-update-notifier/check')
assert(checked.body.status === 'up-to-date', `latest 与本地相同时为 up-to-date（实际 ${checked.body.status}）`)

console.log('\n=== 4. 预发布比较真正生效 ===')
distTags = { latest: '0.1.5-rc.10', next: '0.1.5' }
checked = await call('/dsh-git-update-notifier/check')
assert(checked.body.status === 'update-available', 'rc.10 比 rc.1 新（按数值而非字符串比较）')
assert(checked.body.target === '0.1.5-rc.10', '目标为 rc.10')

console.log('\n=== 5. 全局安装形态（各级都无项目 package.json）===')
process.env.DSH_GIT_UPDATE_NOTIFIER_ROOT = globalInstall
const layoutReload = await import('../lib/index.js')
// 复用同一插件实例即可：每次 check 都会重新探测形态。
checked = await call('/dsh-git-update-notifier/check')
assert(checked.body.layout === 'npm', '判定为 npm 形态')
assert(checked.body.installKind === 'global', 'installKind 为 global（无项目根）')
assert(checked.body.layoutLabel === 'npm 全局安装', '标签为 npm 全局安装')

console.log('\n=== 6. 已是通道最新时，更新动作应拒绝而不是空跑 ===')
// latest 必须等于本地版本，才会走"无需更新"分支（否则真的会去执行 npm install）。
distTags = { latest: '0.1.5-rc.1', next: '0.1.5-rc.1' }
process.env.DSH_GIT_UPDATE_NOTIFIER_ROOT = npxInstall
const updated = await call('/dsh-git-update-notifier/update')
assert(updated.status === 500, `拒绝更新并返回 500（实际 ${updated.status}）`)
assert(String(updated.body.message).includes('已是'), `给出理由：${updated.body.message}`)

console.log('\n=== 7. registry 不可达时降级为 error ===')
registryOnline = false
checked = await call('/dsh-git-update-notifier/check')
assert(checked.body.status === 'error', 'status 为 error 而不是抛错')
assert(typeof checked.body.message === 'string' && checked.body.message !== '', '带上了失败原因')
assert(String(checked.body.hint).includes('REGISTRY'), '提示可用镜像环境变量')

server.close()
rmSync(ROOT, { recursive: true, force: true })

console.log('')
if (failed > 0) {
  console.error(`${failed} 项失败`)
  process.exit(1)
}
console.log('全部通过。')
process.exit(0)
