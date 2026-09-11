/**
 * 查询 npm registry，用于非源码形态（npx / npm 安装）的更新检测。
 *
 * 只取 dist-tags —— 那是最小的一份 JSON（形如
 * `{"latest":"0.1.5-rc.1","next":"0.1.5-rc.2","alpha":"0.1.5-alpha.2"}`），
 * 不必拉完整的 packument。
 *
 * 网络策略：registry.npmjs.org 在多数网络下可直连，所以**先直连、失败再走代理**
 * （与 git 侧"先代理"相反，因为 git 那边代理才是主要通路）。代理只支持 HTTP
 * CONNECT 隧道，SOCKS 会明确报错而不是静默失败。
 */

import http from 'node:http'
import https from 'node:https'

/** dist-tags 只有几百字节；给足余量同时防止异常响应撑爆内存。 */
const MAX_BODY_BYTES = 256 * 1024

const REQUEST_TIMEOUT_MS = 20_000

const USER_AGENT = 'dsh-git-update-notifier'

function readBody(res, done, maxBytes = MAX_BODY_BYTES) {
  let body = ''
  let size = 0
  res.setEncoding('utf8')
  res.on('data', (chunk) => {
    size += chunk.length
    if (size > maxBytes) {
      res.destroy()
      done({ ok: false, error: '响应体过大' })
      return
    }
    body += chunk
  })
  res.on('end', () => {
    if (res.statusCode !== 200) {
      done({ ok: false, error: `HTTP ${res.statusCode}` })
      return
    }
    try {
      done({ ok: true, value: JSON.parse(body) })
    } catch (error) {
      done({ ok: false, error: `JSON 解析失败：${error.message}` })
    }
  })
  res.on('error', (error) => done({ ok: false, error: error.message }))
}

function defaultPort(target) {
  if (target.port !== '') return target.port
  return target.protocol === 'http:' ? 80 : 443
}

/** 直连请求；http / https 由 URL 协议决定。 */
function requestDirect(target, done, maxBytes) {
  const transport = target.protocol === 'http:' ? http : https
  const req = transport.request({
    hostname: target.hostname,
    port: defaultPort(target),
    path: target.pathname + target.search,
    method: 'GET',
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    timeout: REQUEST_TIMEOUT_MS,
  }, (res) => readBody(res, done, maxBytes))
  req.on('error', (error) => done({ ok: false, error: error.message }))
  req.on('timeout', () => {
    req.destroy()
    done({ ok: false, error: `请求超时（${REQUEST_TIMEOUT_MS}ms）` })
  })
  req.end()
}

/** 经 HTTP 代理：先 CONNECT 建隧道，再在隧道 socket 上发起请求。 */
function requestViaProxy(target, proxy, done, maxBytes) {
  const proxyUrl = new URL(proxy)
  if (proxyUrl.protocol !== 'http:') {
    done({ ok: false, error: `暂不支持用 ${proxyUrl.protocol} 代理做 HTTP 查询` })
    return
  }

  const port = defaultPort(target)
  const authority = `${target.hostname}:${port}`
  const connectReq = http.request({
    hostname: proxyUrl.hostname,
    port: proxyUrl.port === '' ? 80 : proxyUrl.port,
    method: 'CONNECT',
    path: authority,
    headers: { host: authority },
    timeout: REQUEST_TIMEOUT_MS,
  })

  connectReq.on('connect', (res, socket) => {
    if (res.statusCode !== 200) {
      socket.destroy()
      done({ ok: false, error: `代理 CONNECT 返回 ${res.statusCode}` })
      return
    }
    const transport = target.protocol === 'http:' ? http : https
    const req = transport.request({
      hostname: target.hostname,
      port,
      path: target.pathname + target.search,
      method: 'GET',
      socket,
      agent: false,
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    }, (resp) => readBody(resp, done, maxBytes))
    req.on('error', (error) => done({ ok: false, error: error.message }))
    req.end()
  })
  connectReq.on('error', (error) => done({ ok: false, error: error.message }))
  connectReq.on('timeout', () => {
    connectReq.destroy()
    done({ ok: false, error: `代理连接超时（${REQUEST_TIMEOUT_MS}ms）` })
  })
  connectReq.end()
}

