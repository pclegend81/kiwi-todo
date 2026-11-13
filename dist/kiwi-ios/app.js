/**
 * KIWI待办 · 网页/桌面端（Web/PWA）主逻辑
 *
 * 三端同一份代码：PC 浏览器直接打开，安卓/iOS 浏览器「添加到主屏幕」后像原生 App 一样全屏运行。
 * 数据不落本地，全部经 webapi 云函数读写微信云开发的同一个 todos 集合，
 * 因此与微信小程序、以及任意多台网页设备之间天然互相同步。
 *
 * 身份：小程序「我的」页生成 8 位同步口令 -> 这里 bind 换成 token，token 存 localStorage。
 */
;(function () {
  'use strict'

  var core = window.KiwiCore
  var HOLIDAYS = window.KIWI_HOLIDAYS || []
  var Vue = window.Vue

  var LS_TOKEN = 'kiwi_web_token'
  var LS_API = 'kiwi_web_api'
  var POLL_MS = 20000 // 20 秒轮询，保证小程序端改动能较快反映到网页端

  // 内置节假日表（与小程序 pusher 同一份数据，云端表覆盖由 webapi 负责）
  var holidayMap = {}
  for (var i = 0; i < HOLIDAYS.length; i++) {
    var row = HOLIDAYS[i]
    holidayMap[row.day] = row.kind === 'workday' ? 'workday' : 'holiday'
  }

  var notified = Object.create(null) // 本次会话已弹过通知的 at，避免重复

  function lsGet(k) { try { return localStorage.getItem(k) || '' } catch (e) { return '' } }
  function lsSet(k, v) { try { localStorage.setItem(k, v) } catch (e) { /* 隐私模式忽略 */ } }
  function lsDel(k) { try { localStorage.removeItem(k) } catch (e) {} }

  /** 调 webapi。兼容 HTTP 访问服务的「集成响应」与「普通响应」两种返回包装 */
  function callApi(url, action, payload) {
    if (!url) return Promise.reject(new Error('请先填写接口地址'))
    var body = Object.assign({ action: action }, payload || {})
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.text().then(function (text) {
        var data
        try { data = JSON.parse(text) } catch (e) {
          throw new Error('接口返回异常（HTTP ' + res.status + '）：' + text.slice(0, 120))
        }
        // 未开启集成响应时，整个 {statusCode, headers, body} 会被当 JSON 返回
        if (data && typeof data.statusCode === 'number' && typeof data.body === 'string') {
          try { data = JSON.parse(data.body) } catch (e) { /* 保持原样，下面会报错提示 */ }
        }
        if (typeof data === 'string') {
          try { data = JSON.parse(data) } catch (e) {}
        }
        if (!data || !data.ok) {
          var msg = (data && data.message) || ('请求失败（HTTP ' + res.status + '）')
          var err = new Error(msg)
          err.status = res.status
          throw err
        }
        return data
      })
    })
  }

  /** 'YYYY-MM-DD HH:mm' -> ISO 字符串（与小程序 dt.toISOString() 完全同构） */
  function localToIso(v) {
    if (!v) return ''
    var d = new Date(v)
    return isNaN(d.getTime()) ? '' : d.toISOString()
  }

  /** ISO / datetime-local -> 表单需要的 'YYYY-MM-DDTHH:mm' */
  function isoToLocal(v) {
    if (!v) return ''
    var d = new Date(v)
    if (isNaN(d.getTime())) return ''
    function p(n) { return n < 10 ? '0' + n : String(n) }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      'T' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  function defaultForm() {
    var d = new Date(Date.now() + 60 * 60 * 1000)
    d.setMinutes(0, 0, 0)
    return {
      title: '', note: '',
      remindLocal: isoToLocal(d.toISOString()),
      repeat_type: 'none', repeat_interval: 1,
      skip_holiday: true, holiday_action: 'skip',
      priority: 'medium', manual_done: false,
    }
  }

  var app = Vue.createApp({
    data: function () {
      return {
        bound: !!lsGet(LS_TOKEN),
        token: lsGet(LS_TOKEN),
        codeInput: '',
        apiUrl: lsGet(LS_API),
        showApi: false,
        busy: false,
        refreshing: false,
        toast: '',
        todos: [],
        filter: 'active',
        query: '',           // 桌面工具栏搜索；手机端不显示输入框，始终为空
        editing: null,
        form: defaultForm(),
        lastSyncText: '',
      }
    },

    computed: {
      visibleTodos: function () {
        var self = this
        var q = String(this.query || '').trim().toLowerCase()
        var list = this.todos.filter(function (t) {
          if (self.filter === 'active' && t.status !== 'active') return false
          if (self.filter === 'done' && t.status !== 'done') return false
          if (q && (String(t.title || '') + ' ' + String(t.note || '')).toLowerCase().indexOf(q) < 0) return false
          return true
        })
        return list.sort(function (a, b) {
          return new Date(a.remind_at).getTime() - new Date(b.remind_at).getTime()
        })
      },
      countActive: function () {
        return this.todos.filter(function (t) { return t.status === 'active' }).length
      },
      countDone: function () {
        return this.todos.filter(function (t) { return t.status === 'done' }).length
      },
      /** 桌面侧栏「下一次提醒」：取所有进行中待办里最近的一次 */
      nextUpcoming: function () {
        var best = null
        var list = this.todos || []
        for (var i = 0; i < list.length; i++) {
          if (list[i].status !== 'active') continue
          try {
            var n = core.nextOccurrence(list[i], Date.now(), holidayMap)
            if (n && (!best || n.at < best.at)) best = n
          } catch (e) { /* 单条规则异常不影响其它待办 */ }
        }
        return best ? best.atText : '暂无待提醒'
      },
      hasInterval: function () {
        return ['daily', 'weekly', 'monthly', 'yearly', 'hourly', 'minutely']
          .indexOf(this.form.repeat_type) >= 0
      },
      unitText: function () {
        var u = {
          daily: '天', weekly: '周', monthly: '个月', yearly: '年',
          hourly: '小时', minutely: '分钟',
        }
        return u[this.form.repeat_type] || ''
      },
    },

    mounted: function () {
      var self = this
      if (this.bound) this.refresh()
      this.pollTimer = setInterval(function () {
        if (self.bound && !document.hidden) self.refresh(true)
      }, POLL_MS)
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden && self.bound) self.refresh(true)
      })
      // 桌面端键盘快捷键（手机没有实体键盘，触发不到，无需做平台判断）
      this.keyHandler = function (e) { self.onKeydown(e) }
      document.addEventListener('keydown', this.keyHandler)
      // 页面打开期间的本地通知（Web 无法像微信订阅消息那样后台推送）
      this.notifyTimer = setInterval(function () { self.checkDue() }, 30000)
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(function () { /* 离线缓存失败不影响使用 */ })
      }
    },

    beforeUnmount: function () {
      clearInterval(this.pollTimer)
      clearInterval(this.notifyTimer)
      if (this.keyHandler) document.removeEventListener('keydown', this.keyHandler)
    },

    methods: {
      setFilter: function (f) {
        this.filter = f
      },

      /** 桌面快捷键：N 新建 / 搜索 / R 刷新 / Esc 关闭 / Ctrl(⌘)+Enter 保存 */
      onKeydown: function (e) {
        var el = e.target || {}
        var tag = String(el.tagName || '').toLowerCase()
        var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true
        if (this.editing && (e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault()
          this.save()
          return
        }
        if (e.key === 'Escape') {
          if (this.editing) this.editing = null
          else if (this.query) this.query = ''
          return
        }
        if (typing || this.editing || !this.bound) return
        if (e.key === 'n' || e.key === 'N') {
          e.preventDefault()
          this.openNew()
        } else if (e.key === '/') {
          var box = document.querySelector('.search-input')
          if (box && box.offsetParent !== null) { e.preventDefault(); box.focus() }
        } else if (e.key === 'r' || e.key === 'R') {
          e.preventDefault()
          this.refresh()
        }
      },

      showToast: function (msg, ms) {
        var self = this
        this.toast = msg
        clearTimeout(this.toastTimer)
        this.toastTimer = setTimeout(function () { self.toast = '' }, ms || 2200)
      },

      api: function (action, payload) {
        var self = this
        return callApi(this.apiUrl, action, payload).catch(function (e) {
          // token 失效：清掉本地会话，回到口令绑定页
          if (e.status === 401 || /token|口令|过期|无效/i.test(e.message)) {
            self.doUnbindLocal()
          }
          throw e
        })
      },

      doUnbindLocal: function () {
        lsDel(LS_TOKEN)
        this.token = ''
        this.bound = false
        this.todos = []
      },

      bind: function () {
        var self = this
        var code = String(this.codeInput || '').trim().toUpperCase()
        if (!code) return
        if (!this.apiUrl) {
          this.showApi = true
          this.showToast('请先填写接口地址')
          return
        }
        this.busy = true
        lsSet(LS_API, this.apiUrl)
        this.api('bind', { code: code })
          .then(function (res) {
            lsSet(LS_TOKEN, res.token)
            self.token = res.token
            self.bound = true
            self.codeInput = ''
            self.showToast('绑定成功，正在同步…')
            return self.refresh()
          })
          .catch(function (e) { self.showToast(e.message || '绑定失败') })
          .then(function () { self.busy = false })
      },

      unbind: function () {
        this.doUnbindLocal()
        this.showToast('已退出本设备，云端数据不受影响')
      },

      refresh: function (silent) {
        var self = this
        if (this.refreshing) return Promise.resolve()
        this.refreshing = true
        return this.api('listTodos', { token: this.token })
          .then(function (res) {
            self.todos = res.todos || []
            self.lastSyncText = new Date().toLocaleTimeString('zh-CN', { hour12: false })
            if (!silent) self.showToast('已同步 ' + self.todos.length + ' 条')
          })
          .catch(function (e) {
            if (!silent) self.showToast(e.message || '同步失败')
          })
          .then(function () { self.refreshing = false })
      },

      openNew: function () {
        this.form = defaultForm()
        this.editing = { id: '' }
      },

      openEdit: function (t) {
        this.form = {
          title: t.title || '',
          note: t.note || '',
          remindLocal: isoToLocal(t.remind_at),
          repeat_type: t.repeat_type || 'none',
          repeat_interval: Math.max(1, Number(t.repeat_interval) || 1),
          skip_holiday: t.skip_holiday !== false,
          holiday_action: t.holiday_action === 'postpone' ? 'postpone' : 'skip',
          priority: ['high', 'medium', 'low'].indexOf(t.priority) >= 0 ? t.priority : 'medium',
          manual_done: t.manual_done === true,
        }
        this.editing = { id: t.id }
      },

      save: function () {
        var self = this
        if (!this.form.title || !this.form.remindLocal) return
        var iso = localToIso(this.form.remindLocal)
        if (!iso) { this.showToast('提醒时间不合法'); return }
        var todo = {
          title: this.form.title,
          note: this.form.note,
          remind_at: iso,
          repeat_type: this.form.repeat_type,
          repeat_interval: Math.max(1, Number(this.form.repeat_interval) || 1),
          skip_holiday: this.form.skip_holiday,
          holiday_action: this.form.holiday_action,
          priority: this.form.priority,
          manual_done: this.form.manual_done,
          status: 'active',
        }
        this.busy = true
        var isNew = !this.editing.id
        var p = isNew
          ? this.api('insertTodo', { token: this.token, todo: todo })
          : this.api('updateTodo', { token: this.token, id: this.editing.id, patch: todo })
        p.then(function () {
          self.editing = null
          self.showToast(isNew ? '已创建，小程序里也能看到' : '已保存并同步')
          return self.refresh(true)
        })
          .catch(function (e) { self.showToast(e.message || '保存失败') })
          .then(function () { self.busy = false })
      },

      done: function (t) {
        var self = this
        this.api('updateTodo', {
          token: this.token, id: t.id,
          patch: { status: 'done', done_at: new Date().toISOString() },
        })
          .then(function () { self.showToast('已完成'); return self.refresh(true) })
          .catch(function (e) { self.showToast(e.message || '操作失败') })
      },

      remove: function (t) {
        var self = this
        if (!window.confirm('确定删除「' + (t.title || '无标题') + '」？三端都会同步删除。')) return
        this.api('removeTodo', { token: this.token, id: t.id })
          .then(function () { self.showToast('已删除'); return self.refresh(true) })
          .catch(function (e) { self.showToast(e.message || '删除失败') })
      },

      nextText: function (t) {
        try {
          var n = core.nextOccurrence(t, Date.now(), holidayMap)
          return n ? n.atText : '（当前规则下没有后续提醒）'
        } catch (e) { return '' }
      },

      repeatText: function (t) {
        try { return core.describeRepeat(t) } catch (e) { return '仅一次' }
      },

      priorityText: function (p) {
        return { high: '高', medium: '中', low: '低' }[p] || '中'
      },

      fmtTime: function (v) {
        var d = new Date(v)
        return isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { hour12: false })
      },

      /** 页面打开期间的本地通知：只提示，不改数据；真正的微信提醒仍由 pusher 下发 */
      checkDue: function () {
        if (!this.bound || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
        var now = Date.now()
        var list = this.todos || []
        for (var i = 0; i < list.length; i++) {
          var t = list[i]
          if (t.status !== 'active' || !t.remind_at) continue
          var base = new Date(t.remind_at).getTime()
          if (isNaN(base)) continue
          // 首次提醒时刻落在过去 1 分钟内、且本次会话没提醒过
          var key = t.id + ':' + base
          if (base <= now && now - base < 60000 && !notified[key]) {
            notified[key] = true
            try { new Notification('KIWI待办 · ' + (t.title || '提醒'), { body: t.note || '有一条待办到点了' }) } catch (e) {}
          }
        }
      },
    },
  })

  app.mount('#app')

  // 首次交互时申请通知权限（不能一进页面就弹，浏览器会拦）
  document.addEventListener('click', function requestOnce() {
    document.removeEventListener('click', requestOnce)
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { Notification.requestPermission() } catch (e) {}
    }
  })
})()
