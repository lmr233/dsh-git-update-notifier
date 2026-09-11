/**
 * 插件"自身更新检测"的测试。
 *
 * 两部分：
 * 1. **本地定位与形态判定** —— 用临时目录构造出 `node_modules/<pkg>`、
 *    `node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>`、`github:` 声明等真实布局；
 * 2. **远端查询** —— 用本地 http server 充当 GitHub API，验证 release 优先、
 *    tags 回退、`v` 前缀剥离与失败路径，全程不联网。
 */

import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  fetchGithubLatest,
  readSelfManifest,
  selfDependencySpec,
  selfLayout,
  selfPackageDir,
  selfProfileRoot,
  selfRepo,
} from '../lib/selfcheck.js'

let failures = 0
function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`)
    return
  }
  console.error(`  ✗ ${message}`)
  failures += 1
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-selfcheck-test-'))

/** 造一个 profile：<root>/package.json + <root>/node_modules/<pkg>/package.json */
function makeProfile(name, dependencies, { pnpm = false, packageName = 'dsh-git-update-notifier', version = '0.2.7' } = {}) {
  const root = join(ROOT, name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name, private: true, dependencies }, null, 2)}\n`)
  const packageDir = pnpm
    ? join(root, 'node_modules', '.pnpm', `${packageName}@${version}`, 'node_modules', packageName)
    : join(root, 'node_modules', packageName)
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({
    name: packageName,
    version,
    repository: { type: 'git', url: 'git+https://github.com/lmr233/dsh-git-update-notifier.git' },
  }, null, 2)}\n`)
  return { root, packageDir }
}

console.log('=== 1. 仓库地址解析 ===')
{
  assert(selfRepo({ repository: { url: 'git+https://github.com/lmr233/dsh-git-update-notifier.git' } })
    === 'lmr233/dsh-git-update-notifier', '解析 git+https 形式并去掉 .git')
  assert(selfRepo({ repository: 'https://github.com/o/r' }) === 'o/r', '兼容 repository 为字符串')
  assert(selfRepo({ repository: { url: 'git@github.com:o/r.git' } }) === 'o/r', '解析 SSH 形式')
  assert(selfRepo({}) === undefined, '没有 repository 字段时返回 undefined')
  assert(selfRepo({ repository: { url: 'https://gitlab.com/o/r' } }) === undefined, '非 GitHub 地址返回 undefined')
}

console.log('\n=== 2. 自己在哪里 ===')
{
  const packageDir = selfPackageDir()
  const manifest = readSelfManifest()
  assert(String(manifest?.name).includes('dsh-git-update-notifier'), `读到自己的清单（${manifest?.name}）`)
  assert(typeof manifest?.version === 'string' && manifest.version !== '', `读到自己的版本（${manifest?.version}）`)
  assert(packageDir.endsWith('dsh-git-update-notifier'), `包目录指向仓库根（${packageDir}）`)
  assert(selfProfileRoot() === undefined, '开发目录不在 node_modules 里，profile 根判定为 undefined')
}

console.log('\n=== 3. 形态判定：依赖怎么声明的 ===')
{
  const plain = makeProfile('plain', { 'dsh-git-update-notifier': '^0.2.7' })
  assert(selfDependencySpec(plain.root) === '^0.2.7', '读到 semver 声明')
  assert(selfDependencySpec(plain.root, 'not-here') === undefined, '没声明的包返回 undefined')

  const github = makeProfile('gh', { 'dsh-git-update-notifier': 'github:lmr233/dsh-git-update-notifier' })
  assert(selfDependencySpec(github.root) === 'github:lmr233/dsh-git-update-notifier', '读到 github: 声明')

  const dev = makeProfile('dev', {})
  writeFileSync(join(dev.root, 'package.json'), `${JSON.stringify({
    name: 'dev',
    devDependencies: { 'dsh-git-update-notifier': 'file:../plugin' },
  })}\n`)
  assert(selfDependencySpec(dev.root) === 'file:../plugin', 'devDependencies 也认')

  const pnpm = makeProfile('pnpmish', { 'dsh-git-update-notifier': '^0.2.7' }, { pnpm: true })
  assert(selfDependencySpec(pnpm.root) === '^0.2.7', 'pnpm 布局下同样读得到声明')
}

console.log('\n=== 4. 当前工作副本的形态 ===')
{
  const layout = selfLayout()
  console.log(`  kind=${layout.kind}  version=${layout.version}  packageDir=${layout.packageDir}`)
  assert(layout.kind === 'checkout' || layout.kind === 'manual',
    `本仓库是 git 检出或手工副本（实际 ${layout.kind}）`)
  if (layout.kind === 'checkout') {
    assert(typeof layout.gitRoot === 'string' && layout.gitRoot !== '', 'git 检出时给出了仓库根')
  }
  assert(layout.version === readSelfManifest()?.version, '形态判定带出了自己的版本号')
}

console.log('\n=== 5. GitHub 查询：release 优先 ===')
{
  const server = createServer((req, res) => {
    if (req.url.includes('/releases/latest')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ tag_name: 'v0.9.9', published_at: '2026-09-11T00:00:00Z', html_url: 'https://example.test/r' }))
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  process.env.DSH_GIT_UPDATE_NOTIFIER_GITHUB_API = `http://127.0.0.1:${server.address().port}`

  const result = await fetchGithubLatest('lmr233/dsh-git-update-notifier')
  assert(result.ok === true, '查询成功')
  assert(result.version === '0.9.9', `去掉了 tag 的 v 前缀（${result.version}）`)
  assert(result.source === 'github-release', '来源标为 release')
  assert(String(result.detail).includes('2026-09-11'), '带出发布日期')
  server.close()
}

console.log('\n=== 6. GitHub 查询：没有 release 时回退到 tags ===')
{
  const server = createServer((req, res) => {
    if (req.url.includes('/tags')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ name: 'v1.2.3' }, { name: 'v1.2.2' }]))
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  process.env.DSH_GIT_UPDATE_NOTIFIER_GITHUB_API = `http://127.0.0.1:${server.address().port}`

  const result = await fetchGithubLatest('o/r')
  assert(result.ok === true, 'release 缺失时仍然查得到')
  assert(result.version === '1.2.3', `取第一个 tag 并去前缀（${result.version}）`)
  assert(result.source === 'github-tag', '来源标为 tag')
  server.close()
}

console.log('\n=== 7. GitHub 查询：两个都失败时给出原因 ===')
{
  const server = createServer((req, res) => {
    res.writeHead(500)
    res.end('boom')
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  process.env.DSH_GIT_UPDATE_NOTIFIER_GITHUB_API = `http://127.0.0.1:${server.address().port}`

  const result = await fetchGithubLatest('o/r')
  assert(result.ok === false, '失败时明确报错')
  assert(typeof result.error === 'string' && result.error !== '', `带上了原因（${result.error}）`)
  server.close()
}

console.log('\n=== 8. GitHub 查询：地址非法 ===')
{
  const result = await fetchGithubLatest('')
  assert(result.ok === false && String(result.error).includes('仓库地址'), '没有仓库地址时直接拒绝')
}

delete process.env.DSH_GIT_UPDATE_NOTIFIER_GITHUB_API
rmSync(ROOT, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过。')
