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
  var HOLIDAYS = window.KIWI_HOLIDAYS || []          // 中国大陆 2027（默认，保持原样）
  var Vue = window.Vue
  var LANGS = window.KIWI_LANGS || []
  var LOCALES = window.KIWI_LOCALES || {}
  var I18N_BASE = window.KIWI_I18N || {}
  var EXTRA = window.KIWI_I18N_EXTRA || {}
  var REGION_HOLIDAYS = window.KIWI_REGION_HOLIDAYS || {}

  var LS_TOKEN = 'kiwi_web_token'
  var LS_API = 'kiwi_web_api'
  var LS_LANG = 'kiwi_web_lang'
  var POLL_MS = 20000 // 20 秒轮询，保证小程序端改动能较快反映到网页端

  // 合并「基础字典 + 补充字典」；缺词回退 zh-CN，再回退 key 本身，新增 key 不会白屏
  var I18N = {}
  for (var li = 0; li < LANGS.length; li++) {
    var code = LANGS[li].code
    var dict = Object.assign({}, I18N_BASE[code] || {})
    Object.keys(EXTRA).forEach(function (k) {
      dict[k] = (EXTRA[k] && EXTRA[k][code]) || (EXTRA[k] && EXTRA[k]['zh-CN']) || k
    })
    I18N[code] = dict
  }

  function validLang(c) {
    for (var i = 0; i < LANGS.length; i++) if (LANGS[i].code === c) return true
    return false
  }

  /** 首次访问按浏览器语言猜一个，猜不中回落简体中文 */
  function initialLang() {
    var saved = lsGet(LS_LANG)
    if (validLang(saved)) return saved
    var nav = String((navigator.language || navigator.userLanguage || '')).toLowerCase()
    var map = {
      'zh-tw': 'zh-TW', 'zh-hk': 'zh-TW', 'zh-mo': 'zh-TW', 'zh-cn': 'zh-CN',
      'en-gb': 'en-GB', 'en-us': 'en-US', 'en-au': 'en-GB', 'ja': 'ja', 'ja-jp': 'ja',
      'ko': 'ko', 'ko-kr': 'ko', 'de': 'de', 'fr': 'fr', 'es': 'es',
      'it': 'it', 'pt-br': 'pt-BR', 'pt': 'pt-BR',
    }
    if (map[nav]) return map[nav]
    var head = nav.slice(0, 2)
    if (map[head]) return map[head]
    return 'zh-CN'
  }

  /** 语言 -> 地区（cn/us/gb/jp/kr/de/fr/es/it/br），地区决定用哪份节假日表 */
  function regionOf(c) {
    for (var i = 0; i < LANGS.length; i++) if (LANGS[i].code === c) return LANGS[i].region
    return 'cn'
  }

  function translate(c, key, vars) {
    var d = I18N[c] || I18N['zh-CN'] || {}
    var s = d[key]
    if (s === undefined) s = (I18N['zh-CN'] || {})[key]
    if (s === undefined) s = key
    s = String(s)
    var v = vars || {}
    return s.replace(/\{(\w+)\}/g, function (m, k) {
      return v[k] === undefined ? m : String(v[k])
    })
  }

  /**
   * 节假日表按当前语言的地区重建：切换语言 = 切换当地法定节假日。
   * 中国大陆地区沿用原 HOLIDAYS_2027（含调休补班 workday），其它地区用地区表。
   */
  function buildHolidayMap(region) {
    var rows = REGION_HOLIDAYS[region] || HOLIDAYS
    var map = {}
    for (var i = 0; i < rows.length; i++) {
      map[rows[i].day] = rows[i].kind === 'workday' ? 'workday' : 'holiday'
    }
    return map
  }

  var notified = Object.create(null) // 本次会话已弹过通知的 at，避免重复
  var currentLang = initialLang()   // 模块级镜像：非组件代码（callApi / 回调页）也要取词

  function lsGet(k) { try { return localStorage.getItem(k) || '' } catch (e) { return '' } }
  function lsSet(k, v) { try { localStorage.setItem(k, v) } catch (e) { /* 隐私模式忽略 */ } }
  function lsDel(k) { try { localStorage.removeItem(k) } catch (e) {} }

  /** 调 webapi。兼容 HTTP 访问服务的「集成响应」与「普通响应」两种返回包装 */
  function callApi(url, action, payload) {
    if (!url) return Promise.reject(new Error(translate(currentLang, 't_no_api')))
    var body = Object.assign({ action: action }, payload || {})
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.text().then(function (text) {
        var status = res.status
        var data
        try { data = JSON.parse(text) } catch (e) {
          throw new Error(translate(currentLang, 't_api_bad', { n: status }) + '：' + text.slice(0, 120))
        }
        // 未开启集成响应时，整个 {statusCode, headers, body} 会被当 JSON 返回；
        // 此时 HTTP 层恒为 200，需要把内层 statusCode 取出来，401/409 才判得准。
        if (data && typeof data.statusCode === 'number' && typeof data.body === 'string') {
          status = data.statusCode
          try { data = JSON.parse(data.body) } catch (e) { /* 保持原样，下面会报错提示 */ }
        }
        if (typeof data === 'string') {
          try { data = JSON.parse(data) } catch (e) {}
        }
        if (!data || !data.ok) {
          var msg = (data && data.message) || translate(currentLang, 't_req_fail', { n: status })
          var err = new Error(msg)
          err.status = status
          err.code = (data && data.code) || ''
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
        // 当前界面语言；切换它会同时按语言绑定的地区重建 holidayMap
        lang: currentLang,
        holidayMap: buildHolidayMap(regionOf(currentLang)),
        showLangMenu: false,
        codeInput: '',
        apiUrl: lsGet(LS_API),
        showApi: false,
        busy: false,
        refreshing: false,
        toast: '',
        // 第三方登录：providers 只含云端已配好凭证的平台（未配置的不渲染按钮）
        providers: [],
        allProviders: [],
        showProviderStatus: false,
        account: null,      // { linked, needsLink, provider, identities }
        linkCode: '',
        todos: [],
        filter: 'active',
        query: '',           // 桌面工具栏搜索；手机端不显示输入框，始终为空
        editing: null,
        form: defaultForm(),
        lastSyncText: '',
      }
    },

    computed: {
      /** 语言绑定的地区：决定用哪份当地法定节假日表、以及显示哪些当地社交登录 */
      region: function () { return regionOf(this.lang) },
      regionName: function () { return translate(this.lang, 'region_name') },
      langList: function () { return LANGS },
      /** 登录按钮：全球通用平台（regions 为空）始终显示，当地平台只在对应地区显示 */
      visibleProviders: function () {
        var rg = this.region
        return (this.providers || []).filter(function (p) {
          var rs = p.regions || []
          return !rs.length || rs.indexOf(rg) >= 0
        })
      },
      /** OAuth 回调页与 index.html 同目录，拼成绝对地址给云函数签进 state */
      oauthRedirect: function () {
        try { return new URL('oauth-callback.html', window.location.href).href } catch (e) { return '' }
      },
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
            var n = core.nextOccurrence(list[i], Date.now(), this.holidayMap)
            if (n && (!best || n.at < best.at)) best = n
          } catch (e) { /* 单条规则异常不影响其它待办 */ }
        }
        return best ? best.atText : translate(this.lang, 't_none_upcoming')
      },
      hasInterval: function () {
        return ['daily', 'weekly', 'monthly', 'yearly', 'hourly', 'minutely']
          .indexOf(this.form.repeat_type) >= 0
      },
      unitText: function () {
        var u = {
          daily: 'unit_day', weekly: 'unit_week', monthly: 'unit_month', yearly: 'unit_year',
          hourly: 'unit_hour', minutely: 'unit_minute',
        }
        return u[this.form.repeat_type] ? translate(this.lang, u[this.form.repeat_type]) : ''
      },
    },

    watch: {
      // 用户第一次填接口地址后，立刻拉一次已接入平台列表
      apiUrl: function () { if (!this.bound) this.loadProviders() },
    },

    mounted: function () {
      var self = this
      document.documentElement.lang = this.lang
      document.title = translate(this.lang, 'app_name') + ' · ' + translate(this.lang, 'page_sub')
      if (this.bound) {
        this.loadAccount().then(function () { return self.refresh(true) })
      } else {
        this.loadProviders()
      }
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
      /** 取词模板：t(key, {n:5}) 会替换 {n} 占位符 */
      t: function (key, vars) { return translate(this.lang, key, vars) },

      /**
       * 切换语言：① 存本地 ② 按语言绑定的地区重建 holidayMap（节假日立即跟着变）
       * ③ 刷新「下一次提醒」等依赖 holidayMap 的展示 ④ 更新标题与提示。
       */
      setLang: function (c) {
        if (!validLang(c)) return
        currentLang = c
        lsSet(LS_LANG, c)
        this.lang = c
        this.holidayMap = buildHolidayMap(regionOf(c))
        this.showLangMenu = false
        document.title = translate(c, 'app_name') + ' · ' + translate(c, 'page_sub')
        this.showToast(translate(c, 'mp_region_toast', { name: translate(c, 'region_name') }))
      },

      locale: function () { return LOCALES[this.lang] || 'zh-CN' },

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
          // 只按 401 判定会话失效。409 NEED_LINK 是「尚未关联小程序」的业务引导，
          // 绝不能清本地 token，否则用户会被反复踢回登录页。
          if (e.status === 401) self.doUnbindLocal()
          throw e
        })
      },

      doUnbindLocal: function () {
        lsDel(LS_TOKEN)
        this.token = ''
        this.bound = false
        this.todos = []
        this.account = null
      },

      bind: function () {
        var self = this
        var code = String(this.codeInput || '').trim().toUpperCase()
        if (!code) return
        if (!this.apiUrl) {
          this.showApi = true
          this.showToast(this.t('t_no_api'))
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
            self.showToast(self.t('t_bound'))
            return self.loadAccount().then(function () { return self.refresh() })
          })
          .catch(function (e) { self.showToast(e.message || self.t('t_bind_fail')) })
          .then(function () { self.busy = false })
      },

      /** 拉云端「已配置凭证」的平台列表；没配凭证的平台根本不会返回，不留假按钮 */
      loadProviders: function () {
        var self = this
        if (!this.apiUrl) return Promise.resolve()
        return callApi(this.apiUrl, 'oauthProviders', {})
          .then(function (res) {
            self.providers = res.providers || []
            self.allProviders = res.all || []
          })
          .catch(function () { self.providers = []; self.allProviders = [] })
      },

      loadAccount: function () {
        var self = this
        if (!this.token) return Promise.resolve()
        return this.api('accountInfo', { token: this.token })
          .then(function (res) { self.account = res })
          .catch(function () { self.account = null })
      },

      /** 跳到平台授权页；state / PKCE verifier 暂存 sessionStorage，回调页原样带回 */
      oauthLogin: function (p) {
        var self = this
        if (!this.apiUrl) {
          this.showApi = true
          this.showToast(this.t('t_no_api'))
          return
        }
        var redirect = this.oauthRedirect
        if (!/^https?:/.test(redirect) || redirect.indexOf('https://') !== 0) {
          this.showToast(this.t('t_https'))
          return
        }
        lsSet(LS_API, this.apiUrl)
        this.busy = true
        callApi(this.apiUrl, 'oauthStart', { provider: p.id, redirectUri: redirect })
          .then(function (res) {
            try {
              sessionStorage.setItem('kiwi_oauth', JSON.stringify({
                state: res.state,
                verifier: res.verifier || '',
                provider: res.provider,
                redirectUri: redirect,
                at: Date.now(),
              }))
            } catch (e) { /* 无痕模式写不进也不影响跳转，回调页会提示重新登录 */ }
            window.location.href = res.url
          })
          .catch(function (e) {
            self.showToast(e.message || self.t('t_start_fail'))
            self.busy = false
          })
      },

      /** 第三方账号首次登录需关联小程序，才能拿到 openid 并读写同一份 todos */
      linkWechat: function () {
        var self = this
        var code = String(this.linkCode || '').trim().toUpperCase()
        if (!code) return
        this.busy = true
        this.api('linkWechat', { token: this.token, code: code })
          .then(function () {
            self.linkCode = ''
            self.showToast(self.t('t_linked'))
            return self.loadAccount().then(function () { return self.refresh(true) })
          })
          .catch(function (e) { self.showToast(e.message || self.t('t_link_fail')) })
          .then(function () { self.busy = false })
      },

      providerMark: function (id) {
        return { github: 'GH', google: 'G', apple: 'A', x: 'X', wechat: 'W', line: 'L', kakao: 'K', naver: 'N' }[id] || '?'
      },

      providerName: function (id) {
        return { github: 'GitHub', google: 'Google', apple: 'Apple', x: 'X', wechat: 'WeChat', line: 'LINE', kakao: 'Kakao', naver: 'Naver', code: translate(this.lang, 'provider_code') }[id] || id
      },

      unbind: function () {
        this.doUnbindLocal()
        this.showToast(this.t('t_exit'))
      },

      refresh: function (silent) {
        var self = this
        if (this.refreshing) return Promise.resolve()
        this.refreshing = true
        return this.api('listTodos', { token: this.token })
          .then(function (res) {
            self.todos = res.todos || []
            self.lastSyncText = new Date().toLocaleTimeString(self.locale(), { hour12: false })
            if (!silent) self.showToast(self.t('t_synced', { n: self.todos.length }))
          })
          .catch(function (e) {
            if (e.code === 'NEED_LINK') {
              self.account = {
                linked: false, needsLink: true,
                provider: (self.account && self.account.provider) || 'oauth',
              }
              if (!silent) self.showToast(self.t('t_need_link'))
              return
            }
            if (!silent) self.showToast(e.message || self.t('t_sync_fail'))
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
        if (!iso) { this.showToast(this.t('t_bad_time')); return }
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
          self.showToast(isNew ? self.t('t_created') : self.t('t_saved'))
          return self.refresh(true)
        })
          .catch(function (e) { self.showToast(e.message || self.t('t_save_fail')) })
          .then(function () { self.busy = false })
      },

      done: function (t) {
        var self = this
        this.api('updateTodo', {
          token: this.token, id: t.id,
          patch: { status: 'done', done_at: new Date().toISOString() },
        })
          .then(function () { self.showToast(self.t('t_done')); return self.refresh(true) })
          .catch(function (e) { self.showToast(e.message || self.t('t_op_fail')) })
      },

      remove: function (t) {
        var self = this
        if (!window.confirm(this.t('t_confirm', { title: t.title || this.t('t_no_title_val') }))) return
        this.api('removeTodo', { token: this.token, id: t.id })
          .then(function () { self.showToast(self.t('t_deleted')); return self.refresh(true) })
          .catch(function (e) { self.showToast(e.message || self.t('t_del_fail')) })
      },

      nextText: function (t) {
        try {
          var n = core.nextOccurrence(t, Date.now(), this.holidayMap)
          return n ? n.atText : this.t('t_no_next')
        } catch (e) { return '' }
      },

      repeatText: function (t) {
        var ty = t.repeat_type || 'none'
        var keys = {
          none: 'rep_none', daily: 'rep_daily', weekly: 'rep_weekly', monthly: 'rep_monthly',
          yearly: 'rep_yearly', workday: 'rep_workday', restday: 'rep_restday',
          hourly: 'rep_hourly', minutely: 'rep_minutely', dates: 'rep_dates',
        }
        if (!keys[ty]) return this.t('rep_none')
        var n = Math.max(1, Number(t.repeat_interval) || 1)
        var units = {
          daily: 'unit_day', weekly: 'unit_week', monthly: 'unit_month',
          yearly: 'unit_year', hourly: 'unit_hour', minutely: 'unit_minute',
        }
        if (n > 1 && units[ty]) return this.t('rep_every', { n: n, unit: this.t(units[ty]) })
        return this.t(keys[ty])
      },

      priorityText: function (p) {
        return { high: this.t('prio_high'), medium: this.t('prio_medium'), low: this.t('prio_low') }[p] || this.t('prio_medium')
      },

      fmtTime: function (v) {
        var d = new Date(v)
        return isNaN(d.getTime()) ? '' : d.toLocaleString(this.locale(), { hour12: false })
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
            try { new Notification(this.t('app_name') + ' · ' + (t.title || this.t('notify_remind')), { body: t.note || this.t('t_notif_body') }) } catch (e) {}
          }
        }
      },
    },
  })

  // 模板里的 $t(key, vars)：this 是组件代理，能读到响应式的 lang，切语言自动重渲染
  app.config.globalProperties.$t = function (key, vars) {
    return translate(this.lang || currentLang, key, vars)
  }

  app.mount('#app')

  // 首次交互时申请通知权限（不能一进页面就弹，浏览器会拦）
  document.addEventListener('click', function requestOnce() {
    document.removeEventListener('click', requestOnce)
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { Notification.requestPermission() } catch (e) {}
    }
  })
})()
