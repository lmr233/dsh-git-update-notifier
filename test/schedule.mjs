/**
 * 检查时间点的单测：确认"本地 24 时"的计算与边界。
 *
 * 这一层决定"什么时候查"，错了的表现是静默漏检或频繁打扰，所以边界要钉住。
 *
 * 用法：node test/schedule.mjs
 */

import { msUntilNextMidnight } from '../lib/index.js'

let failed = 0
function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`)
    return
  }
  failed += 1
  console.error(`  ✗ ${message}`)
}

const HOUR = 3_600_000

/** 用**本地时间**构造时刻（月份 0-based，8 表示九月）。 */
function at(hour, minute, second = 0, ms = 0) {
  return new Date(2026, 8, 11, hour, minute, second, ms)
}

console.log('=== 距离本地 24 时的等待时长 ===')
const cases = [
  { now: at(0, 0, 0, 0), expect: 24 * HOUR, note: '刚过零点 → 整整一天' },
  { now: at(1, 30, 0, 0), expect: 22.5 * HOUR, note: '凌晨 01:30' },
  { now: at(12, 0, 0, 0), expect: 12 * HOUR, note: '正午 12:00' },
  { now: at(23, 0, 0, 0), expect: 1 * HOUR, note: '23:00' },
  { now: at(23, 59, 0, 0), expect: 60_000, note: '23:59' },
  { now: at(23, 59, 59, 0), expect: 1_000, note: '23:59:59' },
  { now: at(23, 59, 59, 999), expect: 1, note: '23:59:59.999' },
]
for (const item of cases) {
  const actual = msUntilNextMidnight(item.now)
  assert(actual === item.expect, `${item.note} → ${actual}ms（期望 ${item.expect}）`)
}

console.log('\n=== 不变式：任意时刻的等待都落在 (0, 24h] ===')
const dayStart = new Date(2026, 8, 11, 0, 0, 0, 0).getTime()
let outOfRange = 0
for (let index = 0; index < 500; index += 1) {
  const now = new Date(dayStart + Math.floor(Math.random() * 86_400_000))
  const wait = msUntilNextMidnight(now)
  if (!(wait > 0 && wait <= 24 * HOUR)) {
    outOfRange += 1
    console.error(`      越界：${now.toISOString()} → ${wait}ms`)
  }
}
assert(outOfRange === 0, '500 个随机时刻全部落在 (0, 24h] 内')

console.log('\n=== 跨月 / 跨年边界 ===')
assert(msUntilNextMidnight(new Date(2026, 8, 30, 22, 0, 0)) === 2 * HOUR,
  '9/30 22:00 → 2 小时（滚到 10/1）')
assert(msUntilNextMidnight(new Date(2026, 11, 31, 23, 0, 0)) === 1 * HOUR,
  '12/31 23:00 → 1 小时（滚到次年）')

console.log('')
if (failed > 0) {
  console.error(`${failed} 项失败`)
  process.exit(1)
}
console.log('全部通过。')
