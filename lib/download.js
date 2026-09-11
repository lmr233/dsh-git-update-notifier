/**
 * 带断点续传的下载器。
 *
 * npx / npm 形态更新时，需要先把目标版本的 tarball 拿到本地（之后校验、再安装）。
 * 这一步最容易在弱网里中断，所以：
 *
 * - 数据写进 `<file>.part`，进度记在 `<file>.part.json`；
 * - 下次从断点发 `Range: bytes=<已下载>-` 续传；服务端不支持（回 200）就从零重来；
 * - 进度按块落盘，因此**跨进程**也能续 —— dsh 重启后仍从断点继续，而不是重下；
 * - 出错或主动取消都只保留 `.part`，交给下一次续传。
 *
 * 网络策略与 registry 查询一致：先直连、失败再走 HTTP CONNECT 代理。
 */

import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { dirname } from 'node:path'

/** 建连与首字节的等待上限。真正的传输靠 idle 超时判定卡死。 */
const CONNECT_TIMEOUT_MS = 30_000

/** 连续这么久没有新数据就认为连接已死，保留断点结束本次下载。 */
const IDLE_TIMEOUT_MS = 60_000

/** 每累计这么多字节落一次盘。太小会频繁写，太大则中断后重下的部分变多。 */
const META_FLUSH_BYTES = 512 * 1024

const USER_AGENT = 'dsh-git-update-notifier'

/** 中间文件路径：`.part` 存数据，`.part.json` 存进度。 */
export function downloadPaths(file) {
  return { part: `${file}.part`, meta: `${file}.part.json` }
}

function readMeta(metaPath) {
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    // 首次下载或元数据损坏：按"从头开始"处理。
  }
  return undefined
}

function writeMeta(metaPath, meta) {
  try {
    writeFileSync(metaPath, `${JSON.stringify(meta)}\n`, 'utf8')
  } catch {
    // 进度写不进去只会让下次续传的起点变早，不影响本次下载。
  }
}

function sizeOf(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

function portOf(target) {
  if (target.port !== '') return target.port
  return target.protocol === 'http:' ? 80 : 443
}

/**
 * 发起一个 GET 并拿到可读流。
 *
 * 直连与代理两条路都返回 `{ req, res }`，好让调用方能在流中途 `destroy()` 掉。
 */
function openStream(target, proxy, headers) {
  return new Promise((resolve, reject) => {
    const port = portOf(target)
    const path = target.pathname + target.search

    if (proxy === undefined) {
      const transport = target.protocol === 'http:' ? http : https
      const req = transport.request({
        hostname: target.hostname,
        port,
        path,
        method: 'GET',
        headers,
        timeout: CONNECT_TIMEOUT_MS,
      }, (res) => resolve({ req, res }))
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error(`请求超时（${CONNECT_TIMEOUT_MS}ms）`))
      })
      req.end()
      return
    }

    let proxyUrl
    try {
      proxyUrl = new URL(proxy)
    } catch {
      reject(new Error(`代理地址无法解析：${proxy}`))
      return
    }
    if (proxyUrl.protocol !== 'http:') {
      reject(new Error(`暂不支持用 ${proxyUrl.protocol} 代理下载`))
      return
    }

    const authority = `${target.hostname}:${port}`
    const connectReq = http.request({
      hostname: proxyUrl.hostname,
      port: proxyUrl.port === '' ? 80 : proxyUrl.port,
      method: 'CONNECT',
      path: authority,
      headers: { host: authority },
      timeout: CONNECT_TIMEOUT_MS,
    })
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`代理 CONNECT 返回 ${res.statusCode}`))
        return
      }
      const transport = target.protocol === 'http:' ? http : https
      const req = transport.request({
        hostname: target.hostname,
        port,
        path,
        method: 'GET',
        socket,
        agent: false,
        headers,
      }, (resp) => resolve({ req, res: resp, socket }))
      req.on('error', reject)
      req.end()
    })
    connectReq.on('error', reject)
    connectReq.on('timeout', () => {
      connectReq.destroy()
      reject(new Error(`代理连接超时（${CONNECT_TIMEOUT_MS}ms）`))
    })
    connectReq.end()
  })
}

