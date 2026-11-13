const store = require('../../utils/store')
const reminders = require('../../utils/reminders')
const core = require('../../utils/reminder-core')
const subscribe = require('../../utils/subscribe')
const navGuard = require('../../utils/nav-guard')
const { onShareAppMessage, onShareTimeline } = require('../../utils/share')

const app = getApp()

const PRIORITY_FILTERS = [
  { key: 'all', name: '全部' },
  { key: 'high', name: '高' },
  { key: 'medium', name: '中' },
  { key: 'low', name: '低' },
]

/** 用来排序/筛选的时间戳：优先用下一次提醒时刻，没有则用首次提醒时刻 */
function stampOf(item) {
  if (item.nextAt) return item.nextAt
  if (item.remind_at) {
    const t = new Date(item.remind_at).getTime()
    return isNaN(t) ? 0 : t
  }
  return 0
}

function hhmmOf(ms) {
  const d = new Date(ms)
  return core.pad2(d.getHours()) + ':' + core.pad2(d.getMinutes())
}

/** 时间升序，无有效时刻的排在最后 */
function cmpTime(a, b) {
  const ta = stampOf(a)
  const tb = stampOf(b)
  if (!ta) return 1
  if (!tb) return -1
  return ta - tb
}

/** 批量勾选集合里真正选中的 id（统一成字符串，云端 _id 都是字符串） */
function selectedIds(sel) {
  return Object.keys(sel || {}).filter((id) => !!sel[id])
}

