/**
 * 客户端 bundle 验证：用 stub react + stub DOM 执行 lib/client.js，
 * 检查它是否按 DSH 的模块协议登记 factory、导出正确的 Cordis 插件，
 * 以及询问卡片在各状态下渲染/隐藏是否正确、按钮是否打到正确的路由。
 *
 * 用法：node test/client-render.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(HERE, '..', 'lib', 'client.js')

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`)
    return
  }
  console.error(`\n✗ 断言失败：${message}`)
  process.exit(1)
}

// ------------------------------------------------------------ 记录 fetch 调用
const fetchCalls = []
let nextStatusBody = {}

function makeFetch() {
  return async (url, init) => {
    fetchCalls.push({ url, init })
    return { ok: true, json: async () => nextStatusBody }
  }
}

// ------------------------------------------------------------ stub react
let hookValues = []
let hookCursor = 0

const react = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.flat(Infinity) } }
  },
  useState(initial) {
    const value = hookValues[hookCursor]
    hookCursor += 1
    return [value === undefined ? initial : value, () => {}]
  },
  useEffect() {
    hookCursor += 1
  },
}

// ------------------------------------------------------------ stub DOM / window
const styleTags = []
const document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: (tag) => styleTags.push(tag) },
}

let registration = null
const window = {
  __ModuleLoader__: { load: (value) => { registration = value } },
}

// ------------------------------------------------------------ 执行 client bundle
console.log('=== 1. 执行 lib/client.js，检查模块协议登记 ===')
const source = readFileSync(CLIENT_PATH, 'utf8')
const sandbox = {
  window,
  document,
  fetch: makeFetch(),
  console,
  setTimeout,
  clearTimeout,
  queueMicrotask,
  Symbol,
  JSON,
  String,
  Number,
  Boolean,
  Array,
  Object,
  Promise,
  Error,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'lib/client.js' })

assert(registration !== null, '调用了 window.__ModuleLoader__.load')
assert(registration.id === 'dsh-git-update-notifier', `登记 id 等于包名：${registration.id}`)
assert(typeof registration.factory === 'function', 'factory 是函数')

const requiredSpecs = []
const exports = registration.factory((spec) => {
  requiredSpecs.push(spec)
  if (spec === 'react') return react
  throw new Error(`意外的 require：${spec}`)
})

console.log('\n=== 2. 检查 Cordis 插件导出 ===')
assert(exports.name === 'dsh-git-update-notifier', `导出 name：${exports.name}`)
assert(Array.isArray(exports.inject) && exports.inject.includes('slots'), 'inject 声明了 slots 服务')
assert(typeof exports.apply === 'function', '导出 apply 函数')
assert(requiredSpecs.join(',') === 'react', `只 require 了 seed word react（实际：${requiredSpecs.join(',')}）`)
assert(styleTags.length === 1, '注入了一个样式标签')
assert(styleTags[0].dataset.plugin === 'dsh-git-update-notifier', '样式标签带 data-plugin 标记')

console.log('\n=== 3. 检查注册到 shell.overlay ===')
const registered = []
const fakeCtx = {
  slots: {
    inject(name, factory) { return factory() },
    register(options, Component) {
      registered.push({ options, Component })
      return () => {}
    },
  },
}
exports.apply(fakeCtx)
assert(registered.length === 1, `注册了 1 个条目（实际 ${registered.length}）`)
assert(registered[0].options.name === 'shell.overlay', '注册到 shell.overlay')
assert(registered[0].options.id === 'dsh-git-update-notifier', '带稳定 id')

// ------------------------------------------------------------ 渲染工具
function renderCard(values) {
  hookValues = values
  hookCursor = 0
  const wrapper = registered[0].Component({})
  hookCursor = 0
  return wrapper.type(wrapper.props)
}

function collectText(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out)
    return out
  }
  if (typeof node === 'object' && node.props !== undefined) collectText(node.props.children, out)
  return out
}

function collectButtons(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) collectButtons(item, out)
    return out
  }
  if (node.type === 'button') out.push(node)
  if (node.props !== undefined) collectButtons(node.props.children, out)
  return out
}

const UPDATE_AVAILABLE = {
  status: 'update-available',
  behind: 2,
  branch: 'master',
  localHead: 'ab30bf5dbbdb5ecffec825a47ba31b4bd40b3e9d',
  remoteHead: 'c63b0e8b170166de6ea6cd3ab9a5f27a1c900426',
  root: 'D:\\checkout',
  subjects: ['c63b0e8 upstream: 新增 b.txt', 'aaaaaaa 修复问题'],
  dismissed: false,
}

console.log('\n=== 4. 各状态下卡片的显示/隐藏 ===')
assert(renderCard([null, null, null, false]) === null, '还没有状态时渲染为 null')
assert(renderCard([{ ...UPDATE_AVAILABLE, status: 'up-to-date' }, null, null, false]) === null,
  'up-to-date 时不显示')
assert(renderCard([{ ...UPDATE_AVAILABLE, dismissed: true }, null, null, false]) === null,
  'dismissed=true 时不显示')

const card = renderCard([UPDATE_AVAILABLE, null, null, false])
assert(card !== null, 'update-available 时渲染卡片')
const text = collectText(card).join(' | ')
console.log(`  卡片文本：${text}`)
assert(text.includes('有新的上游提交'), '标题正确')
assert(text.includes('落后 2 个提交'), '展示落后提交数')
assert(text.includes('ab30bf5db → c63b0e8b1'), '展示本地→远端短 SHA')
assert(text.includes('新增 b.txt'), '展示上游提交摘要')

const buttons = collectButtons(card)
const labels = buttons.map((node) => collectText(node).join(''))
console.log(`  按钮：${labels.join(' / ')}`)
assert(labels.includes('立即更新'), '有"立即更新"按钮')
assert(labels.includes('稍后'), '有"稍后"按钮')
assert(labels.includes('重新检查'), '有"重新检查"按钮')

console.log('\n=== 5. 按钮触发的请求 ===')
async function click(label) {
  fetchCalls.length = 0
  const button = buttons.find((node) => collectText(node).join('') === label)
  assert(button !== undefined, `找到按钮：${label}`)
  button.props.onClick()
  await new Promise((done) => setImmediate(done))
  await new Promise((done) => setImmediate(done))
  return fetchCalls.map((call) => `${String(call.init?.method ?? 'GET')} ${call.url}`)
}

const updateCalls = await click('立即更新')
console.log(`  ${updateCalls.join(', ')}`)
assert(updateCalls.includes('POST /dsh-git-update-notifier/update'), '点击"立即更新"发出 POST /update')

const laterCalls = await click('稍后')
console.log(`  ${laterCalls.join(', ')}`)
assert(laterCalls.includes('POST /dsh-git-update-notifier/dismiss'), '点击"稍后"发出 POST /dismiss')

const recheckCalls = await click('重新检查')
console.log(`  ${recheckCalls.join(', ')}`)
assert(recheckCalls.includes('POST /dsh-git-update-notifier/check'), '点击"重新检查"发出 POST /check')

console.log('\n=== 6. 检查失败态：必须给用户反馈，而不是静默 ===')
const errorStatus = {
  status: 'error',
  root: 'D:\\checkout',
  branch: 'master',
  localHead: 'ab30bf5dbbdb5ecffec825a47ba31b4bd40b3e9d',
  message: 'git fetch origin master 连续 3 次失败：Failed to connect to github.com:443',
  hint: '请确认这台机器能访问远端（网络、代理或凭证）。',
  dismissed: false,
}
assert(renderCard([{ ...errorStatus, dismissed: true }, null, null, false]) === null, 'dismissed 的失败态不显示')

const errorCard = renderCard([errorStatus, null, null, false])
assert(errorCard !== null, '检查失败时也显示卡片')
const errorText = collectText(errorCard).join(' | ')
assert(errorText.includes('上游更新检查失败'), '失败标题')
assert(errorText.includes('未能检查'), '失败徽标')
assert(errorText.includes('Failed to connect'), '展示失败原因')
assert(errorText.includes('网络、代理或凭证'), '展示排查提示')

const errorButtons = collectButtons(errorCard).map((node) => collectText(node).join(''))
console.log(`  按钮：${errorButtons.join(' / ')}`)
assert(errorButtons.includes('关闭'), '失败态有"关闭"按钮')
assert(errorButtons.includes('重新检查'), '失败态有"重新检查"按钮')
assert(!errorButtons.includes('立即更新'), '失败态没有"立即更新"按钮')

const noHintCard = renderCard([{ ...errorStatus, hint: null }, null, null, false])
const noHintText = collectText(noHintCard).join(' | ')
assert(!noHintText.includes('null'), 'hint 为 null 时不会渲染出 "null" 字样')

console.log('\n=== 7. 更新结果态 ===')
const successCard = renderCard([UPDATE_AVAILABLE, null, { ok: true, body: { message: '已更新到 c63b0e8b1' } }, false])
const successText = collectText(successCard).join(' | ')
assert(successText.includes('更新成功'), '成功文案')
assert(successText.includes('需要重新构建'), '提示重新构建与重启')

const failureCard = renderCard([UPDATE_AVAILABLE, null, { ok: false, body: { message: 'ff-only 失败' } }, false])
const failureText = collectText(failureCard).join(' | ')
assert(failureText.includes('更新失败'), '失败文案')
assert(collectButtons(failureCard).map((n) => collectText(n).join('')).includes('重试'), '失败后有"重试"按钮')

console.log('\n全部断言通过。')
process.exit(0)
