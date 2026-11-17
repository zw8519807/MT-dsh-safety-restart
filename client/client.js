// dsh-safety-restart 的浏览器半：设置 → 插件 里的一页（settings.plugins.tab）。
//
// ── 这个文件的第一原则是"不许把界面弄坏" ──
//
// 客户端半是唯一能影响别人界面的部分：一个 slot 注册参数写错，轻则自己这页
// 不出现，重则整页报错（历史上真实发生过：某插件在 list 型 slot 上少传必需的
// id → `list slot "..." requires options.id` → 模块 HTTP 200 能取到，
// 真正挂载时才炸）。所以这里做两件事：
//
//   1. 注册参数按 **当前版本验证过的契约** 传（settings.plugins.tab 是
//      list 型：要 name + id + order + label；keyed 型契约则要 key）。
//      多传一个用不到的字段不会报错，少传必需的那个才会 —— 所以 id 与
//      key 同时给出，兼容两类契约。
//   2. 整段 apply 包 try/catch。slot 契约再漂，结果也只是"没有这一页"，
//      且 console.warn 留痕，不吞证据。
window.__ModuleLoader__.load({
  id: 'dsh-safety-restart',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    var STATUS_API = '/safety-restart/status'
    var RESTART_API = '/safety-restart/restart'

    /** 页 id：同时用作 list 契约的 id 与 keyed 契约的 key。 */
    var ENTRY_ID = 'dsh-safety-restart'

    var CSS = [
      '.sr-card{display:flex;flex-direction:column;gap:8px}',
      '.sr-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.sr-dim{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.6}',
      '.sr-err{color:var(--dsw-alias-label-error,#e5484d);font-size:11px;line-height:1.6}',
      '.sr-ok{color:var(--dsw-alias-label-secondary)}',
    ].join('')
    var styled = false
    function ensureStyle() {
      if (styled || typeof document === 'undefined') return
      var el = document.createElement('style')
      el.setAttribute('data-dsh-safety-restart', '1')
      el.textContent = CSS
      document.head.appendChild(el)
      styled = true
    }

    function Card() {
      ensureStyle()
      var s = useState(null), st = s[0], setSt = s[1]
      var e = useState(null), err = e[0], setErr = e[1]
      var b = useState(false), busy = b[0], setBusy = b[1]
      var m = useState(null), msg = m[0], setMsg = m[1]

      var load = function () {
        fetch(STATUS_API, { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json() })
          .then(function (j) { if (j && j.ok) { setSt(j); setErr(null) } else setErr((j && j.error) || '读不到状态') })
          .catch(function (x) { setErr(String((x && x.message) || x)) })
      }
      useEffect(function () { load() }, [])

      var doRestart = function () {
        setBusy(true); setMsg(null)
        fetch(RESTART_API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'ui' }),
        })
          .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j } }) })
          .then(function (r) {
            setBusy(false)
            if (r.j && r.j.ok) { setMsg({ ok: true, text: '重启已排队，这个页面随后会断开一下再回来。' }); return }
            // 被闸门拒绝是**正常结果**，措辞不能让人以为是坏了。
            setMsg({ ok: false, text: (r.j && r.j.why) || ('HTTP ' + r.status) })
          })
          .catch(function (x) { setBusy(false); setMsg({ ok: false, text: '请求失败：' + String((x && x.message) || x) }) })
      }

      var loop = (st && st.loop) || null
      var last = st && st.audit && st.audit.length ? st.audit[st.audit.length - 1] : null
      var blocked = !!(loop && loop.tripped)

      return h('div', { className: 'sr-card' },
        h('div', { className: 'sr-row' },
          h('span', { className: 'sr-ok' }, st ? ('运行环境：' + (st.mode === 'desktop' ? '桌面端' : 'web / CLI（detached helper）')) : '读取中…'),
          loop ? h('span', { className: blocked ? 'sr-err' : 'sr-dim' },
            '最近 ' + Math.round((loop.windowMs || 0) / 60000) + ' 分钟重启 ' + loop.count + '/' + loop.max + ' 次') : null
        ),
        st && st.busy && st.busy.length
          ? h('div', { className: 'sr-dim' }, '有 ' + st.busy.length + ' 个会话正在跑一轮 —— 重启会把它们切断')
          : null,
        last ? h('div', { className: 'sr-dim' }, '最近一次：' + last.at + ' · ' + (last.kind || '') + (last.reason ? (' · ' + last.reason) : '') + (last.phase ? (' · ' + last.phase) : '')) : null,
        h('div', { className: 'sr-dim' }, '重启会让宿主半的代码改动生效。渲染器重载不够 —— 那条路只刷新界面，路由表仍是旧的。'),
        h('div', { className: 'sr-row' },
          h('button', {
            type: 'button',
            onClick: doRestart,
            disabled: busy || blocked,
            title: blocked ? '重启循环熔断中，先修好起不来的原因' : '重启 DSH',
          }, busy ? '重启中…' : '立即重启')
        ),
        msg ? h('div', { className: msg.ok ? 'sr-dim' : 'sr-err' }, msg.text) : null,
        err ? h('div', { className: 'sr-err' }, '读不到状态：' + err) : null
      )
    }

    var inject = ['slots']

    function apply(ctx) {
      // ★ 整个 apply 包起来：契约不符时只损失这一页，不牵连整个界面；
      //   且不吞证据 —— console.warn 留下原始异常供排查。
      try {
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          // 两个都给：list 契约要 id，keyed 契约要 key —— 少传必需的那个才会报错。
          id: ENTRY_ID,
          key: ENTRY_ID,
          order: 50,
          label: () => '安全重启',
        }, Card))
      } catch (e) {
        try { console.warn('[dsh-safety-restart] 设置页卡片未注册（slot 契约不符，功能本身不受影响）：', e) } catch { /* noop */ }
        return
      }
    }

    exports.name = 'dsh-safety-restart'
    exports.inject = inject
    exports.apply = apply
    // 离线渲染测试用的接缝
    exports.__components = { Card }
    exports.__css = CSS
    exports.__entryId = ENTRY_ID

    return module.exports
  },
})
