/**
 * 下载器测试：断点续传的几条现实路径。
 *
 * 全程离线 —— 起一个本地 http server 扮演 registry 的 tarball 端点，可以按指令
 * "发一半就掐断"、"忽略 Range"、"谎报区间"、"慢慢发以便中途取消"。
 */

import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clearPartial, downloadFile, downloadPaths, probeRemoteSize } from '../lib/download.js'

let failures = 0
function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`)
    return
  }
  console.error(`  ✗ ${message}`)
  failures += 1
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-download-test-'))
const DATA = Buffer.alloc(300 * 1024)
for (let index = 0; index < DATA.length; index += 1) DATA[index] = (index * 31 + 7) % 251

/** full | ignore-range | bad-range | slow | cut:<字节数> */
let mode = 'full'
const requests = []

const server = createServer((req, res) => {
  const current = mode
  const header = req.headers.range
  const matched = typeof header === 'string' ? /^bytes=(\d+)-(\d*)$/.exec(header) : null
  let start = matched === null ? 0 : Number(matched[1])
  const probeEnd = matched !== null && matched[2] !== '' ? Number(matched[2]) : undefined
  requests.push({ range: header ?? null, start })

  if (current === 'bad-range') {
    // 谎报一个起点对不上的区间：客户端必须拒绝这份数据，而不是把它拼进断点。
    res.writeHead(206, {
      'content-length': 100,
      'content-range': `bytes ${start + 5}-${start + 104}/${DATA.length}`,
      etag: '"v1"',
    })
    res.end(DATA.subarray(0, 100))
    return
  }

  if (probeEnd !== undefined) {
    // 探测请求（`bytes=0-0`）：只回一个字节，同时把完整长度报出来 —— 真实 CDN 就是这个行为。
    res.writeHead(206, {
      'content-length': probeEnd - start + 1,
      'content-range': `bytes ${start}-${probeEnd}/${DATA.length}`,
      etag: '"v1"',
    })
    res.end(DATA.subarray(start, probeEnd + 1))
    return
  }

  if (start > 0 && current !== 'ignore-range') {
    res.writeHead(206, {
      'content-length': DATA.length - start,
      'content-range': `bytes ${start}-${DATA.length - 1}/${DATA.length}`,
      etag: '"v1"',
    })
  } else {
    start = 0
    res.writeHead(200, { 'content-length': DATA.length, etag: '"v1"' })
  }

  const cut = current.startsWith('cut:') ? Number(current.slice(4)) : -1
  const pace = current === 'slow' ? 25 : 0
  const CHUNK = 16 * 1024
  let sent = 0

  const pump = () => {
    const remaining = DATA.length - start - sent
    if (remaining <= 0) {
      res.end()
      return
    }
    const piece = DATA.subarray(start + sent, start + sent + Math.min(CHUNK, remaining))
    sent += piece.length
    res.write(piece)
    if (cut >= 0 && sent >= cut) {
      // 模拟网络断掉：不 end，直接销毁连接。
      setTimeout(() => res.destroy(), 5)
      return
    }
    setTimeout(pump, pace)
  }
  pump()
})

await new Promise((done) => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${server.address().port}`
const url = `${base}/dsh-0.1.5-rc.2.tgz`

console.log('=== 1. 完整下载 ===')
{
  const file = join(ROOT, 'full.tgz')
  const result = await downloadFile(url, file)
  assert(result.ok === true, '下载成功')
  assert(result.resumedFrom === 0, '首次下载没有续传起点')
  assert(readFileSync(file).equals(DATA), '落盘内容与源逐字节一致')
  assert(existsSync(downloadPaths(file).part) === false, '完成后清理了 .part')
}

