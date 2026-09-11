/**
 * semver 比较单测。
 *
 * 这一层的正确性直接决定"有没有新版本"的判断，而 dsh 处于 developer preview，
 * 版本序列里全是预发布段（0.1.5-alpha.2 / 0.1.5-rc.1 / 0.1.5-rc.2），
 * 所以边界必须逐个钉住。
 *
 * 用法：node test/semver.mjs
 */

import { compareSemver, isNewer, parseSemver } from '../lib/semver.js'

let failed = 0

function ok(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`)
    return
  }
  failed += 1
  console.error(`  ✗ ${message}`)
}

function cmp(a, b, expected) {
  const actual = compareSemver(a, b)
  ok(actual === expected, `compare(${a}, ${b}) = ${actual}（期望 ${expected}）`)
}

console.log('=== 1. 解析 ===')
ok(parseSemver('1.2.3')?.patch === 3, '基本三段解析')
ok(parseSemver('v1.2.3')?.major === 1, '允许 v 前缀')
ok(parseSemver('1.2.3-rc.1')?.pre.join(',') === 'rc,1', '预发布分段')
ok(parseSemver('1.2.3+build.5') !== undefined, '忽略 build metadata')
ok(parseSemver('not-a-version') === undefined, '非法输入返回 undefined')
ok(parseSemver('') === undefined, '空串返回 undefined')

console.log('\n=== 2. 常规比较 ===')
cmp('1.0.0', '1.0.0', 0)
cmp('1.0.1', '1.0.0', 1)
cmp('1.1.0', '1.0.9', 1)
cmp('2.0.0', '1.99.99', 1)
cmp('1.0.0', '1.0.1', -1)

console.log('\n=== 3. 预发布 < 正式版 ===')
cmp('1.0.0-rc.1', '1.0.0', -1)
cmp('1.0.0', '1.0.0-rc.1', 1)
cmp('0.1.5-rc.2', '0.1.5', -1)

console.log('\n=== 4. 预发布之间（数字按数值、字母按字典序）===')
cmp('1.0.0-rc.2', '1.0.0-rc.1', 1)
cmp('1.0.0-rc.10', '1.0.0-rc.9', 1)   // 字符串比较会在这里出错
cmp('1.0.0-alpha', '1.0.0-beta', -1)
cmp('1.0.0-alpha.1', '1.0.0-alpha', 1) // 段数多的一方更大
cmp('1.0.0-alpha.1', '1.0.0-alpha.beta', -1) // 数字标识符 < 字母标识符

console.log('\n=== 5. dsh 的真实版本序列 ===')
cmp('0.1.5-alpha.2', '0.1.5-rc.1', -1)
cmp('0.1.5-rc.1', '0.1.5-alpha.2', 1)
cmp('0.1.5-rc.2', '0.1.5-rc.1', 1)
cmp('0.1.5', '0.1.5-rc.2', 1)
cmp('0.1.3-alpha.2', '0.1.5-alpha.1', -1)
cmp('0.1.2-rc.1', '0.1.3-alpha.2', -1)

console.log('\n=== 6. isNewer 便捷封装 ===')
ok(isNewer('0.1.5-rc.2', '0.1.5-rc.1') === true, 'rc.2 比 rc.1 新')
ok(isNewer('0.1.5-rc.1', '0.1.5-rc.1') === false, '相同版本不是更新')
ok(isNewer('0.1.5-rc.1', '0.1.5-rc.2') === false, '旧版本不是更新')
ok(isNewer('bad', '1.0.0') === undefined, '无法解析时返回 undefined')
ok(isNewer('1.0.0+build.9', '1.0.0') === false, 'build metadata 不影响大小')

console.log('')
if (failed > 0) {
  console.error(`${failed} 项失败`)
  process.exit(1)
}
console.log('全部通过。')
