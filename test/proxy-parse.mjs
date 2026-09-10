/**
 * 代理取值归一化单测。
 *
 * Windows 系统代理可能是 `127.0.0.1:7890`，也可能按协议分列成
 * `http=a:1;https=b:2`；本插件只访问 https 的 GitHub，所以要挑对那个。
 *
 * 用法：node test/proxy-parse.mjs
 */

import { normalizeProxy } from '../lib/index.js'

let failed = 0

function check(input, expected, note) {
  const actual = normalizeProxy(input)
  const label = input === undefined ? 'undefined' : JSON.stringify(input)
  if (actual === expected) {
    console.log(`  ✓ ${label.padEnd(44)} -> ${String(actual)}   ${note ?? ''}`)
    return
  }
  failed += 1
  console.error(`  ✗ ${label.padEnd(44)} -> ${String(actual)}（期望 ${String(expected)}）`)
}

console.log('=== normalizeProxy ===')
check('127.0.0.1:7890', 'http://127.0.0.1:7890', '裸 host:port 补 http')
check('localhost:7890', 'http://localhost:7890')
check('http://127.0.0.1:7890', 'http://127.0.0.1:7890', '已带 scheme 原样保留')
check('https://127.0.0.1:7890', 'https://127.0.0.1:7890')
check('socks5h://127.0.0.1:1080', 'socks5h://127.0.0.1:1080')
check('http=127.0.0.1:7890;https=127.0.0.1:7891', 'http://127.0.0.1:7891', '优先挑 https 那一项')
check('http=127.0.0.1:7890', 'http://127.0.0.1:7890', '只有 http 时用它')
check('socks=127.0.0.1:1080', 'socks5h://127.0.0.1:1080', 'socks 用 socks5h（DNS 也走代理）')
check('  127.0.0.1:7890  ', 'http://127.0.0.1:7890', '去空白')
check('', undefined, '空串视为无代理')
check('   ', undefined)
check(undefined, undefined, '未设置视为无代理')
check('=;=', undefined, '没有可用项')

if (failed > 0) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过。')
