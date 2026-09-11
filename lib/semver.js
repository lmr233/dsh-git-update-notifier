/**
 * 最小 semver 实现：只需要"解析 + 比较"，够用来判断 dsh 的发布版本。
 *
 * 为什么不能直接比字符串：dsh 目前处于 developer preview，registry 上存在大量
 * 预发布版本（`0.1.5-rc.1` / `0.1.5-rc.2` / `0.1.5-alpha.2`）。按 semver 规则，
 * 预发布版本**小于**同主次修订的正式版，预发布之间要逐段比较标识符——纯字符串
 * 比较会在 rc.2 与 rc.10、rc 与正式版这些地方给出错误结论。
 */

/** 解析 semver；无法解析时返回 undefined（调用方据此降级为"无法判断"）。 */
export function parseSemver(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
    .exec(String(text ?? '').trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/**
 * 比较两个 semver：`a > b` 返回 1，`a < b` 返回 -1，相等返回 0。
 * 任一无法解析时返回 undefined。
 */
export function compareSemver(a, b) {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (left === undefined || right === undefined) return undefined

  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1
  }

  // 同主次修订时：正式版 > 预发布版；都是正式版则相等。
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1

  const length = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < length; index += 1) {
    const x = left.pre[index]
    const y = right.pre[index]
    // 段数少的一方更小（1.0.0-rc < 1.0.0-rc.1）
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1
      continue
    }
    // 数字标识符 < 字母标识符（semver 规范）
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/** `candidate` 是否比 `current` 新；任一无法解析时返回 undefined。 */
export function isNewer(candidate, current) {
  const result = compareSemver(candidate, current)
  return result === undefined ? undefined : result > 0
}
