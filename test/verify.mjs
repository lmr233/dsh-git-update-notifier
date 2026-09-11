/**
 * 更新包校验测试。
 *
 * 全程离线：自己手写一个最小 tar（UStar）+ gzip，就得到一个"合法"的 npm tarball，
 * 于是可以精确构造出篡改过的包、身份不符的包、缺清单的包、没有凭据的包。
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { parseIntegrity, readTarEntry, verifyTarball } from '../lib/verify.js'

let failures = 0
function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`)
    return
  }
  console.error(`  ✗ ${message}`)
  failures += 1
}

/** 拼一个 UStar 条目（含 checksum 计算与 512 对齐）。 */
function tarEntry(name, content) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write('0000644\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  header.write('00000000000\0', 136, 'ascii')
  header.write('        ', 148, 'ascii')
  header.write('0', 156, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512)
  return Buffer.concat([header, content, padding])
}

function makeTarball(manifest, extraFiles = []) {
  const parts = [tarEntry('package/package.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))]
  for (const [name, text] of extraFiles) parts.push(tarEntry(name, Buffer.from(text)))
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

const sha512 = (buffer) => createHash('sha512').update(buffer).digest('base64')
const sha1 = (buffer) => createHash('sha1').update(buffer).digest('hex')

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-verify-test-'))
const MANIFEST = { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' }
const tarball = makeTarball(MANIFEST, [['package/lib/index.js', 'export const x = 1\n']])

const good = join(ROOT, 'good.tgz')
writeFileSync(good, tarball)
const proof = { integrity: `sha512-${sha512(tarball)}`, shasum: sha1(tarball), name: MANIFEST.name, version: MANIFEST.version }

console.log('=== 1. integrity 解析 ===')
assert(parseIntegrity('sha512-abc+/=')?.algorithm === 'sha512', '识别 sha512')
assert(parseIntegrity('sha1-ZGVhZGJlZWY=')?.algorithm === 'sha1', '识别 sha1')
assert(parseIntegrity('sha512-aaa sha1-bbb')?.algorithm === 'sha512', '多值取第一条可识别的')
assert(parseIntegrity('md5-xxxx') === undefined, '不认识的算法返回 undefined')
assert(parseIntegrity(undefined) === undefined, '非字符串返回 undefined')
assert(parseIntegrity('  sha512-dGVzdA==  ')?.digest === 'dGVzdA==', '容忍首尾空白')

console.log('\n=== 2. 正常包：三层校验全部通过 ===')
const passed = await verifyTarball(good, proof)
assert(passed.ok === true, `校验通过（${passed.message}）`)
assert(passed.manifest?.version === MANIFEST.version, '返回了包内清单')
assert(passed.checks.length === 3, `三层都跑了：${passed.checks.map((item) => item.label).join('、')}`)

console.log('\n=== 3. 篡改一个字节就被发现 ===')
const tamperedBuffer = Buffer.from(tarball)
tamperedBuffer[tamperedBuffer.length - 20] ^= 0xff
const tampered = join(ROOT, 'tampered.tgz')
writeFileSync(tampered, tamperedBuffer)
const caught = await verifyTarball(tampered, proof)
assert(caught.ok === false, '被篡改的包被拒绝')
assert(caught.checks.some((item) => item.label.startsWith('包完整性') && item.ok === false), '失败项包含完整性校验')
assert(caught.message.startsWith('校验失败'), '结果里给出了失败原因')

console.log('\n=== 4. 版本对不上：包身份拦住 ===')
const wrongVersion = await verifyTarball(good, { ...proof, version: '0.1.5-rc.3' })
assert(wrongVersion.ok === false, '版本不符被拒绝')
const identity = wrongVersion.checks.find((item) => item.label === '包身份')
assert(identity?.ok === false, '失败项是包身份')
assert(String(identity.detail).includes('0.1.5-rc.3'), '原因里写明了期望的版本')

console.log('\n=== 5. 包名对不上同样被拦 ===')
const wrongName = await verifyTarball(good, { ...proof, name: '@deepseek-ai/other' })
assert(wrongName.ok === false, '包名不符被拒绝')

console.log('\n=== 6. registry 没给凭据就拒绝安装 ===')
const noProof = await verifyTarball(good, { name: MANIFEST.name, version: MANIFEST.version })
assert(noProof.ok === false, '没有任何校验凭据时拒绝')
assert(noProof.checks.some((item) => item.label === '可校验性' && item.ok === false), '并说明了原因')

console.log('\n=== 7. 只有 shasum 也算凭据 ===')
const shasumOnly = await verifyTarball(good, {
  shasum: sha1(tarball),
  name: MANIFEST.name,
  version: MANIFEST.version,
})
assert(shasumOnly.ok === true, 'sha1 单独存在时可以通过')

console.log('\n=== 8. 缺 package.json 的包被拒 ===')
const noManifestBuffer = gzipSync(Buffer.concat([
  tarEntry('package/lib/x.js', Buffer.from('x\n')),
  Buffer.alloc(1024),
]))
const noManifest = join(ROOT, 'no-manifest.tgz')
writeFileSync(noManifest, noManifestBuffer)
const missing = await verifyTarball(noManifest, {
  shasum: sha1(noManifestBuffer),
  name: MANIFEST.name,
  version: MANIFEST.version,
})
assert(missing.ok === false, '没有清单的包被拒')
assert(missing.checks.some((item) => item.label === '包身份' && item.ok === false), '失败项是包身份')

console.log('\n=== 9. 直接按名字读条目 ===')
const raw = await readTarEntry(good, 'package/package.json')
assert(JSON.parse(raw.toString('utf8')).version === MANIFEST.version, '取到 package.json')
const deep = await readTarEntry(good, 'package/lib/index.js')
assert(String(deep).includes('export const x'), '能取到包内深层文件')
const absent = await readTarEntry(good, 'package/nope.txt')
assert(absent === undefined, '不存在的条目返回 undefined')

rmSync(ROOT, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过。')
