const store = require('../../utils/store')
const core = require('../../utils/reminder-core')
const subscribe = require('../../utils/subscribe')
const collab = require('../../utils/collab')
const attachments = require('../../utils/attachments')
const calendar = require('../../utils/calendar')
const saveGuard = require('../../utils/save-guard')
const { SHARE_TITLE, SHARE_PATH } = require('../../utils/share')
const i18n = require('../../utils/i18n')
const fmt = require('../../utils/i18n-format')

const app = getApp()
const t = (key, vars) => i18n.t(key, vars)

const REPEAT_KEYS = ['none', 'daily', 'hourly', 'minutely', 'weekly', 'monthly', 'yearly', 'workday', 'restday', 'dates']
const REPEAT_NAMES = fmt.repeatNames()
const ACTION_KEYS = ['skip', 'postpone']
const ACTION_NAMES = fmt.actionNames()
const PRIORITY_KEYS = ['high', 'medium', 'low']
const PRIORITY_NAMES = fmt.priorityNames()

/** 需要填写间隔的重复方式 */
const WITH_INTERVAL = ['daily', 'hourly', 'minutely', 'weekly', 'monthly', 'yearly']

/** 间隔输入框的标签：每隔几(天/小时/分钟/周/个月/年) */
function intervalLabelOf(type) {
  return t('ed_interval_label', { unit: fmt.intervalUnit(type) })
}

/** 间隔上限：按天最大 999，其余（小时/分钟/周/月/年）仍是 99 */
function intervalMaxOf(type) {
  return type === 'daily' ? 999 : 99
}

/** 间隔输入框的区间提示文字 */
function intervalRangeOf(type) {
  return '1-' + intervalMaxOf(type)
}

/** 自动写日历的结果提示：回调可能晚于返回首页，用 storage 兜底，由首页 onShow 消费 */
const CALENDAR_NOTICE_KEY = 'kiwi_calendar_notice'

function setCalendarNotice(text) {
  app.globalData.calendarNotice = text
  try {
    wx.setStorageSync(CALENDAR_NOTICE_KEY, text)
  } catch (e) { /* 存储不可用时还有 globalData */ }
}

/* ── 自定义滚轮选择器数据源（替代原生 picker：原生滚轮字号系统固定不可调） ── */
const CP_YEAR_START = 2000
const CP_YEAR_END = 2035
/** 滚轮列（年/月/日/时/分后缀）按当前语言重建，全部走字典 */
function cpItems() {
  const years = []
  const months = []
  const hours = []
  const minutes = []
  for (let y = CP_YEAR_START; y <= CP_YEAR_END; y++) years.push(t('ed_cp_year', { n: y }))
  for (let m = 1; m <= 12; m++) months.push(t('ed_cp_month', { n: m }))
  for (let h = 0; h < 24; h++) hours.push(t('ed_cp_hour', { n: core.pad2(h) }))
  for (let mi = 0; mi < 60; mi++) minutes.push(t('ed_cp_minute', { n: core.pad2(mi) }))
  return { years: years, months: months, hours: hours, minutes: minutes }
}

/** 走「年/月/日」三列滚轮的选择类型 */
function isDateCp(type) {
  return type === 'date' || type === 'rangeStart' || type === 'rangeEnd'
}

/* ── 「按日历选择」的月历多选面板 ─────────────────────────────────────── */
const WEEK_HEAD = fmt.weekHead()
const CAL_PAGE = 6 // 每次加载几个月
const CAL_MAX = 36 // 最多向前 3 年，避免无意义地堆 DOM

/** 'YYYY-MM' 加上 delta 个月 */
function ymAdd(ym, delta) {
  const p = String(ym).split('-')
  let y = Number(p[0])
  let m = Number(p[1]) + delta
  y += Math.floor((m - 1) / 12)
  m = (((m - 1) % 12) + 12) % 12 + 1
  return y + '-' + core.pad2(m)
}

/** 某年某月的「日」列（按实际天数生成，处理 2 月大小月） */
function cpDaysOfMonth(year, month) {
  const total = new Date(year, month, 0).getDate()
  const out = []
  for (let d = 1; d <= total; d++) out.push(t('ed_cp_day', { n: d }))
  return out
}

function defaultDateTime() {
  const d = new Date(Date.now() + 60 * 60 * 1000)
  d.setSeconds(0, 0)
  return d
}

function parseLocal(dateStr, timeStr) {
  const dp = String(dateStr || '').split('-')
  const tp = String(timeStr || '00:00').split(':')
  return new Date(
    Number(dp[0]),
    Number(dp[1]) - 1,
    Number(dp[2]),
    Number(tp[0]) || 0,
    Number(tp[1]) || 0,
    0,
    0
  )
}

