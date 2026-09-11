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
.gun_sec{display:flex;flex-direction:column;gap:12px;max-width:760px;
  color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.gun_secHead{align-items:center;gap:8px;display:flex}
.gun_pill{flex:none;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);
  border-radius:999px;padding:1px 8px;font-size:11px;line-height:16px}
.gun_pill[data-tone=ok]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.gun_pill[data-tone=warn]{border-color:var(--dsw-alias-state-warning-primary);color:var(--dsw-alias-state-warning-primary)}
.gun_pill[data-tone=error]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.gun_msg{margin:0;color:var(--dsw-alias-label-tertiary)}
.gun_result{margin:0;color:var(--dsw-alias-label-secondary)}
.gun_result[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}
.gun_result[data-tone=warn]{color:var(--dsw-alias-state-warning-primary)}
.gun_result[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.gun_msg[data-error=true]{color:var(--dsw-alias-state-error-primary)}
.gun_facts{margin:0;display:grid;grid-template-columns:auto 1fr;gap:4px 12px}
.gun_fact{display:contents}
.gun_facts dt{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.gun_facts dd{margin:0;overflow-wrap:anywhere}
.gun_actionsStart{justify-content:flex-start}
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

/** 与宿主端 CODE_VERSION 必须一致（测试会断言），用于两半自检。 */
    var CODE_VERSION = '0.2.0-dev.3'

    /** 延期时长选项；天数上限与宿主端的 SNOOZE_MAX_DAYS 保持一致。 */
    var SNOOZE_OPTIONS = [
      { days: 1, label: '1 天' },
      { days: 3, label: '3 天' },
      { days: 7, label: '1 周' },
      { days: 14, label: '2 周' },
      { days: 30, label: '1 个月' },
    ]
    /**
     * 源码形态的「新旧」展示：两端都取得到版本号时优先用版本号，
     * 否则回退到提交号，避免信息缺失。
     */
    function versionLine(status) {
      var from = status.localVersion
      var to = status.remoteVersion
      if (typeof from === 'string' && from !== '' && typeof to === 'string' && to !== '') {
        return from + ' → ' + to
      }
      return shortSha(status.localHead) + ' → ' + shortSha(status.remoteHead)
    }

    /**
     * 把一次检测结果变成一句人话，用于手动检测后的即时反馈与设置页的常驻结果行。
     * 与状态徽标互补：徽标只给结论，这句给细节（版本、提交数、通道）。
     */
    function describeResult(status) {
      if (status === null || status === undefined) return '检测完成'
      var isGit = status.source === 'git'
      if (status.status === 'update-available') {
        if (isGit) {
          return '检测完成：发现新版本 ' + versionLine(status)
            + '（上游领先 ' + String(status.behind || 0) + ' 个提交）'
        }
        return '检测完成：发现新版本 ' + String(status.localVersion || '?')
          + ' → ' + String(status.target || '?')
      }
      if (status.status === 'up-to-date') {
        if (isGit) {
          return '检测完成：已是最新（' + String(status.localVersion || '—')
            + ' @ ' + shortSha(status.localHead) + '）'
        }
        return '检测完成：已是最新（' + String(status.channel || 'latest')
          + ' 通道 ' + String(status.localVersion || '—') + '）'
      }
      if (status.status === 'error') {
        return '检测失败：' + String(status.message || '未知原因')
      }
      return '检测完成'
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
      var snoozeState = react.useState(false)
      var snoozeOpen = snoozeState[0]
      var setSnoozeOpen = snoozeState[1]

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
      if (result === null
        && ((!isUpdate && !isError) || status.dismissed === true || status.snoozed === true)) return null

      /** 延期到若干天之后；期间不再弹卡片。 */
      var onSnooze = function (days) {
        setBusy('snooze')
        post('/snooze?days=' + String(days)).then(function (answered) {
          setBusy(null)
          setSnoozeOpen(false)
          if (answered.ok) setHidden(true)
          else setResult(answered)
        })
      }
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
            ? (isGit ? 'DeepSeek Harness 有新的上游版本' : 'DeepSeek Harness 有新版本')
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
          versionLine(status)))
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
        if (snoozeOpen) {
          SNOOZE_OPTIONS.forEach(function (option) {
            actions.push(h('button', {
              key: 'snooze-' + String(option.days), className: 'gun_btn', type: 'button',
              disabled: busy !== null, onClick: function () { onSnooze(option.days) },
            }, option.label))
          })
          actions.push(h('button', {
            key: 'snooze-cancel', className: 'gun_btn', type: 'button',
            disabled: busy !== null, onClick: function () { setSnoozeOpen(false) },
          }, '取消'))
        } else if (isUpdate) {
          actions.push(h('button', {
            key: 'snooze', className: 'gun_btn', type: 'button',
            disabled: busy !== null, onClick: function () { setSnoozeOpen(true) },
          }, '延期…'))
        }
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

    /** 把 ISO 时间转成本地可读文本；缺失或非法时退回原值/破折号。 */
    function formatTime(iso) {
      if (typeof iso !== 'string' || iso === '') return '—'
      var date = new Date(iso)
      if (Number.isNaN(date.getTime())) return iso
      return date.toLocaleString()
    }

    /**
     * 设置页的一级区块：更新状态框 + 手动检测。
     *
     * 与浮层卡片的分工：卡片只在"需要用户决定"时冒出来；这里是常驻的查询入口，
     * 状态、版本、上次/下次检查时间都能看到，也能随时手动触发一次检测。
     */
    function UpdateSection() {
      var state = react.useState(null)
      var status = state[0]
      var setStatus = state[1]
      var busyState = react.useState(null)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var noteState = react.useState(null)
      var note = noteState[0]
      var setNote = noteState[1]
      var snoozeState = react.useState(false)
      var snoozeOpen = snoozeState[0]
      var setSnoozeOpen = snoozeState[1]
      // 回退是不可逆的写操作，先要点一次「回退」再点「确认回退」。
      var rollbackState = react.useState(false)
      var rollbackConfirm = rollbackState[0]
      var setRollbackConfirm = rollbackState[1]

      react.useEffect(function () {
        var alive = true
        readStatus().then(function (next) { if (alive) setStatus(next) })
        return function () { alive = false }
      }, [])

      function refresh() {
        readStatus().then(function (next) { setStatus(next) })
      }

      function onCheck() {
        setBusy('check')
        setNote('正在检测…')
        post('/check').then(function (answered) {
          setBusy(null)
          if (answered.ok) {
            setStatus(answered.body)
            setNote(describeResult(answered.body))
          } else {
            setNote(String(answered.body.message || '检测失败'))
          }
        })
      }

      function onSnooze(days) {
        setBusy('snooze')
        post('/snooze?days=' + String(days)).then(function (answered) {
          setBusy(null)
          setSnoozeOpen(false)
          setNote(answered.ok
            ? '已延期 ' + String(answered.body.days) + ' 天，期间不再弹出提醒'
            : String(answered.body.message || '延期失败'))
          refresh()
        })
      }

      /** 取消延期：恢复浮层提醒（用 days=0 表达"延期 0 天"）。 */
      function onUnsnooze() {
        setBusy('unsnooze')
        post('/snooze?days=0').then(function (answered) {
          setBusy(null)
          setNote(answered.ok
            ? '已取消延期，下次检测到更新会重新提醒'
            : String(answered.body.message || '取消失败'))
          refresh()
        })
      }

      /** 回退到上一次更新前的状态（需二次确认后再调用）。 */
      function onRollback() {
        setBusy('rollback')
        setNote(null)
        post('/rollback').then(function (answered) {
          setBusy(null)
          setRollbackConfirm(false)
          setNote(String(answered.body.message || (answered.ok ? '已回退' : '回退失败')))
          refresh()
        })
      }

      function onUpdate() {
        setBusy('update')
        setNote(null)
        post('/update').then(function (answered) {
          setBusy(null)
          setNote(String(answered.body.message || ''))
          refresh()
        })
      }

      var tone = 'idle'
      var statusText = '尚未检查'
      if (status !== null) {
        if (status.status === 'update-available') {
          statusText = '有可用更新'
          tone = 'warn'
        } else if (status.status === 'up-to-date') {
          statusText = '已是最新'
          tone = 'ok'
        } else if (status.status === 'error') {
          statusText = '检查失败'
          tone = 'error'
        }
      }

      // 自检：宿主半的改动必须重启 dsh 才生效，客户端半刷新即可。
      // 版本对不上时明确说出来，省得用户反复刷新猜原因。
      var stale = status !== null && status.codeVersion !== CODE_VERSION
      var hostVersion = status === null ? null : status.codeVersion

      var isGit = status !== null && status.source === 'git'
      var facts = []
      if (status !== null) {
        facts.push(['安装方式', String(status.layoutLabel || status.layout || '-')])
        if (isGit) {
          facts.push(['分支', String(status.branch || '-')])
          facts.push(['当前版本', String(status.localVersion || '—')])
          if (typeof status.remoteVersion === 'string' && status.remoteVersion !== '') {
            facts.push(['上游版本', status.remoteVersion])
          } else {
            facts.push(['上游提交', shortSha(status.remoteHead) + '（版本号未取到）'])
          }
          if (typeof status.behind === 'number') facts.push(['落后提交', String(status.behind) + ' 个'])
        } else {
          facts.push(['发布通道', String(status.channel || '-')])
          facts.push(['本地版本', String(status.localVersion || '-')])
          facts.push(['registry 版本', String(status.target || '-')])
        }
        facts.push(['上次检查', formatTime(status.lastCheckAt || status.checkedAt)])
        facts.push(['下次检查', formatTime(status.nextCheckAt)])
        if (status.snoozed === true) {
          facts.push(['已延期至', formatTime(status.snoozeUntil) + '（期间不再弹出提醒）'])
        }
        if (status.rollback !== null && status.rollback !== undefined) {
          facts.push(['上次更新', String(status.rollback.from) + ' → ' + String(status.rollback.to)
            + '（' + formatTime(status.rollback.at) + '）'])
        }
        facts.push(['位置', String(status.packageDir || '-')])
      }

      // 常驻结果行：自动检测「已是最新」时不弹卡片，但打开设置应当看得见结论。
      var resultText = status === null ? '尚未检查' : describeResult(status).replace('检测完成：', '')

      var children = []
      children.push(h('div', { className: 'gun_secHead', key: 'head' },
        h('span', { className: 'gun_title' }, 'dsh 更新'),
        h('span', { className: 'gun_pill', 'data-tone': tone, key: 'pill' }, statusText)))
      children.push(h('p', { className: 'gun_result', 'data-tone': tone, key: 'result' }, resultText))

      if (status === null) {
        children.push(h('p', { className: 'gun_msg', key: 'loading' }, '正在读取状态…'))
      } else {
        if (status.status === 'error' && status.message) {
          children.push(h('p', { className: 'gun_msg', 'data-error': 'true', key: 'err' }, String(status.message)))
        }
        if (stale) {
          children.push(h('p', { className: 'gun_msg', 'data-error': 'true', key: 'stale' },
            '插件两半版本不一致：宿主端 ' + String(hostVersion === undefined || hostVersion === null ? '（旧版，无版本标记）' : hostVersion)
            + '，客户端 ' + CODE_VERSION + '。宿主端的改动需要**重启 dsh web** 才生效（仅刷新页面不够）。'))
        }
        if (status.hint) {
          children.push(h('p', { className: 'gun_msg', key: 'hint' }, String(status.hint)))
        }
        children.push(h('dl', { className: 'gun_facts', key: 'facts' },
          facts.map(function (row, index) {
            return h('div', { className: 'gun_fact', key: String(index) },
              h('dt', null, row[0]), h('dd', null, row[1]))
          })))
        if (isGit && status.status === 'update-available'
          && Array.isArray(status.subjects) && status.subjects.length > 0) {
          children.push(h('ul', { className: 'gun_list', key: 'subjects' },
            status.subjects.map(function (line, index) { return h('li', { key: String(index) }, String(line)) })))
        }
      }

      if (status !== null && status.rollback !== null && status.rollback !== undefined
        && typeof status.rollback.script === 'string') {
        children.push(h('p', { className: 'gun_msg', key: 'rollback-script' },
          '若更新后 dsh 起不来，可直接运行这个不依赖 dsh 的回退脚本：' + status.rollback.script))
      }

      if (note !== null && note !== '') {
        children.push(h('p', { className: 'gun_msg', key: 'note' }, note))
      }

      var actions = []
      actions.push(h('button', {
        key: 'check', className: 'gun_btn', type: 'button', 'data-primary': 'true',
        disabled: busy !== null, onClick: onCheck,
      }, busy === 'check' ? '检测中…' : '手动检测更新'))
      if (status !== null && status.status === 'update-available') {
        actions.push(h('button', {
          key: 'update', className: 'gun_btn', type: 'button',
          disabled: busy !== null, onClick: onUpdate,
        }, busy === 'update' ? '正在更新…' : '立即更新'))
      }
      // 「延期」常驻：即使当前已是最新，也可以提前把未来一段时间的提醒压掉。
      if (status !== null) {
        if (snoozeOpen) {
          SNOOZE_OPTIONS.forEach(function (option) {
            actions.push(h('button', {
              key: 'snooze-' + String(option.days), className: 'gun_btn', type: 'button',
              disabled: busy !== null, onClick: function () { onSnooze(option.days) },
            }, '延期 ' + option.label))
          })
          actions.push(h('button', {
            key: 'snooze-cancel', className: 'gun_btn', type: 'button',
            disabled: busy !== null, onClick: function () { setSnoozeOpen(false) },
          }, '取消'))
        } else {
          actions.push(h('button', {
            key: 'snooze', className: 'gun_btn', type: 'button',
            disabled: busy !== null, onClick: function () { setSnoozeOpen(true) },
          }, '延期…'))
        }
      }
      if (status !== null && status.snoozed === true) {
        actions.push(h('button', {
          key: 'unsnooze', className: 'gun_btn', type: 'button',
          disabled: busy !== null, onClick: onUnsnooze,
        }, busy === 'unsnooze' ? '处理中…' : '取消延期'))
      }
      if (status !== null && status.rollback !== null && status.rollback !== undefined) {
        if (rollbackConfirm) {
          actions.push(h('button', {
            key: 'rollback-yes', className: 'gun_btn', type: 'button',
            disabled: busy !== null, onClick: onRollback,
          }, busy === 'rollback' ? '回退中…' : '确认回退'))
          actions.push(h('button', {
            key: 'rollback-no', className: 'gun_btn', type: 'button',
            disabled: busy !== null, onClick: function () { setRollbackConfirm(false) },
          }, '取消'))
        } else {
          actions.push(h('button', {
            key: 'rollback', className: 'gun_btn', type: 'button',
            disabled: busy !== null, onClick: function () { setRollbackConfirm(true) },
          }, '回退到更新前'))
        }
      }
      children.push(h('div', { className: 'gun_actions gun_actionsStart', key: 'actions' }, actions))

      return h('section', { className: 'gun_sec' }, children)
    }

    // ---------------------------------------------------------------- 插件
    /**
     * 注册到 `shell.overlay`：root 级列表 slot，位于所有栏之上、且本身
     * 点击穿透，因此摘要在里面显式声明 pointer-events:auto。
     */
    function apply(ctx) {
      // 根级浮层：仅在"有更新"或"检查失败"时出现的询问卡片。
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-git-update-notifier',
          order: 50,
        }, function (props) { return h(UpdateCard, props) })
      })

      // 设置页的一级区块：常驻的状态框与手动检测入口。
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-git-update-notifier',
          order: 60,
          label: function () { return '更新' },
        }, function (props) { return h(UpdateSection, props) })
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