/** 解析 `bytes <start>-<end>/<total>`；total 可能是 `*`。 */
function parseContentRange(value) {
  const matched = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/.exec(String(value ?? '').trim())
  if (matched === null) return undefined
  return {
    start: Number(matched[1]),
    end: Number(matched[2]),
    total: matched[3] === '*' ? undefined : Number(matched[3]),
  }
}

/**
 * 下载 `url` 到 `file`，能续就续。
 *
 * 返回 `{ ok, file, bytes, total, resumedFrom }`，失败时额外带 `resumable` / `aborted`。
 * 失败**不抛异常** —— 更新流程要把"下载中断"当成一种可呈现、可继续的正常结果。
 *
 * @param {string} url
 * @param {string} file 最终文件路径（中间文件是它的 `.part`）
 * @param {{ proxy?: string, signal?: AbortSignal, onProgress?: (bytes: number, total?: number) => void }} [options]
 */
export async function downloadFile(url, file, options = {}) {
  const { proxy, signal, onProgress } = options
  const report = typeof onProgress === 'function' ? onProgress : () => {}

  let target
  try {
    target = new URL(url)
  } catch (error) {
    return { ok: false, error: `非法 URL：${error.message}` }
  }

  const { part, meta } = downloadPaths(file)
  try {
    mkdirSync(dirname(file), { recursive: true })
  } catch (error) {
    return { ok: false, error: `无法创建下载目录：${error.message}` }
  }

  // 断点只在"同一个 URL 且已下载字节数与 .part 对得上"时才认。
  const previous = readMeta(meta)
  let offset = sizeOf(part)
  if (previous === undefined || previous.url !== url || previous.downloaded !== offset) offset = 0
  // 注意：`offset > 0` 只说明"磁盘上有断点"，是否真的从断点续上要看服务端是否回 206。
  let resumedFrom = offset

  const headers = { 'user-agent': USER_AGENT, accept: '*/*' }
  if (offset > 0) {
    headers.range = `bytes=${offset}-`
    if (typeof previous.etag === 'string' && previous.etag !== '') headers['if-range'] = previous.etag
  }

  let opened
  try {
    opened = await openStream(target, proxy, headers)
  } catch (error) {
    return { ok: false, error: error.message, resumable: offset > 0, bytes: offset, total: previous?.total }
  }

  const { req, res } = opened
  const status = res.statusCode ?? 0
  const etag = typeof res.headers.etag === 'string' ? res.headers.etag : undefined
  let start = 0
  let total

  if (status === 206) {
    const range = parseContentRange(res.headers['content-range'])
    if (range === undefined || range.start !== offset) {
      // 服务端给的区间和我们请求的对不上：已下载的部分不可信，清掉重来。
      res.destroy()
      req.destroy()
      rmSync(part, { force: true })
      rmSync(meta, { force: true })
      return { ok: false, error: '服务端返回的 Range 与请求不一致', resumable: false, retryFromScratch: true }
    }
    start = range.start
    total = range.total
  } else if (status === 200) {
    // 服务端不支持续传（或我们本来就从零请求）：截断重写。
    start = 0
    // 从零重下，对外就不能声称"续传了多少"。
    resumedFrom = 0
    total = res.headers['content-length'] === undefined ? undefined : Number(res.headers['content-length'])
  } else if (status === 416) {
    // 已下载的长度正好等于资源长度：上次其实已经下完了，直接落定。
    res.destroy()
    req.destroy()
    const declared = /^bytes \*\/(\d+)$/.exec(String(res.headers['content-range'] ?? ''))
    if (declared !== null && Number(declared[1]) === offset) {
      renameSync(part, file)
      rmSync(meta, { force: true })
      report(offset, offset)
      return { ok: true, file, bytes: offset, total: offset, resumedFrom }
    }
    rmSync(part, { force: true })
    rmSync(meta, { force: true })
    return { ok: false, error: 'HTTP 416（已下载长度与资源长度不符）', resumable: false, retryFromScratch: true }
  } else {
    res.destroy()
    req.destroy()
    return {
      ok: false,
      error: `HTTP ${status}`,
      resumable: offset > 0,
      bytes: offset,
      total: previous?.total,
    }
  }

  const stream = createWriteStream(part, { flags: start > 0 ? 'a' : 'w' })
  let written = start
  let flushed = written
  let aborted = false
  let lastDataAt = Date.now()

  const onAbort = () => {
    aborted = true
    res.destroy()
    req.destroy()
  }
  if (signal !== undefined) {
    if (signal.aborted) {
      res.destroy()
      req.destroy()
      stream.destroy()
      return { ok: false, error: '已取消', aborted: true, resumable: written > 0, bytes: written, total }
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }

  report(written, total)

  const outcome = await new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearInterval(watchdog)
      resolve(value)
    }
    // 卡死的连接不会触发 'error'，只能靠 idle 判定。
    const watchdog = setInterval(() => {
      if (Date.now() - lastDataAt > IDLE_TIMEOUT_MS) {
        res.destroy()
        req.destroy()
        done({ ok: false, error: `下载停滞超过 ${Math.round(IDLE_TIMEOUT_MS / 1000)}s` })
      }
    }, 5_000)
    if (typeof watchdog.unref === 'function') watchdog.unref()

    res.on('data', (chunk) => {
      written += chunk.length
      lastDataAt = Date.now()
      if (written - flushed >= META_FLUSH_BYTES) {
        flushed = written
        writeMeta(meta, { url, etag, total, downloaded: written })
        report(written, total)
      }
    })
    res.pipe(stream)
    stream.on('finish', () => done({ ok: true }))
    stream.on('error', (error) => done({ ok: false, error: `写入失败：${error.message}` }))
    res.on('error', (error) => done({ ok: false, error: error.message }))
    // 对端直接掐断连接时不一定报 error，但 complete 会是 false —— 这也是一次"可续"的中断。
    res.on('close', () => {
      if (res.complete !== true) done({ ok: false, error: '连接提前关闭' })
    })
    req.on('error', (error) => done({ ok: false, error: error.message }))
  })

  if (signal !== undefined) signal.removeEventListener('abort', onAbort)
  stream.destroy()

  if (aborted) {
    writeMeta(meta, { url, etag, total, downloaded: written })
    return { ok: false, error: '已取消', aborted: true, resumable: written > 0, bytes: written, total, resumedFrom }
  }

  if (!outcome.ok) {
    // 关键：失败也把进度落盘，这就是"下次能续"的依据。
    writeMeta(meta, { url, etag, total, downloaded: written })
    return { ok: false, error: outcome.error, resumable: written > 0, bytes: written, total, resumedFrom }
  }

  if (total !== undefined && written !== total) {
    writeMeta(meta, { url, etag, total, downloaded: written })
    return {
      ok: false,
      error: `下载不完整（${written}/${total} 字节）`,
      resumable: true,
      bytes: written,
      total,
      resumedFrom,
    }
  }

  renameSync(part, file)
  rmSync(meta, { force: true })
  report(written, total)
  return { ok: true, file, bytes: written, total, resumedFrom }
}

/**
 * 查询一个 URL 的远端大小与是否支持续传（发一个 `bytes=0-0` 探测请求）。
 *
 * 用于在 UI 上给出"还差多少"的预估；失败不影响主流程。
 */
export async function probeRemoteSize(url, options = {}) {
  let target
  try {
    target = new URL(url)
  } catch (error) {
    return { ok: false, error: `非法 URL：${error.message}` }
  }
  let opened
  try {
    opened = await openStream(target, options.proxy, {
      'user-agent': USER_AGENT,
      accept: '*/*',
      range: 'bytes=0-0',
    })
  } catch (error) {
    return { ok: false, error: error.message }
  }
  const { req, res } = opened
  const range = parseContentRange(res.headers['content-range'])
  const length = res.headers['content-length']
  req.destroy()
  res.destroy()
  if (range !== undefined) return { ok: true, total: range.total, resumable: true }
  if (length !== undefined) return { ok: true, total: Number(length), resumable: false }
  return { ok: true, resumable: false }
}

/** 清掉某个文件的断点残留（`cancel` 之后需要"从零开始"时用）。 */
export function clearPartial(file) {
  const { part, meta } = downloadPaths(file)
  rmSync(part, { force: true })
  rmSync(meta, { force: true })
}