Page({
  onAnyTap: subscribe.onAnyTap,
  data: {
    id: 0,
    isEdit: false,
    // 附件备注：图片存云存储 fileID 列表，位置存 { name, address, latitude, longitude }
    images: [],
    maxImages: attachments.MAX_IMAGES,
    location: null,
    // 协作提醒：isShared=true 表示这条是别人邀请、落在自己名下的副本（只读）
    isShared: false,
    inviteId: '',
    memberCount: 0,
    // 打开页面时原件的提醒时间，用于判断是否改动了提醒时间（改了要重置提醒游标）
    originRemindAt: '',
    title: '',
    note: '',
    dateStr: '',
    timeStr: '',
    weekdayText: '',
    repeatNames: REPEAT_NAMES,
    repeatIndex: 0,
    showInterval: false,
    intervalText: '1',
    intervalLabel: '',
    intervalRange: '1-999',
    intervalMax: 999,
    // 重复的生效日期范围：rangeEnabled=false 表示不限；单端为空表示该端不限
    showRange: false,
    rangeEnabled: false,
    rangeStart: '',
    rangeEnd: '',
    rangeHint: '',
    // 「按日历选择」：repeatDates 是升序的 'YYYY-MM-DD' 清单
    showDates: false,
    repeatDates: [],
    calVisible: false,
    weekHead: WEEK_HEAD,
    calMonths: [],
    calLoaded: 0,
    calStartYm: '',
    calCanMore: true,
    priorityNames: PRIORITY_NAMES,
    priorityIndex: 1,
    skipHoliday: true,
    showHoliday: true,
    actionNames: ACTION_NAMES,
    actionIndex: 0,
    previewFirst: '',
    previewNext: '',
    previewTip: '',
    saveText: '',
    // 完成方式：默认 false = 提醒发完自动完成；用户勾了才必须手工点「确认做完了」
    manualDone: false,
    // 新建保存时自动写入手机系统日历（默认开）；编辑不自动写，避免重复日历事件
    autoCalendar: true,
    // 当前规则能否写入系统日历，以及给用户的说明（supportInfo 纯函数实时算）
    calendarSupported: true,
    calendarHint: '',
    // 保存中：锁住按钮，写库未返回前不允许再次提交（连点会插出多条重复待办）
    saving: false,
    cpVisible: false,
    cpType: '',
    cpTitle: '',
    cpColumns: [],
    cpValue: [],
    cpYears: [],
    cpMonths: [],
    cpHours: [],
    cpMinutes: [],
    holidaySkipText: '',
  },

  /** 语言变化时统一重建：字典、派生文案、滚轮列、导航标题、地区节假日标签 */
  applyLang() {
    i18n.applyPage(this)
    const cp = cpItems()
    this.setData({
      repeatNames: fmt.repeatNames(),
      actionNames: fmt.actionNames(),
      priorityNames: fmt.priorityNames(),
      weekHead: fmt.weekHead(),
      cpYears: cp.years,
      cpMonths: cp.months,
      cpHours: cp.hours,
      cpMinutes: cp.minutes,
      saveText: this.data.isEdit ? t('ed_save_edit') : t('save'),
      intervalLabel: intervalLabelOf(REPEAT_KEYS[this.data.repeatIndex] || 'none'),
      holidaySkipText: t('ed_holiday_skip', { name: i18n.regionName() }),
    })
    wx.setNavigationBarTitle({ title: this.data.isEdit ? t('edit_title_edit') : t('edit_title_new') })
  },

  /** 首次进入 / 语言变化时检测；app.setLang 只通知栈顶页面，onShow 兜底 */
  onShow() {
    const lang = i18n.current()
    const changed = !!this._lastLang && this._lastLang !== lang
    this._lastLang = lang
    if (changed) {
      this.onLangChanged(lang)
    } else {
      this.applyLang()
    }
  },

  onLangChanged(code) {
    this._lastLang = code || i18n.current()
    this.applyLang()
    this.ensureHolidayMap()
    this.updateWeekday()
    this.updatePreview()
  },

  /** 冷启动直达编辑页 / 切语言清缓存后，按当前地区重建 holidayMap；stub 能力不足时直接跳过 */
  ensureHolidayMap() {
    const map = app.globalData.holidayMap
    if (map && Object.keys(map).length) return
    if (typeof store.mergeActiveHolidays !== 'function' || typeof app.setHolidayMap !== 'function') return
    const region = i18n.region()
    const cached = store.readHolidayCache()
    const rows = (region === 'cn' && cached && cached.rows) ? cached.rows : []
    app.setHolidayMap(core.buildHolidayMap(store.mergeActiveHolidays(rows, region)))
  },

  onLoad(options) {
    const d = defaultDateTime()
    const patch = {
      id: 0,
      isEdit: false,
      title: '',
      note: '',
      dateStr: core.dateKey(d),
      timeStr: core.pad2(d.getHours()) + ':' + core.pad2(d.getMinutes()),
      repeatIndex: 0,
      showInterval: false,
      intervalText: '1',
      intervalLabel: '',
      priorityIndex: 1,
      skipHoliday: true,
      actionIndex: 0,
      showRange: false,
      rangeEnabled: false,
      rangeStart: '',
      rangeEnd: '',
      showDates: false,
      repeatDates: [],
      calVisible: false,
      // 完成方式默认关：只有用户勾了「需要手工确认完成」才留下来催确认
      manualDone: false,
      // 新建默认写系统日历；编辑不自动写 —— 微信没有删除日历事件的接口，
      // 每次保存修改都写会越积越多，编辑时交给页面上的手动按钮。
      autoCalendar: !(options && options.id),
      calendarSupported: true,
      calendarHint: '',
    }
    this.setData(patch)
    this.applyLang()
    this.ensureHolidayMap()
    this.updateWeekday()
    this.updatePreview()

    // 新建页实例一个幂等键：同一页连点、超时重试都带它，store 层据此保证只落一条。
    // 编辑页改的是同一条记录（按 id 更新），不需要。
    if (!(options && options.id)) this.saveToken = saveGuard.makeSaveToken()

    if (options && options.id) {
      this.setData({ id: String(options.id), isEdit: true, saveText: t('ed_save_edit') })
      wx.setNavigationBarTitle({ title: t('edit_title_edit') })
      this.loadTodo(String(options.id))
    } else {
      wx.setNavigationBarTitle({ title: t('edit_title_new') })
    }
  },

  /**
   * 分享：已为这条待办生成邀请时，转发出去的是「邀请卡片」——好友点开即可
   * 一键加入、同步获得同规则提醒；否则退回普通分享。
   */
  onShareAppMessage() {
    const inviteId = this.data.inviteId
    if (inviteId) {
      const name = String(this.data.title || '').trim() || t('app_name')
      return {
        title: t('inv_share_invite', { name: name }),
        path: '/pages/invite/invite?invite=' + inviteId,
      }
    }
    return { title: SHARE_TITLE, path: SHARE_PATH }
  },

  async loadTodo(id) {
    const res = await store.listTodos()
    if (res.error) {
      wx.showToast({ title: t('ed_load_fail'), icon: 'none' })
      return
    }
    const todo = (res.data || []).filter((t) => t.id === id)[0]
    if (!todo) {
      wx.showToast({ title: t('ed_todo_missing'), icon: 'none' })
      return
    }
    const first = new Date(todo.remind_at)
    const ri = REPEAT_KEYS.indexOf(todo.repeat_type)
    const ai = ACTION_KEYS.indexOf(todo.holiday_action)
    this.setData({
      title: todo.title || '',
      note: todo.note || '',
      images: Array.isArray(todo.images) ? todo.images : [],
      location: todo.location || null,
      isShared: !!todo.shared,
      inviteId: String(todo.invite_id || ''),
      originRemindAt: String(todo.remind_at || ''),
      dateStr: core.dateKey(first),
      timeStr: core.pad2(first.getHours()) + ':' + core.pad2(first.getMinutes()),
      repeatIndex: ri < 0 ? 0 : ri,
      showInterval: WITH_INTERVAL.indexOf(todo.repeat_type) >= 0,
      showHoliday: REPEAT_KEYS[ri] !== 'restday',
      showRange: REPEAT_KEYS[ri] !== 'none' && todo.repeat_type !== 'dates',
      rangeEnabled: !!(todo.repeat_start || todo.repeat_end),
      rangeStart: String(todo.repeat_start || ''),
      rangeEnd: String(todo.repeat_end || ''),
      showDates: todo.repeat_type === 'dates',
      repeatDates: core.selectedDates(todo),
      intervalText: String(Math.min(intervalMaxOf(todo.repeat_type), Math.max(1, todo.repeat_interval || 1))),
      intervalLabel: intervalLabelOf(todo.repeat_type),
      intervalRange: intervalRangeOf(todo.repeat_type),
      intervalMax: intervalMaxOf(todo.repeat_type),
      priorityIndex: Math.max(0, PRIORITY_KEYS.indexOf(todo.priority || 'medium')),
      skipHoliday: todo.skip_holiday !== false,
      actionIndex: ai < 0 ? 0 : ai,
      // 老数据没有这个字段，按默认「自动完成」处理
      manualDone: todo.manual_done === true,
    })
    this.updateWeekday()
    this.updatePreview()

    // 协作副本没有发起邀请的资格，只有原件需要
    if (!todo.shared) {
      await this.ensureInvite()
      await this.refreshMembers()
    }
  },

  /* ── 协作提醒（多人同时提醒）────────────────────────────────── */

  /** 为原件准备好邀请（幂等：已有则复用） */
  async ensureInvite() {
    if (this.data.isShared) return
    const id = this.data.id
    if (!id || this.data.inviteId) return
    const { data, error } = await collab.create(this.currentTodo(), id)
    if (!error && data && data.inviteId) {
      this.setData({ inviteId: data.inviteId })
    }
  },

  /** 刷新参与人数 */
  async refreshMembers() {
    const inviteId = this.data.inviteId
    if (!inviteId) return
    const { data, error } = await collab.members(inviteId)
    if (!error && data) {
      this.setData({ memberCount: (data.members || []).length })
    }
  },

  /**
   * 去邀请页：看邀请码、看谁加入了；那条路径不依赖转发。
   * inviteId 为空时先补建一次（云函数是旧包/上次保存时网络抖动都可能漏掉），
   * 仍拿不到就给出可执行的提示，而不是静默什么都不做。
   */
  async goInvite() {
    if (!this.data.isEdit) {
      wx.showToast({ title: t('ed_save_first'), icon: 'none' })
      return
    }
    let inviteId = this.data.inviteId
    if (!inviteId) {
      wx.showLoading({ title: t('ed_invite_preparing'), mask: true })
      await this.ensureInvite()
      wx.hideLoading()
      inviteId = this.data.inviteId
    }
    if (!inviteId) {
      wx.showModal({
        title: t('ed_invite_not_ready_title'),
        content: t('ed_invite_not_ready_content'),
        showCancel: false,
      })
      return
    }
    wx.navigateTo({ url: '/pages/invite/invite?invite=' + inviteId + '&from=new' })
  },

  /** 退出协作：删掉自己名下的副本 */
  onLeave() {
    const self = this
    const inviteId = self.data.inviteId
    if (!inviteId) return
    wx.showModal({
      title: t('ed_leave_title'),
      content: t('ed_leave_content'),
      async success(r) {
        if (!r.confirm) return
        const { error } = await collab.leave(inviteId)
        if (error) {
          wx.showToast({ title: error.message || t('ed_leave_fail'), icon: 'none' })
          return
        }
        wx.showToast({ title: t('mp_t_logout'), icon: 'success' })
        app.globalData.todosDirty = true
        setTimeout(() => {
          wx.navigateBack()
        }, 500)
      },
    })
  },

  currentTodo() {
    const repeatType = REPEAT_KEYS[this.data.repeatIndex] || 'none'
    const dates = (this.data.repeatDates || []).slice().sort()
    let dt = parseLocal(this.data.dateStr, this.data.timeStr)
    // 按日历选择：首次提醒落在「第一个还没到的选中日期」上，避免列表里显示一个已经过期的时刻
    if (repeatType === 'dates' && dates.length) {
      const today = core.dateKey(new Date())
      const upcoming = dates.filter((d) => d >= today)
      dt = parseLocal(upcoming.length ? upcoming[0] : dates[0], this.data.timeStr)
    }
    let interval = parseInt(this.data.intervalText, 10)
    if (isNaN(interval) || interval < 1) interval = 1
    const max = Number(this.data.intervalMax) || 99
    if (interval > max) interval = max
    return {
      title: this.data.title,
      note: this.data.note,
      images: this.data.images || [],
      location: this.data.location || null,
      remind_at: dt.toISOString(),
      repeat_type: repeatType,
      repeat_interval: repeatType === 'workday' || repeatType === 'restday' ? 1 : interval,
      // 指定日期本身就是一份清单，再叠加起止范围只会互相干扰，直接清空
      repeat_dates: repeatType === 'dates' ? dates : [],
      repeat_start: repeatType === 'dates' ? '' : this.data.rangeEnabled ? this.data.rangeStart : '',
      repeat_end: repeatType === 'dates' ? '' : this.data.rangeEnabled ? this.data.rangeEnd : '',
      skip_holiday: this.data.skipHoliday,
      holiday_action: ACTION_KEYS[this.data.actionIndex] || 'skip',
      priority: PRIORITY_KEYS[this.data.priorityIndex] || 'medium',
      // 是否需要手工确认完成：默认 false，展示层据此决定到点是否自动完成
      manual_done: this.data.manualDone === true,
    }
  },

  updateWeekday() {
    const d = parseLocal(this.data.dateStr, '00:00')
    let text = ''
    if (!isNaN(d.getTime())) {
      const kind = app.globalData.holidayMap[this.data.dateStr]
      text = fmt.weekday(d)
      if (kind === 'holiday') text += ' · ' + t('mp_mark_holiday')
      else if (kind === 'workday') text += ' · ' + t('mp_mark_makeup')
    }
    this.setData({ weekdayText: text })
  },

  updatePreview() {
    const todo = this.currentTodo()
    const first = new Date(todo.remind_at)
    const holidayMap = app.globalData.holidayMap || {}

    this.setData({
      previewFirst: isNaN(first.getTime())
        ? '—'
        : core.minuteKey(first) + ' ' + fmt.weekday(first),
    })

    // 系统日历支持性是纯计算（不碰 wx API），在这里实时给提示：
    // 不支持的规则保存时会自动跳过写入，别让用户以为一定写进去了。
    const calInfo = calendar.supportInfo(todo)
    let calHint = ''
    if (!this.data.autoCalendar) {
      calHint = this.data.isEdit
        ? t('ed_cal_hint_edit_off')
        : t('ed_cal_hint_new_off')
    } else if (!calInfo.ok) {
      calHint = t('ed_cal_hint_unsupported') + calInfo.reason
    } else {
      calHint = this.data.isEdit
        ? t('ed_cal_hint_edit_on')
        : t('ed_cal_hint_new_on')
    }
    this.setData({ calendarSupported: calInfo.ok, calendarHint: calHint })

    const range = fmt.describeRepeatRange(todo)
    let hint = range
      ? t('ed_range_on', { range: range })
      : t('ed_range_off')
    // 提醒日期落在范围外时，「首次提醒」那一行显示的是一个不会响的时刻，要明确点出来
    if (range && !isNaN(first.getTime()) && !core.inRepeatRange(first, todo)) {
      hint += t('ed_range_warn')
    }
    this.setData({ rangeHint: hint })

    // 按日历选择但一天都没挑：没有可枚举的时刻，直接说清楚
    if (todo.repeat_type === 'dates' && !(todo.repeat_dates || []).length) {
      this.setData({
        previewFirst: '—',
        previewNext: t('ed_no_dates'),
        previewTip: t('ed_tip_dates_empty'),
      })
      return
    }

    const next = core.nextOccurrence(todo, Date.now(), holidayMap)
    if (!next && todo.repeat_type === 'dates') {
      this.setData({
        previewNext: t('ed_next_dates_done'),
        previewTip: t('ed_tip_dates_passed', { n: todo.repeat_dates.length }),
      })
      return
    }
    if (!next) {
      const why = todo.repeat_type === 'none'
        ? t('ed_next_once')
        : range
        ? t('ed_next_range')
        : t('ed_next_none')
      this.setData({
        previewNext: why,
        previewTip: todo.repeat_type === 'none' ? t('ed_tip_once') : t('ed_tip_no_next'),
      })
      return
    }
    this.setData({ previewNext: next.atText })

    let tip = ''
    const key = core.dateKey(new Date(next.at))
    if (range) tip = t('ed_tip_range', { range: range })
    if (todo.repeat_type === 'dates') {
      const list = core.selectedDates(todo)
      let offCount = 0
      list.forEach((d) => {
        if (holidayMap[d] === 'holiday') offCount++
      })
      tip += t('ed_tip_dates_summary', { n: list.length, dates: fmt.describeRepeatDates(todo, 6) })
      if (offCount && todo.skip_holiday) {
        tip += t('ed_tip_dates_off', { n: offCount }) +
          (todo.holiday_action === 'postpone' ? t('ed_tip_dates_postpone') : t('ed_tip_dates_skip'))
      }
      this.setData({ previewTip: tip })
      return
    }
    if (todo.repeat_type === 'restday') {
      tip += t('ed_tip_restday')
      this.setData({ previewTip: tip })
      return
    }
    if (holidayMap[key] === 'holiday') {
      tip += t('ed_tip_holiday_mark')
    } else if (todo.skip_holiday) {
      tip += todo.holiday_action === 'postpone'
        ? t('ed_tip_postpone')
        : t('ed_tip_skip')
    } else {
      tip += t('ed_tip_no_skip')
    }
    this.setData({ previewTip: tip })
  },

  onTitle(e) {
    this.setData({ title: e.detail.value })
  },

  onNote(e) {
    this.setData({ note: e.detail.value })
  },

  /* ── 附件备注：图片 / 位置 ─────────────────────────────────────────── */

  /** 选图 → 直传云存储 → 只把 fileID 记进 todos */
  async onAddImage() {
    if (this.data.isShared) return
    wx.showLoading({ title: t('ed_uploading'), mask: true })
    try {
      const ids = await attachments.chooseAndUpload(this.data.images)
      this.setData({ images: ids })
      wx.showToast({ title: t('hol_added'), icon: 'success' })
    } catch (e) {
      // 用户取消选图不算失败，静默返回
      const msg = String((e && e.errMsg) || (e && e.message) || '')
      if (msg.indexOf('cancel') >= 0) return
      wx.showToast({ title: msg || t('hol_add_fail'), icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  onPreviewImage(e) {
    attachments.previewImage(this.data.images, e.currentTarget.dataset.src)
  },

  onDelImage(e) {
    const index = Number(e.currentTarget.dataset.index)
    const list = (this.data.images || []).slice()
    if (isNaN(index) || index < 0 || index >= list.length) return
    list.splice(index, 1)
    this.setData({ images: list })
  },

  /** 选点。取消/拒授权都要区分开：取消静默，拒授权给引导 */
  async onChooseLocation() {
    if (this.data.isShared) return
    try {
      const loc = await attachments.chooseLocation()
      if (!loc || !loc.latitude) return
      this.setData({
        location: {
          name: String(loc.name || ''),
          address: String(loc.address || ''),
          latitude: Number(loc.latitude),
          longitude: Number(loc.longitude),
        },
      })
    } catch (e) {
      const msg = String((e && e.errMsg) || (e && e.message) || '')
      if (msg.indexOf('cancel') >= 0) return
      wx.showModal({
        title: t('ed_location_title'),
        content: t('ed_location_content'),
        showCancel: false,
      })
    }
  },

  onClearLocation() {
    this.setData({ location: null })
  },

  onOpenLocation() {
    attachments.openLocation(this.data.location)
  },

  onDate(e) {
    this.setData({ dateStr: e.detail.value })
    this.updateWeekday()
    this.updatePreview()
  },

  onTime(e) {
    this.setData({ timeStr: e.detail.value })
    this.updatePreview()
  },

  onRepeat(e) {
    const index = Number(e.detail.value)
    const type = REPEAT_KEYS[index] || 'none'
    const max = intervalMaxOf(type)
    // 切换方式后把已填的间隔夹到新上限内（如 999 天 → 切到按小时则回 99）
    let intervalText = this.data.intervalText
    const parsed = parseInt(intervalText, 10)
    if (!isNaN(parsed) && parsed > max) intervalText = String(max)
    // 切到「按日历选择」时不做任何预选：日期清单必须是用户自己点出来的，
    // 预填今天会让「只想在 11/3、11/8 提醒」变成多出一个今天的提醒
    const repeatDates = this.data.repeatDates
    this.setData({
      repeatIndex: index,
      showInterval: WITH_INTERVAL.indexOf(type) >= 0,
      showHoliday: type !== 'restday',
      // 「仅一次」没有重复周期可限定，范围设置对它无意义；
      // 「按日历选择」本身就是一份日期清单，同样不需要起止范围
      showRange: type !== 'none' && type !== 'dates',
      rangeEnabled: type === 'none' ? false : this.data.rangeEnabled,
      showDates: type === 'dates',
      repeatDates: repeatDates,
      intervalLabel: intervalLabelOf(type),
      intervalRange: intervalRangeOf(type),
      intervalMax: max,
      intervalText: intervalText,
    })
    this.updatePreview()
  },

  /** 打开「限定生效日期」：默认把起始日填成提醒日期，结束日留空（不限） */
  onRangeToggle(e) {
    const on = !!e.detail.value
    if (on && !this.data.rangeStart && !this.data.rangeEnd) {
      this.setData({ rangeEnabled: true, rangeStart: this.data.dateStr, rangeEnd: '' })
    } else {
      this.setData({ rangeEnabled: on })
    }
    this.updatePreview()
  },

  onRangeStart(e) {
    this.setData({ rangeStart: e.detail.value })
    this.updatePreview()
  },

  onRangeEnd(e) {
    this.setData({ rangeEnd: e.detail.value })
    this.updatePreview()
  },

  onPriority(e) {
    this.setData({ priorityIndex: Number(e.detail.value) })
  },

  onInterval(e) {
    this.setData({ intervalText: e.detail.value })
    this.updatePreview()
  },

  onSkipHoliday(e) {
    this.setData({ skipHoliday: e.detail.value })
    this.updatePreview()
  },

  /** 完成方式：默认关（提醒发完自动完成），打开才必须手工确认 */
  onManualDone(e) {
    this.setData({ manualDone: !!e.detail.value })
  },

  /** 新建默认写系统日历；改动后重算支持性提示 */
  onAutoCalendar(e) {
    this.setData({ autoCalendar: !!e.detail.value })
    this.updatePreview()
  },

  onAction(e) {
    this.setData({ actionIndex: Number(e.detail.value) })
    this.updatePreview()
  },

  /* ── 自定义滚轮选择器（字号与页面标签一致）───────────────────── */

  /** 打开滚轮：data-type = date | time | repeat | priority | action */
  openCp(e) {
    // 协作副本只读：不允许改日期/时间/重复等规则
    if (this.data.isShared) {
      wx.showToast({ title: t('ed_shared_readonly'), icon: 'none' })
      return
    }
    const type = String(e.currentTarget.dataset.type || '')
    const d = this.data
    let title = ''
    let columns = []
    let value = []

    if (isDateCp(type)) {
      title =
        type === 'date' ? t('ed_cp_date') : type === 'rangeStart' ? t('ed_cp_range_start') : t('ed_cp_range_end')
      const cur = type === 'date' ? d.dateStr : type === 'rangeStart' ? d.rangeStart : d.rangeEnd
      const parts = String(cur || d.dateStr).split('-')
      const y = Math.min(CP_YEAR_END, Math.max(CP_YEAR_START, Number(parts[0]) || CP_YEAR_START))
      const m = Math.min(12, Math.max(1, Number(parts[1]) || 1))
      const day = Math.max(1, Number(parts[2]) || 1)
      const days = cpDaysOfMonth(y, m)
      columns = [
        { key: 'year', items: d.cpYears },
        { key: 'month', items: d.cpMonths },
        { key: 'day', items: days },
      ]
      value = [y - CP_YEAR_START, m - 1, Math.min(day, days.length) - 1]
    } else if (type === 'time') {
      title = t('ed_cp_time')
      const tp = String(d.timeStr).split(':')
      columns = [
        { key: 'hour', items: d.cpHours },
        { key: 'minute', items: d.cpMinutes },
      ]
      value = [Number(tp[0]) || 0, Number(tp[1]) || 0]
    } else if (type === 'repeat') {
      title = t('f_repeat')
      columns = [{ key: 'value', items: d.repeatNames }]
      value = [d.repeatIndex]
    } else if (type === 'priority') {
      title = t('f_prio')
      columns = [{ key: 'value', items: d.priorityNames }]
      value = [d.priorityIndex]
    } else if (type === 'action') {
      title = t('f_on_holiday')
      columns = [{ key: 'value', items: d.actionNames }]
      value = [d.actionIndex]
    } else {
      return
    }

    this.setData({ cpVisible: true, cpType: type, cpTitle: title, cpColumns: columns, cpValue: value })
  },

  /** 滚动中：日期模式在年/月变化时重建「日」列（2 月等大小月），其余直接记录 */
  onCpChange(e) {
    const val = e.detail.value || []
    if (isDateCp(this.data.cpType)) {
      const y = CP_YEAR_START + (Number(val[0]) || 0)
      const m = (Number(val[1]) || 0) + 1
      const days = cpDaysOfMonth(y, m)
      const current = this.data.cpColumns[2] ? this.data.cpColumns[2].items : []
      if (current.length !== days.length) {
        const dayIdx = Math.min(Number(val[2]) || 0, days.length - 1)
        const columns = this.data.cpColumns.slice()
        columns[2] = { key: 'day', items: days }
        this.setData({ cpColumns: columns, cpValue: [val[0], val[1], dayIdx] })
        return
      }
    }
    this.setData({ cpValue: val })
  },

  /** 确定：按类型换算回原格式，复用现有 onDate/onTime/onRepeat/onPriority/onAction */
  onCpConfirm() {
    const type = this.data.cpType
    const val = this.data.cpValue || []
    this.setData({ cpVisible: false })
    if (isDateCp(type)) {
      const y = CP_YEAR_START + (Number(val[0]) || 0)
      const m = (Number(val[1]) || 0) + 1
      const day = (Number(val[2]) || 0) + 1
      const value = y + '-' + core.pad2(m) + '-' + core.pad2(day)
      if (type === 'date') this.onDate({ detail: { value: value } })
      else if (type === 'rangeStart') this.onRangeStart({ detail: { value: value } })
      else this.onRangeEnd({ detail: { value: value } })
    } else if (type === 'time') {
      this.onTime({ detail: { value: core.pad2(Number(val[0]) || 0) + ':' + core.pad2(Number(val[1]) || 0) } })
    } else if (type === 'repeat') {
      this.onRepeat({ detail: { value: Number(val[0]) || 0 } })
    } else if (type === 'priority') {
      this.onPriority({ detail: { value: Number(val[0]) || 0 } })
    } else if (type === 'action') {
      this.onAction({ detail: { value: Number(val[0]) || 0 } })
    }
  },

  onCpCancel() {
    this.setData({ cpVisible: false })
  },

  cpNoop() {
    // 用 catchtap 阻止面板点击冒泡到遮罩层（否则会误关闭），
    // 但也因此截断了到根节点的冒泡，这里自己补一次额度。
    subscribe.renew()
  },

  /* ── 「按日历选择」的月历多选面板 ─────────────────────────────────────── */

  /** 生成从 fromYm 起 count 个月的网格（周一开头，带节假日标记） */
  buildMonths(fromYm, count) {
    const holidayMap = app.globalData.holidayMap || {}
    const today = core.dateKey(new Date())
    const selected = {}
    ;(this.data.repeatDates || []).forEach((d) => {
      selected[d] = true
    })
    const out = []
    for (let i = 0; i < count; i++) {
      const ym = ymAdd(fromYm, i)
      const y = Number(ym.slice(0, 4))
      const m = Number(ym.slice(5, 7))
      const total = new Date(y, m, 0).getDate()
      // 周一 = 0：1 号前面补空格
      const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7
      const days = []
      for (let k = 0; k < lead; k++) days.push({ id: ym + '-pad' + k, date: '', label: '' })
      for (let d = 1; d <= total; d++) {
        const key = y + '-' + core.pad2(m) + '-' + core.pad2(d)
        const kind = holidayMap[key] || ''
        days.push({
          id: key,
          date: key,
          label: String(d),
          selected: !!selected[key],
          today: key === today,
          past: key < today,
          kind: kind,
          mark: kind === 'holiday' ? t('ed_cal_mark_off') : kind === 'workday' ? t('ed_cal_mark_work') : '',
        })
      }
      out.push({ key: ym, title: t('ed_cal_month_title', { year: y, month: m }), days: days })
    }
    return out
  },

  /** 打开月历：从「提醒日期所在月」与「当月」中较晚的那个开始 */
  openCalendar() {
    if (this.data.isShared) {
      wx.showToast({ title: t('ed_shared_readonly'), icon: 'none' })
      return
    }
    const nowYm = core.dateKey(new Date()).slice(0, 7)
    const curYm = String(this.data.dateStr).slice(0, 7)
    const from = curYm < nowYm ? nowYm : curYm
    // 备份一份，取消时回滚
    this.calBackup = (this.data.repeatDates || []).slice()
    this.setData({
      calVisible: true,
      calStartYm: from,
      calLoaded: CAL_PAGE,
      calMonths: this.buildMonths(from, CAL_PAGE),
      calCanMore: CAL_PAGE < CAL_MAX,
    })
  },

  /** 点某天：切换选中。只改这一格的 selected，不整月重建 */
  onCalPick(e) {
    const ds = e.currentTarget.dataset || {}
    const date = String(ds.date || '')
    const mi = Number(ds.mi)
    const di = Number(ds.di)
    if (!date) return
    const list = (this.data.repeatDates || []).slice()
    const at = list.indexOf(date)
    let on = false
    if (at >= 0) {
      list.splice(at, 1)
    } else {
      list.push(date)
      list.sort()
      on = true
    }
    const patch = { repeatDates: list }
    if (!isNaN(mi) && !isNaN(di)) patch['calMonths[' + mi + '].days[' + di + '].selected'] = on
    this.setData(patch)
  },

  onCalMore() {
    const from = ymAdd(this.data.calStartYm, this.data.calLoaded)
    const loaded = this.data.calLoaded + CAL_PAGE
    this.setData({
      calMonths: this.data.calMonths.concat(this.buildMonths(from, CAL_PAGE)),
      calLoaded: loaded,
      calCanMore: loaded < CAL_MAX,
    })
  },

  onCalClear() {
    this.setData({
      repeatDates: [],
      calMonths: this.buildMonths(this.data.calStartYm, this.data.calLoaded),
    })
  },

  onCalConfirm() {
    this.setData({ calVisible: false })
    this.updatePreview()
  },

  onCalCancel() {
    this.setData({ calVisible: false, repeatDates: (this.calBackup || []).slice() })
  },

  /** 卡片上的日期胶囊：点一下去掉这一天 */
  onRemoveDate(e) {
    const date = String((e.currentTarget.dataset || {}).date || '')
    this.setData({ repeatDates: (this.data.repeatDates || []).filter((d) => d !== date) })
    this.updatePreview()
  },

  /**
   * 保存时自动写入手机系统日历：新建默认开，编辑默认关（避免重复事件），
   * 编辑页把开关打开就表示「这次要重写一条」。
   *
   * 两个平台硬约束，决定了它必须长这样：
   *   1. wx.addPhoneCalendar / addPhoneRepeatCalendar **仅允许在点击行为时调用**，
   *      所以本方法只能在 onSave 的同步点击链里调，前面不能出现任何 await；
   *      calendar.writeTodoCalendar 内部是在 Promise executor 里同步发起 wx API 的。
   *   2. 日历授权弹窗不能与订阅授权弹窗并发（会互相打断），因此本次点击要写日历时，
   *      onSave 不再调 subscribe.renew()（额度由页面其它点击补齐，且日历通道本就不耗额度）。
   *
   * 结果不弹窗、不 await：避免 wx.showModal 与保存成功的 toast / 返回互相打断。
   * 只把一句话存进 app.globalData.calendarNotice，由首页 onShow 提示一次。
   * 返回是否真的发起了写入（规则不支持时返回 false，好让 onSave 把订阅额度补回来）。
   */
  autoWriteCalendar(todo) {
    if (!this.data.autoCalendar || this.data.isShared) return false
    const info = calendar.supportInfo(todo)
    if (!info.ok) {
      console.warn('[edit] calendar skipped:', info.reason)
      setCalendarNotice(t('ed_cal_skip_notice'))
      return false
    }
    // 基础库过低时日历 API 根本不存在：必须在点击链里同步判掉，
    // 否则 writeTodoCalendar 会在异步回调里返回失败，这次点击的订阅额度就白丢了。
    const apiName = info.single ? 'addPhoneCalendar' : 'addPhoneRepeatCalendar'
    if (typeof wx[apiName] !== 'function') {
      setCalendarNotice(t('ed_cal_low_version'))
      return false
    }
    // 同步发起：这一句必须在点击手势链里，不能移到任何 await 之后
    calendar.writeTodoCalendar(todo).then((res) => {
      if (!res.ok) console.warn('[edit] calendar write failed:', res.message)
      setCalendarNotice(res.ok ? t('ed_cal_ok_notice') : t('ed_cal_fail_notice'))
    }).catch(() => {
      setCalendarNotice(t('ed_cal_fail_notice'))
    })
    return true
  },

  async onSave() {
    // 写库没回来之前一律拦掉：以前按钮毫无反馈，网络慢时连点几下就插出几条同名待办
    if (this.data.saving) return
    // 开关开着时，本次点击的手势要让给日历授权弹窗，不能同时补订阅额度；
    // 没真的写成日历（规则不支持 / 提前拦截）时，这次点击的额度要补回来。
    const planCalendar = this.data.autoCalendar && !this.data.isShared
    let renewed = false
    const renewOnce = () => {
      if (renewed) return
      renewed = true
      // 必须同步发起：await 之后会被判为非用户手势
      subscribe.renew()
    }
    const bail = (text) => {
      renewOnce()
      wx.showToast({ title: text, icon: 'none' })
    }
    if (!planCalendar) {
      // 保存是最自然的补额度时机；必须放在任何 await 之前，否则被判为非用户手势
      renewOnce()
    }
    // 协作副本只读：内容由创建者统一维护，避免双向改冲突
    if (this.data.isShared) {
      bail(t('ed_shared_readonly'))
      return
    }
    // 生效范围：结束日早于开始日是一条永远不会响的规则，直接拦住
    if (this.data.rangeEnabled && this.data.rangeStart && this.data.rangeEnd) {
      if (String(this.data.rangeEnd) < String(this.data.rangeStart)) {
        bail(t('ed_range_invalid'))
        return
      }
    }
    // 按日历选择：一天都没挑就是一条永远不会响的规则，拦住
    if (REPEAT_KEYS[this.data.repeatIndex] === 'dates' && !(this.data.repeatDates || []).length) {
      bail(t('ed_pick_dates_required'))
      return
    }
    const title = String(this.data.title || '').trim()
    if (!title) {
      bail(t('ed_need_title'))
      return
    }
    const todo = this.currentTodo()
    todo.title = title
    todo.updated_at = new Date().toISOString()
    // 新建带幂等键：同一页的连点 / 超时重试都指向同一条记录（store 层按它判重）
    if (!this.data.isEdit) {
      this.saveToken = this.saveToken || saveGuard.makeSaveToken()
      todo.client_token = this.saveToken
    }

    // 新建 / 改时间都要把游标初始化为「此刻」。
    // 不推进 → 新时间若早于上次提醒时刻，会被当成「已提醒」而永远不再响；
    // 置空更糟 → 定时扫描和小程序补记都会从 remind_at 一路枚举到现在，
    // 一次性补发/补记历史上所有到期项（首页就会冒出「有 N 条提醒已到期」）。
    let resetCursor = !this.data.isEdit
    if (this.data.isEdit) {
      const originMs = this.data.originRemindAt ? new Date(this.data.originRemindAt).getTime() : 0
      const newMs = new Date(todo.remind_at).getTime()
      if (originMs && !isNaN(newMs) && originMs !== newMs) resetCursor = true
    }
    if (resetCursor) {
      const nowIso = new Date().toISOString()
      todo.last_logged_at = nowIso
      todo.last_pushed_at = nowIso
      // 兼容部署过渡期仍读旧字段的旧云函数包
      todo.last_reminded_at = nowIso
    }

    const next = core.nextOccurrence(todo, Date.now(), app.globalData.holidayMap || {})
    todo.next_remind_at = next ? new Date(next.at).toISOString() : null
    todo.status = 'active'

    // 默认写入手机系统日历：必须在任何 await 之前同步发起。
    // 平台要求日历 API「仅在点击行为时调用」，等写库成功再写会脱离手势链直接 fail；
    // 代价是写库失败时日历可能已写入（无删除接口），下面 fail() 会如实提示用户。
    // 规则不支持而没发起时，把这次让出去的订阅额度补回来。
    let calendarStarted = false
    if (planCalendar) {
      calendarStarted = this.autoWriteCalendar(todo)
      if (!calendarStarted) renewOnce()
    }

    // 上锁：按钮变「保存中…」+ 全屏遮罩 loading，写库期间连点也进不来
    this.setData({ saving: true })
    wx.showLoading({ title: t('saving'), mask: true })
    const fail = (msg) => {
      wx.hideLoading()
      this.setData({ saving: false })
      // 日历已经先写入了，而微信没有删除日历事件的接口，必须提醒用户去日历 App 手动删
      wx.showToast({
        title: calendarStarted ? t('ed_fail_calendar_written') : msg,
        icon: 'none',
        duration: 2600,
      })
    }

    // 只有这一次写库是「保存成功」的判据，超时也不让 loading 永久挂着
    let res
    let savedId = this.data.id
    try {
      if (this.data.isEdit) {
        res = await saveGuard.withTimeout(store.updateTodo(this.data.id, todo))
        if (!res.error && (!res.data || res.data.length === 0)) {
          fail(t('ed_no_permission_edit'))
          return
        }
      } else {
        res = await saveGuard.withTimeout(store.insertTodo(todo))
        if (!res.error && (!res.data || res.data.length === 0)) {
          fail(t('ed_need_login_create'))
          return
        }
      }
      if (res.error) {
        fail(res.error.message || t('ed_save_fail_retry'))
        return
      }
    } catch (e) {
      fail((e && e.message) || t('ed_save_fail_retry'))
      return
    }
    if (!savedId && res.data && res.data[0]) savedId = res.data[0].id

    // 协作邀请 / 同步不是保存成功的必要条件，改为后台执行：
    // 以前这两次云函数调用（冷启动可达数秒）是「点保存发卡、用户连点」的主因。
    // 编辑页 onLoad 的 ensureInvite() 和 goInvite() 都有补建兜底，漏了能自动补回来。
    if (this.data.isEdit && this.data.inviteId) {
      collab.sync(String(this.data.inviteId), todo).catch(() => {})
    } else if (!this.data.isEdit && savedId) {
      collab.create(todo, savedId).catch(() => {})
    }

    // 通知待办页：回来时必须重新拉一次（跳过 10 秒内的加载节流）
    app.globalData.todosDirty = true

    // 写库成功后才给「已保存」并返回；成功到返回这段也保持锁，避免 toast 期间再点。
    // 返回失败（页面栈异常）时把锁放开，让用户还能重试（重试走幂等，不会重复）。
    wx.hideLoading()
    wx.showToast({ title: t('hol_saved'), icon: 'success' })
    setTimeout(() => {
      wx.navigateBack({
        fail: () => this.setData({ saving: false }),
      })
    }, 450)
  },

  /**
   * 写入手机系统日历：点一次，之后由系统按重复规则持续提醒。
   * wx.addPhoneCalendar / addPhoneRepeatCalendar 都要求「仅在点击行为时调用」，
   * 所以必须在 tap handler 里同步发起，不能挂到保存成功后的 await 链后面。
   * 用 catchtap 截断根节点冒泡，避免订阅授权与日历授权两个弹窗并发。
   */
  onWriteCalendar() {
    const todo = this.currentTodo()
    const info = calendar.supportInfo(todo)
    if (!info.ok) {
      wx.showModal({ title: t('ed_write_cal_title'), content: info.reason, showCancel: false })
      return
    }
    calendar.writeTodoCalendar(todo).then((res) => {
      wx.showModal({
        title: res.ok ? t('ed_cal_ok_notice') : t('ed_write_cal_fail'),
        content: res.message,
        showCancel: false,
        confirmText: res.ok ? t('idx_got_it') : t('k_close'),
      })
    })
  },

  onDelete() {
    const self = this
    wx.showModal({
      title: t('ed_delete_title'),
      content: t('ed_delete_content'),
      async success(res) {
        if (!res.confirm) return
        const result = await store.removeTodo(self.data.id)
        if (result.error) {
          wx.showToast({ title: t('t_del_fail'), icon: 'none' })
          return
        }
        wx.showToast({ title: t('t_deleted'), icon: 'success' })
        app.globalData.todosDirty = true
        setTimeout(() => {
          wx.navigateBack()
        }, 500)
      },
    })
  },
})