Page({
  // 页面内任意点击（含冒泡）都顺手补 1 次订阅额度；与子节点显式 renew 由节流去重
  onAnyTap: subscribe.onAnyTap,
  // 必须直接挂在页面对象上，走 Behavior 真机上「转发给朋友」会是灰的
  onShareAppMessage: onShareAppMessage,
  onShareTimeline: onShareTimeline,
  data: {
    signedIn: false,
    loading: false,
    loginText: '微信一键登录',
    loginError: '',
    activeList: [],
    freshList: [],
    freshCount: 0,
    // 提醒已发完但还没手工确认完成的数量
    pendingDoneCount: 0,
    // 批量确认完成
    batchMode: false,
    selectedCount: 0,
    batchBusy: false,
    todayMark: '—',
    // 排序：priority=按优先级，time=按提醒时间
    sortMode: 'priority',
    // 筛选
    priorityFilters: PRIORITY_FILTERS,
    filterPriority: 'all',
    dateFrom: '',
    dateTo: '',
    timeFrom: '',
    timeTo: '',
    showFilter: false,
    filterText: '',
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 })
    }
    // 新建保存时自动写系统日历的结果（回调可能晚于返回首页，延迟再查一次）
    this.consumeCalendarNotice()
    setTimeout(() => this.consumeCalendarNotice(), 1600)
    // 刚加载过且数据没变动时不再重跑一轮同步，切 tab 立刻可见
    const freshEnough =
      !this._dirty &&
      !app.globalData.todosDirty &&
      this._loadedAt &&
      Date.now() - this._loadedAt < 10000
    if (freshEnough) {
      this.updateTodayMark()
      return
    }
    this._dirty = false
    app.globalData.todosDirty = false
    this.bootstrap()
  },

  /**
   * 消费「新建保存时自动写入手机日历」的结果，只提示一次。
   * 日历 API 的回调可能比 navigateBack 晚，所以编辑页写了 globalData + storage 双份，
   * 这里读完就清，避免下次进首页重复弹。用 toast 而不是 modal，免得打断列表加载。
   */
  consumeCalendarNotice() {
    let text = app.globalData.calendarNotice || ''
    if (!text) {
      try {
        text = wx.getStorageSync('kiwi_calendar_notice') || ''
      } catch (e) { /* 存储不可用就只认 globalData */ }
    }
    if (!text) return
    app.globalData.calendarNotice = ''
    try {
      wx.removeStorageSync('kiwi_calendar_notice')
    } catch (e) { /* 清不掉也只是下次再提示一次 */ }
    wx.showToast({ title: text, icon: 'none', duration: 2600 })
  },

  onPullDownRefresh() {
    this.bootstrap().then(() => {
      wx.stopPullDownRefresh()
    })
  },

  async bootstrap() {
    if (this._running) {
      this._pending = true
      return
    }
    this._running = true
    this.setData({ loading: true })
    try {
      const { session, error } = await store.getSession()
      if (error || !session) {
        this.setData({
          signedIn: false,
          loading: false,
          activeList: [],
          freshList: [],
          freshCount: 0,
        })
        return
      }
      this.setData({ signedIn: true, loginError: '' })
      await this.ensureHolidays()
      await this.refreshTodos()
    } catch (e) {
      wx.showToast({ title: '加载失败，请下拉重试', icon: 'none' })
    } finally {
      this._running = false
      this.setData({ loading: false })
      this._loadedAt = Date.now()
      // 加载期间又有一次请求进来（例如编辑页返回），补跑一次
      if (this._pending) {
        this._pending = false
        this.bootstrap()
      }
    }
  },

  async ensureHolidays() {
    if (app.globalData.holidaysLoaded && Object.keys(app.globalData.holidayMap).length > 0) {
      this.updateTodayMark()
      return
    }
    // 先吃本地缓存，让首屏立刻出来，随后在后台回源
    const cached = store.readHolidayCache()
    if (cached && cached.rows && cached.rows.length) {
      // 老缓存可能残留已结束年份，且云端可能为空：统一走内置种子合并兜底
      app.setHolidayMap(core.buildHolidayMap(store.mergeActiveHolidays(cached.rows)))
      this.updateTodayMark()
      this.refreshHolidaysInBackground(cached.at)
      return
    }
    await this.loadHolidays()
  },

  async refreshHolidaysInBackground(at) {
    // 12 小时内不重复回源
    if (at && Date.now() - at < 12 * 60 * 60 * 1000) return
    try {
      await this.loadHolidays(true)
    } catch (e) { /* 后台刷新失败不影响使用 */ }
  },

  async loadHolidays(silent) {
    // 自动清理已结束年份（一次启动只试一次，fire-and-forget，不阻塞首屏）
    store.pruneOldHolidays().catch(() => {})
    // App 启动不自动登录，而回灌写入要求 openid；已有身份时这里是同步返回
    await store.ensureOpenid().catch(() => {})
    const res = await store.listHolidays()
    const dbRows = store.filterActiveHolidays(res.data || [])
    if (res.error) {
      if (!silent) wx.showToast({ title: '节假日表加载失败', icon: 'none' })
      // 读库失败也用内置表兜底，保证顺延计算不因空表而失准
      if (!app.globalData.holidaysLoaded) {
        app.setHolidayMap(core.buildHolidayMap(store.mergeActiveHolidays([])))
      }
      this.updateTodayMark()
      return
    }
    // 云端缺哪些内置日期就补写哪些（内部会跳过用户删掉的日期）
    const known = dbRows.map((row) => String(row.day).slice(0, 10))
    const seeded = await store.seedHolidays(known)
    let merged = store.mergeActiveHolidays(res.data || [])
    if (seeded.inserted > 0) {
      const again = await store.listHolidays()
      merged = store.mergeActiveHolidays(again.data || [])
      store.writeHolidayCache(merged)
    }
    app.setHolidayMap(core.buildHolidayMap(merged))
    this.updateTodayMark()
  },

  updateTodayMark() {
    const today = new Date()
    const key = core.dateKey(today)
    const kind = app.globalData.holidayMap[key]
    let mark = '工作日'
    if (kind === 'holiday') mark = '法定节假日'
    else if (kind === 'workday') mark = '调休补班'
    else if (today.getDay() === 0 || today.getDay() === 6) mark = '周末'
    this.setData({ todayMark: mark })
  },

  async refreshTodos() {
    const res = await store.listTodos()
    if (res.error) {
      wx.showToast({ title: '待办加载失败', icon: 'none' })
      return
    }
    const todos = res.data || []
    const activeRaw = todos.filter((t) => t.status === 'active')

    const sync = await reminders.syncDueReminders(activeRaw, app.globalData.holidayMap)
    if (sync.error) {
      console.error('[index] 提醒同步失败：', sync.error)
      wx.showToast({ title: '提醒同步失败，可下拉重试', icon: 'none' })
    }

    const fresh = (sync.fresh || []).map((row, i) => ({
      key: 'f' + i + '_' + row.todo_id,
      title: row.todo_title,
      atText: core.minuteKey(new Date(row.scheduled_at)),
      status: row.status,
      reasonText: row.status === 'skipped' ? (row.remark || '节假日跳过') : (row.remark || '已到提醒时间'),
    }))
    this.setData({ freshList: fresh, freshCount: fresh.length })

    // 同步写回了 last_logged_at / next_remind_at，直接合进内存，省掉一次全量拉取
    const patchMap = {}
    ;(sync.updated || []).forEach((u) => {
      patchMap[u.id] = u.patch
    })
    const decorated = todos.map((t) => {
      const merged = patchMap[t.id] ? Object.assign({}, t, patchMap[t.id]) : t
      return reminders.decorate(merged, app.globalData.holidayMap)
    })

    // 完成方式按每条待办的 manual_done 走（新增页开关，默认关闭）：
    // 默认到点自动完成并归档；只有勾了「需要手工确认完成」的才留下来催确认。
    // status === 'done'（手工点过）无论哪种模式都算完成。
    const activeDecorated = decorated.filter((item) => !item.finished)
    this._activeRaw = activeDecorated
    this.applyView()
  },

  /** 按当前排序与筛选条件重新计算展示列表 */
  applyView() {
    const activeRaw = this._activeRaw || []
    const activeFiltered = activeRaw.filter((item) => this.matchFilter(item))

    const sortMode = this.data.sortMode
    const byPriority = (a, b) => {
      const diff = core.priorityRank(b.priority) - core.priorityRank(a.priority)
      if (diff !== 0) return diff
      return cmpTime(a, b)
    }
    const byTime = (a, b) => cmpTime(a, b)
    const mainSort = sortMode === 'priority' ? byPriority : byTime
    // 提醒已经发完却还没确认做完的排最前面：这些最容易被漏掉
    const pendingFirst = (a, b) => {
      const diff = (b.needDone ? 1 : 0) - (a.needDone ? 1 : 0)
      return diff !== 0 ? diff : mainSort(a, b)
    }

    // 批量模式下给每条挂上勾选态。勾选集合存在页面实例上（_selected），
    // 不进 data，避免每次筛选/排序都要同步两份状态。
    const selected = this._selected || {}
    const list = activeFiltered.slice().sort(pendingFirst).map((item) => {
      if (!this.data.batchMode) return item
      return Object.assign({}, item, { _checked: !!selected[String(item.id)] })
    })
    this.setData({
      activeList: list,
      pendingDoneCount: activeRaw.filter((item) => item.needDone).length,
      selectedCount: this.data.batchMode ? selectedIds(selected).length : 0,
    })
    this.updateFilterText(activeFiltered.length, activeRaw.length)
  },

  matchFilter(item) {
    if (this.data.filterPriority !== 'all' && item.priority !== this.data.filterPriority) return false
    const ms = stampOf(item)
    if (this.data.dateFrom || this.data.dateTo) {
      const day = ms ? core.dateKey(new Date(ms)) : ''
      if (!day) return false
      if (this.data.dateFrom && day < this.data.dateFrom) return false
      if (this.data.dateTo && day > this.data.dateTo) return false
    }
    if (this.data.timeFrom || this.data.timeTo) {
      if (!ms) return false
      const t = hhmmOf(ms)
      const from = this.data.timeFrom
      const to = this.data.timeTo
      if (from && to) {
        const inRange = from <= to ? t >= from && t <= to : t >= from || t <= to
        if (!inRange) return false
      } else if (from && t < from) {
        return false
      } else if (to && t > to) {
        return false
      }
    }
    return true
  },

  updateFilterText(shown, total) {
    let text = ''
    if (this.data.filterPriority !== 'all') {
      const hit = PRIORITY_FILTERS.filter((p) => p.key === this.data.filterPriority)[0]
      text += (hit ? hit.name : '') + '优先级 · '
    }
    if (this.data.dateFrom || this.data.dateTo) {
      text += (this.data.dateFrom || '不限') + '~' + (this.data.dateTo || '不限') + ' · '
    }
    if (this.data.timeFrom || this.data.timeTo) {
      text += (this.data.timeFrom || '不限') + '~' + (this.data.timeTo || '不限') + ' · '
    }
    this.setData({ filterText: text ? text.replace(/ · $/, '') + '（' + shown + '/' + total + '）' : '' })
  },

  onToggleFilter() {
    this.setData({ showFilter: !this.data.showFilter })
  },

  onSort(e) {
    this.setData({ sortMode: e.currentTarget.dataset.mode })
    this.applyView()
  },

  onPriorityFilter(e) {
    this.setData({ filterPriority: e.currentTarget.dataset.value })
    this.applyView()
  },

  onDateFrom(e) {
    this.setData({ dateFrom: e.detail.value })
    this.applyView()
  },

  onDateTo(e) {
    this.setData({ dateTo: e.detail.value })
    this.applyView()
  },

  onTimeFrom(e) {
    this.setData({ timeFrom: e.detail.value })
    this.applyView()
  },

  onTimeTo(e) {
    this.setData({ timeTo: e.detail.value })
    this.applyView()
  },

  onClearFilter() {
    this.setData({
      filterPriority: 'all',
      dateFrom: '',
      dateTo: '',
      timeFrom: '',
      timeTo: '',
    })
    this.applyView()
  },

  /** 点一条已到期的提醒：顺手补 1 次订阅额度（子节点直接 handler，手势链最可靠） */
  onFreshItem() {
    subscribe.renewWithToast()
  },

  dismissBanner() {
    // 看到提醒时顺手补一次下发额度：每条微信提醒消耗 1 次授权，
    // 必须在 tap 同步链里调，放在任何 await 之前
    subscribe.renew()
    this.setData({ freshList: [], freshCount: 0 })
  },

  async onLogin() {
    this.setData({ loginText: '登录中…', loginError: '' })
    const { session, error } = await store.wechatLogin()
    if (error || !session) {
      this.setData({
        loginText: '微信一键登录',
        loginError: (error && error.message) || '登录失败，请重试',
      })
      return
    }
    this.setData({ loginText: '微信一键登录', signedIn: true })
    await this.ensureHolidays()
    await this.refreshTodos()
  },

  goNew() {
    // 连点会开出多个新建页实例，每个实例各存一次 = 多条重复待办
    if (!navGuard.guard('/pages/edit/edit')) return
    // 必须在跳转前同步发起，保住用户点击链
    subscribe.renew()
    wx.navigateTo({ url: '/pages/edit/edit' })
  },

  /* ── 批量确认完成 ─────────────────────────────────────────────────────── */

  /** 进入批量模式：默认全选当前可见的待办（看到什么就勾什么） */
  openBatch() {
    subscribe.renew()
    const visible = this.data.activeList || []
    if (!visible.length) {
      wx.showToast({ title: '当前没有可勾选的待办', icon: 'none' })
      return
    }
    this._selected = Object.create(null)
    visible.forEach((item) => { this._selected[String(item.id)] = true })
    this.setData({ batchMode: true, batchBusy: false })
    this.applyView()
  },

  closeBatch() {
    this._selected = Object.create(null)
    this.setData({ batchMode: false, batchBusy: false, selectedCount: 0 })
    this.applyView()
  },

  /** 全选 / 仅待确认 / 清空 */
  onBatchSelect(e) {
    const mode = e.currentTarget.dataset.mode
    const visible = this.data.activeList || []
    this._selected = Object.create(null)
    if (mode === 'all') {
      visible.forEach((item) => { this._selected[String(item.id)] = true })
    } else if (mode === 'pending') {
      visible.filter((item) => item.needDone).forEach((item) => {
        this._selected[String(item.id)] = true
      })
    }
    this.applyView()
  },

  /** 卡片点击：批量模式下切换勾选，平时才跳编辑页 */
  onCardTap(e) {
    if (!this.data.batchMode) return this.goEdit(e)
    const id = String(e.currentTarget.dataset.id || '')
    if (!id) return
    const sel = this._selected || (this._selected = Object.create(null))
    if (sel[id]) delete sel[id]
    else sel[id] = true
    this.applyView()
  },

  onBatchConfirm() {
    if (this.data.batchBusy || this._doneBusy || this._deleteBusy || this._confirmPending) return
    const ids = selectedIds(this._selected)
    if (!ids.length) {
      wx.showToast({ title: '请先勾选待办', icon: 'none' })
      return
    }
    // 必须在 showModal 之前的同步点击链里补额度，异步回调里发起会丢用户手势
    subscribe.renew()
    const visible = this.data.activeList || []
    const pending = visible.filter(
      (item) => item.needDone && ids.indexOf(String(item.id)) !== -1
    ).length
    const rest = ids.length - pending
    const extra = rest > 0
      ? '\n其中 ' + rest + ' 条还有后续提醒，确认后也会一并停止提醒。'
      : ''
    const self = this
    // 弹窗停留期间别让连点再开第二个 showModal
    this._confirmPending = true
    wx.showModal({
      title: '批量确认完成',
      content: '将把选中的 ' + ids.length + ' 条待办标记为已完成，并移到「提醒记录」。' + extra,
      confirmText: '确认完成',
      cancelText: '再想想',
      success(res) {
        self._confirmPending = false
        if (res.confirm) self.batchDone(ids)
      },
      fail() { self._confirmPending = false },
    })
  },

  async batchDone(ids) {
    this._doneBusy = true
    this.setData({ batchBusy: true })
    wx.showLoading({ title: '正在确认…', mask: true })
    const patch = { status: 'done', done_at: new Date().toISOString() }
    try {
      const res = await store.batchUpdateTodos(
        ids.map((id) => ({ id: id, patch: patch }))
      )
      const updated = res && typeof res.updated === 'number' ? res.updated : ids.length
      const failed = Math.max(0, ids.length - updated)
      this._selected = Object.create(null)
      // 显式清零，不等回源重算：refreshTodos 万一失败提前 return，
      // 操作条上还挂着旧的「已选 N 条」会让人以为没提交成功
      this.setData({ batchMode: false, batchBusy: false, selectedCount: 0 })
      app.globalData.todosDirty = true
      // 回源拉真实结果：部分写失败的那几条会重新出现在列表里
      await this.refreshTodos()
      wx.hideLoading()
      setTimeout(() => {
        wx.showToast({
          title: failed > 0
            ? ('已完成 ' + updated + ' 条，' + failed + ' 条失败请重试')
            : ('已完成 ' + updated + ' 条'),
          icon: 'none',
          duration: 2200,
        })
      }, 320)
    } catch (e) {
      wx.hideLoading()
      this.setData({ batchBusy: false })
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    } finally {
      this._doneBusy = false
    }
  },

  /* ── 批量删除 ─────────────────────────────────────────────────────────── */

  /**
   * 批量模式默认全选，删除又是不可恢复的破坏性操作：必须二次确认，
   * 且把「不可恢复 / 历史记录保留」写清楚。补额度要在 showModal 之前的同步点击链里。
   */
  onBatchDelete() {
    if (this.data.batchBusy || this._doneBusy || this._deleteBusy || this._confirmPending) return
    const ids = selectedIds(this._selected)
    if (!ids.length) {
      wx.showToast({ title: '请先勾选待办', icon: 'none' })
      return
    }
    subscribe.renew()
    const visible = this.data.activeList || []
    const shared = visible.filter(
      (item) => item.shared && ids.indexOf(String(item.id)) !== -1
    ).length
    const extra = shared > 0
      ? '\n其中 ' + shared + ' 条是协作待办，删除只影响你自己的列表。'
      : ''
    const self = this
    this._confirmPending = true
    wx.showModal({
      title: '批量删除',
      content: '确定删除选中的 ' + ids.length + ' 条待办？删除后不可恢复，历史提醒记录会保留。' + extra,
      confirmText: '确认删除',
      confirmColor: '#d70015',
      cancelText: '再想想',
      success(res) {
        self._confirmPending = false
        if (res.confirm) self.batchDelete(ids)
      },
      fail() { self._confirmPending = false },
    })
  },

  async batchDelete(ids) {
    this._deleteBusy = true
    this.setData({ batchBusy: true })
    wx.showLoading({ title: '正在删除…', mask: true })
    try {
      const res = await store.batchDeleteTodos(ids)
      const removed = res && typeof res.removed === 'number' ? res.removed : ids.length
      const failed = Math.max(0, ids.length - removed)
      this._selected = Object.create(null)
      this.setData({ batchMode: false, batchBusy: false, selectedCount: 0 })
      app.globalData.todosDirty = true
      // 回源拉真实结果：删失败的那几条会重新出现在列表里，不会凭空消失
      await this.refreshTodos()
      wx.hideLoading()
      setTimeout(() => {
        wx.showToast({
          title: failed > 0
            ? ('已删除 ' + removed + ' 条，' + failed + ' 条失败请重试')
            : ('已删除 ' + removed + ' 条'),
          icon: 'none',
          duration: 2200,
        })
      }, 320)
    } catch (e) {
      wx.hideLoading()
      this.setData({ batchBusy: false })
      wx.showToast({ title: '删除失败，请重试', icon: 'none' })
    } finally {
      this._deleteBusy = false
    }
  },

  goEdit(e) {
    const id = e.currentTarget.dataset.id
    const url = '/pages/edit/edit?id=' + id
    if (!navGuard.guard(url)) return
    subscribe.renew()
    wx.navigateTo({ url: url })
  },

  onLongPress(e) {
    // 批量模式下长按菜单（编辑/完成/删除）会和勾选冲突，直接不弹
    if (this.data.batchMode) return
    // 长按也是用户手势：菜单弹出前同步补一次下发额度
    subscribe.renew()
    const id = e.currentTarget.dataset.id
    const title = e.currentTarget.dataset.title || '该待办'
    const self = this
    wx.showActionSheet({
      itemList: ['编辑', '标记为已完成', '删除'],
      success(res) {
        if (res.tapIndex === 0) {
          wx.navigateTo({ url: '/pages/edit/edit?id=' + id })
        } else if (res.tapIndex === 1) {
          self.onDoneTap({ currentTarget: { dataset: { id: id, title: title } } })
        } else if (res.tapIndex === 2) {
          self.onDeleteTap({ currentTarget: { dataset: { id: id, title: title } } })
        }
      },
      fail() {},
    })
  },

  /**
   * 唯一的「确认完成」入口：卡片按钮（catchtap）和长按菜单都走这里。
   * 到点绝不会自动调用它 —— 完成这件事只能由人点一下。
   * catchtap 会连根节点的 onAnyTap 一起截断，所以补订阅额度要在这里自己做，
   * 且必须在 showModal（异步回调）之前的同步点击链里发起。
   */
  onDoneTap(e) {
    const dataset = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const id = dataset.id
    const title = dataset.title || '这条待办'
    if (!id || this._doneBusy) return
    subscribe.renew()
    this._doneBusy = true
    const self = this
    wx.showModal({
      title: '确认完成',
      content: '「' + title + '」已经做完了吗？确认后会停止提醒，并移到「提醒记录」。',
      confirmText: '已完成',
      cancelText: '还没',
      success(res) {
        if (res.confirm) self.markDone(id)
        else self._doneBusy = false
      },
      fail() { self._doneBusy = false },
    })
  },

  async markDone(id) {
    const { data, error } = await store.updateTodo(id, {
      status: 'done',
      done_at: new Date().toISOString(),
    })
    this._doneBusy = false
    if (error) {
      wx.showToast({ title: '操作失败', icon: 'none' })
      return
    }
    if (!data || data.length === 0) {
      wx.showToast({ title: '没有权限修改这条待办', icon: 'none' })
      return
    }
    // 先本地移除，点击立刻有反馈，不等下一轮云端拉取
    this._activeRaw = (this._activeRaw || []).filter(
      (item) => String(item.id) !== String(id)
    )
    this.applyView()
    app.globalData.todosDirty = true
    this.refreshTodos()
    // showModal 刚关闭时直接 showToast 会被吞掉，稍等一下再给反馈
    setTimeout(() => {
      wx.showToast({ title: '已标记完成', icon: 'success' })
    }, 320)
  },

  /**
   * 唯一的「删除」确认入口：卡片上的删除按钮（catchtap）和长按菜单都走这里。
   * catchtap 会连根节点的 onAnyTap 一起截断，所以补额度必须自己同步做，
   * 且要在 showModal 之前；删除不可恢复，一律二次确认。
   */
  onDeleteTap(e) {
    if (this.data.batchBusy || this._deleteBusy || this._confirmPending) return
    const dataset = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const id = dataset.id
    const title = dataset.title || '这条待办'
    if (!id) return
    subscribe.renew()
    const self = this
    this._confirmPending = true
    wx.showModal({
      title: '删除待办',
      content: '确定删除「' + title + '」？删除后不可恢复，历史提醒记录会保留。',
      confirmText: '删除',
      confirmColor: '#d70015',
      cancelText: '再想想',
      success(res) {
        self._confirmPending = false
        if (res.confirm) self.removeTodo(id)
      },
      fail() { self._confirmPending = false },
    })
  },

  /** 真正写库：只删一条；成功后先本地移除，再回源拉真实结果 */
  async removeTodo(id) {
    this._deleteBusy = true
    try {
      const { data, error } = await store.removeTodo(id)
      if (error) {
        wx.showToast({ title: '删除失败', icon: 'none' })
        return
      }
      if (!data || data.length === 0) {
        wx.showToast({ title: '没有权限删除这条待办', icon: 'none' })
        return
      }
      this._activeRaw = (this._activeRaw || []).filter(
        (item) => String(item.id) !== String(id)
      )
      this.applyView()
      app.globalData.todosDirty = true
      this.refreshTodos()
      setTimeout(() => {
        wx.showToast({ title: '已删除', icon: 'success' })
      }, 320)
    } catch (e) {
      wx.showToast({ title: '删除失败，请重试', icon: 'none' })
    } finally {
      this._deleteBusy = false
    }
  },
})
