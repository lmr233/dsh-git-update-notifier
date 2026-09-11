/**
 * 更新包校验。
 *
 * 下载到的 tarball 在交给 `npm install` 之前先自己验一遍，好处是**失败点提前且可解释**：
 * 网络截断会被判为"不完整"从而走续传，而不是让 npm 抛一段难懂的 tarball 解析错误。
 *
 * 三层校验，对应三种失效方式：
 *
 * 1. **内容寻址**（`dist.integrity`，通常是 sha512）—— 发现传输损坏与中途篡改；
 * 2. **经典校验和**（`dist.shasum`，sha1）—— registry 只给 shasum 时的兜底；
 * 3. **包身份**（tarball 内 `package/package.json` 的 name / version）—— 发现"下对了校验和
 *    但装错了包"这类 registry 元数据与包内容不一致的情况。
 *
 * 前两层至少要有其一，两层都缺就拒绝安装：没有凭据的包不装。
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createGunzip } from 'node:zlib'

const TAR_BLOCK = 512

/** package.json 不可能有这么大；超过就认为解析跑偏了。 */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024

/** 解析 SRI 形式的 integrity 字符串，例如 `sha512-3q2+...`。 */
export function parseIntegrity(text) {
  if (typeof text !== 'string') return undefined
  // 一个字段里可能有多条（空格分隔），取第一条可识别的。
  for (const piece of text.trim().split(/\s+/)) {
    const matched = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/=]+)$/.exec(piece)
    if (matched !== null) return { algorithm: matched[1], digest: matched[2] }
  }
  return undefined
}

function hashFile(file, algorithm, encoding) {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm)
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest(encoding)))
  })
}

/** tar header 里的文件名（name 被截断时用 prefix 补全，UStar 格式）。 */
function readTarName(header) {
  const name = header.toString('utf8', 0, 100).replace(/\0[\s\S]*$/, '')
  const prefix = header.toString('utf8', 345, 500).replace(/\0[\s\S]*$/, '')
  if (prefix === '') return name
  return `${prefix}/${name}`
}

/** tar header 里的长度字段是 12 位八进制 ASCII。 */
function readTarSize(header) {
  const raw = header.toString('utf8', 124, 136).replace(/\0[\s\S]*$/, '').trim()
  if (raw === '') return 0
  const size = Number.parseInt(raw, 8)
  return Number.isFinite(size) && size >= 0 ? size : 0
}

/**
 * 顺序扫描 gzip 后的 tar，取出指定名字的条目。
 *
 * 不整包读进内存：逐块前进，只把目标条目的数据留下。找不到返回 `undefined`。
 */
export function readTarEntry(gzipFile, entryName) {
  return new Promise((resolve, reject) => {
    const source = createReadStream(gzipFile)
    const gunzip = createGunzip()
    let buffer = Buffer.alloc(0)
    let skipping = 0
    let collecting = null
    let settled = false

    const finish = (value) => {
      if (settled) return
      settled = true
      source.destroy()
      gunzip.destroy()
      resolve(value)
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      source.destroy()
      gunzip.destroy()
      reject(error)
    }

    function drain() {
      for (;;) {
        if (skipping > 0) {
          const take = Math.min(skipping, buffer.length)
          buffer = buffer.subarray(take)
          skipping -= take
          if (buffer.length === 0) return
        }

        if (collecting !== null) {
          const take = Math.min(collecting.left, buffer.length)
          if (take > 0) {
            collecting.chunks.push(buffer.subarray(0, take))
            collecting.left -= take
            buffer = buffer.subarray(take)
          }
          if (collecting.left === 0) {
            finish(Buffer.concat(collecting.chunks))
            return
          }
          return
        }

        if (buffer.length < TAR_BLOCK) return
        const header = buffer.subarray(0, TAR_BLOCK)
        buffer = buffer.subarray(TAR_BLOCK)

        // 连续两个全零块表示归档结束；这里遇到第一个就收工。
        if (header.every((byte) => byte === 0)) {
          finish(undefined)
          return
        }

        const name = readTarName(header)
        const size = readTarSize(header)
        const typeflag = String.fromCharCode(header[156] ?? 0)
        const isFile = typeflag === '0' || typeflag === '\0' || typeflag === ''
        const padded = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK

        if (isFile && (name === entryName || name === `./${entryName}`)) {
          if (size > MAX_ENTRY_BYTES) {
            fail(new Error(`条目 ${entryName} 过大（${size} 字节）`))
            return
          }
          if (size === 0) {
            finish(Buffer.alloc(0))
            return
          }
          collecting = { size, left: size, chunks: [] }
          continue
        }

        skipping += padded
      }
    }

    gunzip.on('data', (chunk) => {
      if (settled) return
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      try {
        drain()
      } catch (error) {
        fail(error)
      }
    })
    gunzip.on('error', (error) => fail(new Error(`解压失败：${error.message}`)))
    gunzip.on('end', () => finish(undefined))
    source.on('error', (error) => fail(new Error(`读取失败：${error.message}`)))
    source.pipe(gunzip)
  })
}