console.log('\n=== 2. 中断后从断点续传 ===')
{
  const file = join(ROOT, 'resume.tgz')
  const { part } = downloadPaths(file)

  requests.length = 0
  mode = 'cut:65536'
  const interrupted = await downloadFile(url, file)
  assert(interrupted.ok === false, '连接被掐断时不算成功')
  assert(interrupted.resumable === true, '被判定为"可续传"')
  assert(interrupted.bytes > 0 && interrupted.bytes < DATA.length, `保留了部分数据（${interrupted.bytes} 字节）`)
  assert(existsSync(part), '.part 留在磁盘上 —— 这就是跨进程的断点')

  mode = 'full'
  const resumed = await downloadFile(url, file)
  assert(resumed.ok === true, '续传后完成')
  assert(resumed.resumedFrom === interrupted.bytes, `续传起点等于中断时的字节数（${resumed.resumedFrom}）`)
  assert(requests.some((item) => item.start === interrupted.bytes), '第二次请求带着正确的 Range 起点')
  assert(readFileSync(file).equals(DATA), '续出来的文件与源逐字节一致')
  assert(existsSync(part) === false, '完成后清理了 .part 与元数据')
}

console.log('\n=== 3. 服务端不支持 Range 时从零重下 ===')
{
  const file = join(ROOT, 'ignore-range.tgz')
  mode = 'cut:32768'
  const interrupted = await downloadFile(url, file)
  assert(interrupted.ok === false && interrupted.resumable === true, '先制造一个断点')

  mode = 'ignore-range'
  const restarted = await downloadFile(url, file)
  assert(restarted.ok === true, '服务端回 200 全量时仍能完成')
  assert(restarted.resumedFrom === 0, '这种情况不能声称"续传了多少"')
  assert(readFileSync(file).equals(DATA), '重下后的文件与源一致')
}

console.log('\n=== 4. 服务端返回的区间对不上 ===')
{
  const file = join(ROOT, 'bad-range.tgz')
  mode = 'cut:32768'
  await downloadFile(url, file)
  mode = 'bad-range'
  const mismatched = await downloadFile(url, file)
  assert(mismatched.ok === false, '拒绝接受对不上的区间')
  assert(mismatched.retryFromScratch === true, '明确要求从零重来')
  assert(existsSync(downloadPaths(file).part) === false, '同时清掉了不可信的断点')
}

console.log('\n=== 5. 主动取消 ===')
{
  const file = join(ROOT, 'cancel.tgz')
  const { part } = downloadPaths(file)
  mode = 'slow'
  const controller = new AbortController()
  const running = downloadFile(url, file, { signal: controller.signal })
  setTimeout(() => controller.abort(), 120)
  const cancelled = await running
  assert(cancelled.ok === false && cancelled.aborted === true, '取消被识别为 aborted（而不是网络错误）')
  assert(existsSync(part), '取消后默认保留断点')
  assert((cancelled.bytes ?? 0) > 0, `取消时记录了已下载字节数（${cancelled.bytes}）`)

  clearPartial(file)
  assert(existsSync(part) === false, 'clearPartial 可以丢弃断点')
}

console.log('\n=== 6. 进度回调 ===')
{
  const file = join(ROOT, 'progress.tgz')
  const seen = []
  mode = 'full'
  const tracked = await downloadFile(url, file, {
    onProgress: (bytes, total) => seen.push({ bytes, total }),
  })
  assert(tracked.ok === true, '带进度回调的下载成功')
  assert(seen.length >= 2, `进度被多次回调（${seen.length} 次）`)
  assert(seen[seen.length - 1].bytes === DATA.length, '最后一次进度等于总长度')
  assert(seen.every((item) => item.total === undefined || item.total === DATA.length), '进度里的 total 是资源总长度')
}

console.log('\n=== 7. 探测远端大小与是否支持续传 ===')
{
  mode = 'full'
  const probed = await probeRemoteSize(url)
  assert(probed.ok === true && probed.total === DATA.length, `探测到大小 ${probed.total}`)
  assert(probed.resumable === true, '探测结果表明支持续传')
}

console.log('\n=== 8. 进度落盘的粒度（元数据里记着断点） ===')
{
  const file = join(ROOT, 'meta.tgz')
  const { meta } = downloadPaths(file)
  mode = 'cut:131072'
  const interrupted = await downloadFile(url, file)
  assert(interrupted.ok === false, '制造一次较大的中断')
  const parsed = JSON.parse(readFileSync(meta, 'utf8'))
  assert(parsed.url === url, '元数据记下了 URL（换了地址就不认这个断点）')
  assert(parsed.downloaded === interrupted.bytes, `元数据里的进度与返回一致（${parsed.downloaded}）`)
  assert(parsed.total === DATA.length, '元数据记下了总长度')
}

server.close()
rmSync(ROOT, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过。')
