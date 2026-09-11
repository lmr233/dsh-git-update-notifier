/**
 * dsh-git-update-notifier — 客户端半（browser half）。
 *
 * 这是一个手写的 client bundle：不经过 tsdown/vite，直接以 classic script
 * 形式执行，通过 `window.__ModuleLoader__.load({ id, factory })` 把工厂登记
 * 进浏览器模块表。factory 只在模块被首次 import 时物化一次，所有副作用
 * （含 CSS 注入）都写在 factory 闭包里。
 *
 * 界面职责：宿主端当天检查出"上游有新提交"时，在 `shell.overlay`（root 级
 * 列表 slot，整帧最上层）挂一张卡片，把决定权交给用户：立即更新 / 稍后。
 */
window.__ModuleLoader__.load({
  id: 'dsh-git-update-notifier',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement

    /** 与宿主端约定的路由前缀。 */
    var ROUTE = '/dsh-git-update-notifier'

    // ---------------------------------------------------------------- 样式
    var css = `
.gun_wrap{position:fixed;right:20px;bottom:20px;z-index:60;width:min(420px,calc(100vw - 40px));
  max-height:min(70vh,560px);overflow:auto;pointer-events:auto;box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);
  border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;
  box-shadow:0 16px 40px rgba(0,0,0,.28);color:var(--dsw-alias-label-primary);
  font-size:13px;line-height:20px}
.gun_head{align-items:center;gap:8px;display:flex}
.gun_title{font-size:13px;font-weight:600;flex:1}
.gun_badge{flex:none;border:1px solid var(--dsw-alias-state-warning-primary);
  color:var(--dsw-alias-state-warning-primary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:16px}
.gun_badge[data-error=true]{border-color:var(--dsw-alias-state-error-primary);
  color:var(--dsw-alias-state-error-primary)}
.gun_body{color:var(--dsw-alias-label-tertiary);margin:0;display:flex;flex-direction:column;gap:6px}
.gun_kv{display:flex;gap:6px}
.gun_kv b{color:var(--dsw-alias-label-primary);font-weight:600}
.gun_code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;
  background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:6px 8px;overflow-wrap:anywhere}
.gun_list{margin:0;padding:0 0 0 2px;list-style:none;display:flex;flex-direction:column;gap:4px;
  max-height:150px;overflow:auto}
.gun_list li{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;
  color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.gun_actions{display:flex;gap:8px;justify-content:flex-end;align-items:center}
.gun_btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);
  border-radius:8px;padding:5px 12px;font-size:13px;line-height:18px;cursor:pointer;font-family:inherit}
.gun_btn:hover:not(:disabled){border-color:var(--dsw-alias-label-tertiary)}
.gun_btn:disabled{opacity:.5;cursor:default}
.gun_btn[data-primary=true]{border-color:var(--dsw-alias-state-business-primary);
  background:var(--dsw-alias-state-business-primary);color:#fff}
.gun_ok{color:var(--dsw-alias-state-success-primary)}
.gun_err{color:var(--dsw-alias-state-error-primary)}
`
    var tagId = 'dsh-git-update-notifier/client.css'
    if (typeof document !== 'undefined'
      && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-git-update-notifier'
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ---------------------------------------------------------------- 数据
    /** 读状态；路由还没挂上或宿主不可达时返回 null，卡片静默不显示。 */
    function readStatus() {
      return fetch(ROUTE + '/status.json', { cache: 'no-store' })
        .then(function (res) { return res.ok ? res.json() : null })
        .catch(function () { return null })
    }

    function post(path) {
      return fetch(ROUTE + path, { method: 'POST', headers: { 'content-type': 'application/json' } })
        .then(function (res) {
          return res.json().catch(function () { return {} }).then(function (body) {
            return { ok: res.ok, body: body }
          })
        })
        .catch(function (error) { return { ok: false, body: { message: String(error) } } })
    }

    function shortSha(sha) {
      return typeof sha === 'string' && sha.length >= 9 ? sha.slice(0, 9) : String(sha || '')
    }

    // ---------------------------------------------------------------- 组件
    function UpdateCard() {
      var state = react.useState(null)
      var status = state[0]
      var setStatus = state[1]
      var busyState = react.useState(null)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var resultState = react.useState(null)
      var result = resultState[0]
      var setResult = resultState[1]
      var hiddenState = react.useState(false)
      var hidden = hiddenState[0]
      var setHidden = hiddenState[1]

      react.useEffect(function () {
        var alive = true
        readStatus().then(function (next) { if (alive) setStatus(next) })
        return function () { alive = false }
      }, [])

      // 值得占界面的只有两种：真的落后了，或者检查没能完成。
      // 已是最新、还没有状态、以及用户已经处理过，都不打扰。
      if (hidden || status === null) return null
      var isUpdate = status.status === 'update-available'
      var isError = status.status === 'error'
      if (result === null && (!isUpdate && !isError || status.dismissed === true)) return null

      var onLater = function () {
        setBusy('dismiss')
        post('/dismiss').then(function () {
          setBusy(null)
          setHidden(true)
        })
      }

      var onUpdate = function () {
        setBusy('update')
        setResult(null)
        post('/update').then(function (answered) {
          setBusy(null)
          setResult(answered)
        })
      }

      var onRecheck = function () {
        setBusy('check')
        post('/check').then(function (answered) {
          setBusy(null)
          if (answered.ok) {
            setResult(null)
            setStatus(answered.body)
          }
        })
      }

      // 源码形态看提交，npx / npm 安装看版本 —— 两种形态"新"的含义不同。
      var isGit = status.source === 'git'
      var installLabel = status.layoutLabel || status.layout || '-'

      var children = []

      children.push(h('div', { className: 'gun_head', key: 'head' },
        h('span', { className: 'gun_title' },
          isUpdate
            ? (isGit ? 'DeepSeek Harness 有新的上游提交' : 'DeepSeek Harness 有新版本')
            : '更新检查失败'),
        h('span', { className: 'gun_badge', 'data-error': isError ? 'true' : 'false' },
          isUpdate
            ? (isGit
                ? '落后 ' + String(status.behind || 0) + ' 个提交'
                : '可升级到 ' + String(status.target || '?'))
            : '未能检查')))

      var body = []
      if (isError) {
        body.push(h('div', { className: 'gun_code', key: 'message' },
          String(status.message || '检查未能完成')))
        if (status.hint !== undefined && status.hint !== null) {
          body.push(h('div', { key: 'hint' }, String(status.hint)))
        }
      } else if (isGit) {
        body.push(h('div', { className: 'gun_kv', key: 'branch' },
          h('b', null, '分支'), h('span', null, String(status.branch || '-'))))
        body.push(h('div', { className: 'gun_code', key: 'head' },
          shortSha(status.localHead) + ' → ' + shortSha(status.remoteHead)))
      } else {
        body.push(h('div', { className: 'gun_kv', key: 'channel' },
          h('b', null, '发布通道'), h('span', null, String(status.channel || '-'))))
        body.push(h('div', { className: 'gun_code', key: 'version' },
          String(status.localVersion || '?') + ' → ' + String(status.target || '?')))
      }
      body.push(h('div', { className: 'gun_kv', key: 'layout' },
        h('b', null, '安装方式'), h('span', null, installLabel)))
      body.push(h('div', { className: 'gun_kv', key: 'dir' },
        h('b', null, '位置'), h('span', null, String(status.packageDir || '-'))))
      children.push(h('div', { className: 'gun_body', key: 'body' }, body))

      if (isGit && Array.isArray(status.subjects) && status.subjects.length > 0) {
        children.push(h('ul', { className: 'gun_list', key: 'list' },
          status.subjects.map(function (line, index) { return h('li', { key: String(index) }, String(line)) })))
      }

      if (result !== null) {
        var text = result.ok
          ? '更新成功：' + String(result.body.message || '')
          : '更新失败：' + String(result.body.message || '未知错误')
        if (result.ok && result.body.needsRestart !== false) {
          text += isGit
            ? '。源码 checkout 需要重新构建（pnpm build:lib）并重启 dsh 后才会生效。'
            : '。重启 dsh 后生效；npx 形态请重新执行 npx 命令。'
        }
        children.push(h('div', { key: 'result', className: result.ok ? 'gun_ok' : 'gun_err' }, text))
      }

      var actions = []
      if (result === null) {
        actions.push(h('button', {
          key: 'later', className: 'gun_btn', type: 'button',
          disabled: busy !== null, onClick: onLater,
        }, busy === 'dismiss' ? '处理中…' : isUpdate ? '稍后' : '关闭'))
        actions.push(h('button', {
          key: 'recheck', className: 'gun_btn', type: 'button',
          disabled: busy !== null, onClick: onRecheck,
        }, busy === 'check' ? '检查中…' : '重新检查'))
        if (isUpdate) {
          actions.push(h('button', {
            key: 'update', className: 'gun_btn', type: 'button', 'data-primary': 'true',
            disabled: busy !== null, onClick: onUpdate,
          }, busy === 'update' ? '正在更新…' : '立即更新'))
        }
      } else {
        actions.push(h('button', {
          key: 'close', className: 'gun_btn', type: 'button',
          onClick: function () { setHidden(true) },
        }, '关闭'))
        if (!result.ok) {
          actions.push(h('button', {
            key: 'retry', className: 'gun_btn', type: 'button', 'data-primary': 'true',
            onClick: function () { setResult(null) },
          }, '重试'))
        }
      }
      children.push(h('div', { className: 'gun_actions', key: 'actions' }, actions))

      return h('div', { className: 'gun_wrap', role: 'status' }, children)
    }

    // ---------------------------------------------------------------- 插件
    /**
     * 注册到 `shell.overlay`：root 级列表 slot，位于所有栏之上、且本身
     * 点击穿透，因此摘要在里面显式声明 pointer-events:auto。
     */
    function apply(ctx) {
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-git-update-notifier',
          order: 50,
        }, function (props) { return h(UpdateCard, props) })
      })
    }

    module.exports = {
      name: 'dsh-git-update-notifier',
      inject: ['slots'],
      apply: apply,
    }
    return module.exports
  },
})