/**
 * 校验一个 tarball。
 *
 * @param {string} file 本地 tarball 路径
 * @param {{ integrity?: string, shasum?: string, name?: string, version?: string }} [expectation]
 * @returns {Promise<{ ok: boolean, checks: Array<{label: string, ok: boolean, detail: string|null}>,
 *   manifest: object|undefined, message: string }>}
 */
export async function verifyTarball(file, expectation = {}) {
  const checks = []
  const add = (label, ok, detail) => {
    checks.push({ label, ok, detail: detail ?? null })
    return ok
  }

  let integritySeen = false
  const integrity = parseIntegrity(expectation.integrity)
  if (integrity !== undefined) {
    integritySeen = true
    let actual
    try {
      actual = await hashFile(file, integrity.algorithm, 'base64')
    } catch (error) {
      add(`包完整性（${integrity.algorithm}）`, false, `计算失败：${error.message}`)
      actual = undefined
    }
    if (actual !== undefined) {
      add(
        `包完整性（${integrity.algorithm}）`,
        actual === integrity.digest,
        actual === integrity.digest ? null : `期望 ${integrity.digest}，实际 ${actual}`,
      )
    }
  }

  let shasumSeen = false
  if (typeof expectation.shasum === 'string' && expectation.shasum.trim() !== '') {
    shasumSeen = true
    let actual
    try {
      actual = await hashFile(file, 'sha1', 'hex')
    } catch (error) {
      add('校验和（sha1）', false, `计算失败：${error.message}`)
      actual = undefined
    }
    if (actual !== undefined) {
      const want = expectation.shasum.trim().toLowerCase()
      add('校验和（sha1）', actual === want, actual === want ? null : `期望 ${want}，实际 ${actual}`)
    }
  }

  if (!integritySeen && !shasumSeen) {
    // 没有可对照的凭据 —— 与其"假装通过"，不如明确拒绝。
    add('可校验性', false, 'registry 未提供 integrity / shasum，无法确认包未被篡改')
  }

  let manifest
  try {
    const raw = await readTarEntry(file, 'package/package.json')
    if (raw === undefined) {
      add('包身份', false, 'tarball 内没有 package/package.json')
    } else {
      manifest = JSON.parse(raw.toString('utf8'))
      const problems = []
      if (typeof expectation.name === 'string' && expectation.name !== '' && manifest.name !== expectation.name) {
        problems.push(`name 期望 ${expectation.name}，实际 ${manifest.name}`)
      }
      if (typeof expectation.version === 'string' && expectation.version !== '' && manifest.version !== expectation.version) {
        problems.push(`version 期望 ${expectation.version}，实际 ${manifest.version}`)
      }
      add(
        '包身份',
        problems.length === 0,
        problems.length === 0 ? `${manifest.name}@${manifest.version}` : problems.join('；'),
      )
    }
  } catch (error) {
    add('包身份', false, `读取包内清单失败：${error.message}`)
  }

  const failed = checks.filter((item) => !item.ok)
  const ok = failed.length === 0
  const passed = checks.filter((item) => item.ok).map((item) => item.label)
  return {
    ok,
    checks,
    manifest,
    message: ok
      ? `校验通过（${passed.join('、')}）`
      : `校验失败：${failed.map((item) => `${item.label}${item.detail === null ? '' : `（${item.detail}）`}`).join('；')}`,
  }
}