/** 请求一个 JSON 接口。返回 `{ ok: true, value }` 或 `{ ok: false, error }`。 */
export function getJson(url, proxy, maxBytes) {
  return new Promise((resolve) => {
    let target
    try {
      target = new URL(url)
    } catch (error) {
      resolve({ ok: false, error: `非法 URL：${error.message}` })
      return
    }
    if (proxy === undefined) requestDirect(target, resolve, maxBytes)
    else requestViaProxy(target, proxy, resolve, maxBytes)
  })
}

/**
 * registry 基址。可用 `DSH_GIT_UPDATE_NOTIFIER_REGISTRY` 指向镜像
 * （国内镜像更快），测试也用它注入本地 mock。
 */
export function registryBase() {
  const fromEnv = process.env.DSH_GIT_UPDATE_NOTIFIER_REGISTRY
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return fromEnv.trim().replace(/\/+$/, '')
  }
  return 'https://registry.npmjs.org'
}

/** 取某个包的 dist-tags。返回 `{ ok, tags|error, viaProxy }`。 */
export async function fetchDistTags(packageName, proxy) {
  const encoded = packageName.replace('/', '%2f')
  const url = `${registryBase()}/-/package/${encoded}/dist-tags`

  const direct = await getJson(url, undefined)
  if (direct.ok) return { ok: true, tags: direct.value, viaProxy: false }

  if (proxy === undefined) return { ok: false, error: direct.error, viaProxy: false }

  const proxied = await getJson(url, proxy)
  if (proxied.ok) return { ok: true, tags: proxied.value, viaProxy: true }
  return {
    ok: false,
    error: `直连失败（${direct.error}）；经代理 ${proxy} 也失败（${proxied.error}）`,
    viaProxy: true,
  }
}

/** 单版本 manifest 比 dist-tags 大得多（含 dist、依赖等），给足余量。 */
const MAX_MANIFEST_BYTES = 1024 * 1024

/**
 * 取某个版本的完整 manifest。
 *
 * 更新流程需要这里的 `dist`：`tarball`（下载地址）与 `integrity` / `shasum`（校验凭据）。
 */
export async function fetchVersionManifest(packageName, version, proxy) {
  const encoded = packageName.replace('/', '%2f')
  const url = `${registryBase()}/${encoded}/${encodeURIComponent(version)}`

  const direct = await getJson(url, undefined, MAX_MANIFEST_BYTES)
  if (direct.ok) return { ok: true, manifest: direct.value, viaProxy: false }

  if (proxy === undefined) return { ok: false, error: direct.error, viaProxy: false }

  const proxied = await getJson(url, proxy, MAX_MANIFEST_BYTES)
  if (proxied.ok) return { ok: true, manifest: proxied.value, viaProxy: true }
  return {
    ok: false,
    error: `直连失败（${direct.error}）；经代理 ${proxy} 也失败（${proxied.error}）`,
    viaProxy: true,
  }
}

/** 从 manifest 里抽出下载与校验真正需要的字段。 */
export function distOf(manifest) {
  const dist = manifest !== null && typeof manifest === 'object' ? manifest.dist : undefined
  if (dist === null || typeof dist !== 'object') return undefined
  return {
    tarball: typeof dist.tarball === 'string' ? dist.tarball : undefined,
    integrity: typeof dist.integrity === 'string' ? dist.integrity : undefined,
    shasum: typeof dist.shasum === 'string' ? dist.shasum : undefined,
    unpackedSize: typeof dist.unpackedSize === 'number' ? dist.unpackedSize : undefined,
    fileCount: typeof dist.fileCount === 'number' ? dist.fileCount : undefined,
  }
}
