const store = require('../../utils/store')
const core = require('../../utils/reminder-core')
const subscribe = require('../../utils/subscribe')
const collab = require('../../utils/collab')
const attachments = require('../../utils/attachments')
const calendar = require('../../utils/calendar')
const saveGuard = require('../../utils/save-guard')
const { SHARE_TITLE, SHARE_PATH } = require('../../utils/share')

const app = getApp()

const REPEAT_KEYS = ['none', 'daily', 'hourly', 'minutely', 'weekly', 'monthly', 'yearly', 'workday', 'restday', 'dates']
const REPEAT_NAMES = ['仅一次', '按天', '按小时', '按分钟', '按周', '按月', '按年', '每工作日', '每休息日', '按日历选择']
const ACTION_KEYS = ['skip', 'postpone']
const ACTION_NAMES = ['跳过当日，本次不提醒', '顺延到下一个工作日']
const PRIORITY_KEYS = ['high', 'medium', 'low']
const PRIORITY_NAMES = ['高', '中', '低']

/** 需要填写间隔的重复方式 */
const WITH_INTERVAL = ['daily', 'hourly', 'minutely', 'weekly', 'monthly', 'yearly']

/** 间隔输入框的标签：每隔几(天/小时/分钟/周/个月/年) */
function intervalLabelOf(type) {
  const unit = core.INTERVAL_UNITS[type]
  return unit ? '每隔几' + unit : '每隔几天'
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
const CP_YEARS = []
const CP_MONTHS = []
const CP_HOURS = []
const CP_MINUTES = []
for (let y = CP_YEAR_START; y <= CP_YEAR_END; y++) CP_YEARS.push(y + '年')
for (let m = 1; m <= 12; m++) CP_MONTHS.push(m + '月')
for (let h = 0; h < 24; h++) CP_HOURS.push(core.pad2(h) + '时')
for (let mi = 0; mi < 60; mi++) CP_MINUTES.push(core.pad2(mi) + '分')

/** 走「年/月/日」三列滚轮的选择类型 */
function isDateCp(type) {
  return type === 'date' || type === 'rangeStart' || type === 'rangeEnd'
}

/* ── 「按日历选择」的月历多选面板 ─────────────────────────────────────── */
const WEEK_HEAD = ['一', '二', '三', '四', '五', '六', '日']
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
  for (let d = 1; d <= total; d++) out.push(d + '日')
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
    intervalLabel: '每隔几天',
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
    saveText: '保存',
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
      intervalLabel: '每隔几天',
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
    this.updateWeekday()
    this.updatePreview()

    // 新建页实例一个幂等键：同一页连点、超时重试都带它，store 层据此保证只落一条。
    // 编辑页改的是同一条记录（按 id 更新），不需要。
    if (!(options && options.id)) this.saveToken = saveGuard.makeSaveToken()

    if (options && options.id) {
      this.setData({ id: String(options.id), isEdit: true, saveText: '保存修改' })
      wx.setNavigationBarTitle({ title: '编辑待办' })
      this.loadTodo(String(options.id))
    } else {
      wx.setNavigationBarTitle({ title: '新建待办' })
    }
  },

  /**
   * 分享：已为这条待办生成邀请时，转发出去的是「邀请卡片」——好友点开即可
   * 一键加入、同步获得同规则提醒；否则退回普通分享。
   */
  onShareAppMessage() {
    const inviteId = this.data.inviteId
    if (inviteId) {
      const name = String(this.data.title || '').trim() || 'KIWI待办'
      return {
        title: '邀请你一起提醒：' + name,
        path: '/pages/invite/invite?invite=' + inviteId,
      }
    }
    return { title: SHARE_TITLE, path: SHARE_PATH }
  },

  async loadTodo(id) {
    const res = await store.listTodos()
    if (res.error) {
      wx.showToast({ title: '加载失败', icon: 'none' })
      return
    }
    const todo = (res.data || []).filter((t) => t.id === id)[0]
    if (!todo) {
      wx.showToast({ title: '待办不存在', icon: 'none' })
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
      wx.showToast({ title: '请先保存这条待办', icon: 'none' })
      return
    }
    let inviteId = this.data.inviteId
    if (!inviteId) {
      wx.showLoading({ title: '准备邀请', mask: true })
      await this.ensureInvite()
      wx.hideLoading()
      inviteId = this.data.inviteId
    }
    if (!inviteId) {
      wx.showModal({
        title: '邀请未就绪',
        content: '云函数 pushapi 可能还是旧版本。请在微信开发者工具里右键 cloudfunctions/pushapi →「上传并部署」，再重新打开本页。',
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
      title: '退出协作提醒',
      content: '退出后这条待办会从你的列表移除，且不再收到提醒。',
      async success(r) {
        if (!r.confirm) return
        const { error } = await collab.leave(inviteId)
        if (error) {
          wx.showToast({ title: error.message || '退出失败', icon: 'none' })
          return
        }
        wx.showToast({ title: '已退出', icon: 'success' })
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
      text = core.weekdayName(d)
      if (kind === 'holiday') text += ' · 法定节假日'
      else if (kind === 'workday') text += ' · 调休补班'
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
        : core.minuteKey(first) + ' ' + core.weekdayName(first),
    })

    // 系统日历支持性是纯计算（不碰 wx API），在这里实时给提示：
    // 不支持的规则保存时会自动跳过写入，别让用户以为一定写进去了。
    const calInfo = calendar.supportInfo(todo)
    let calHint = ''
    if (!this.data.autoCalendar) {
      calHint = this.data.isEdit
        ? '编辑保存不会重复写入日历；要重写一条请打开上方开关，或点下方按钮。'
        : '已关闭自动写入；需要时点下方按钮手动写入手机日历。'
    } else if (!calInfo.ok) {
      calHint = '当前设置无法写入系统日历，保存时会自动跳过：' + calInfo.reason
    } else {
      calHint = this.data.isEdit
        ? '保存时会重新写入一条日历事件；旧事件微信删不掉，需要到手机日历 App 手动删。'
        : '保存时将自动写入手机系统日历，由系统本地提醒，不消耗微信额度。'
    }
    this.setData({ calendarSupported: calInfo.ok, calendarHint: calHint })

    const range = core.describeRepeatRange(todo)
    let hint = range
      ? '仅在 ' + range + ' 之间按规则提醒，范围外的日期不提醒（留空的一端表示不限）。'
      : '不限制日期范围，按所选重复规则一直提醒下去。'
    // 提醒日期落在范围外时，「首次提醒」那一行显示的是一个不会响的时刻，要明确点出来
    if (range && !isNaN(first.getTime()) && !core.inRepeatRange(first, todo)) {
      hint += ' 注意：当前提醒日期不在范围内，该日不会提醒。'
    }
    this.setData({ rangeHint: hint })

    // 按日历选择但一天都没挑：没有可枚举的时刻，直接说清楚
    if (todo.repeat_type === 'dates' && !(todo.repeat_dates || []).length) {
      this.setData({
        previewFirst: '—',
        previewNext: '未选择日期',
        previewTip: '「按日历选择」需要先在上面打开日历，挑出要提醒的那几天。',
      })
      return
    }

    const next = core.nextOccurrence(todo, Date.now(), holidayMap)
    if (!next && todo.repeat_type === 'dates') {
      this.setData({
        previewNext: '无（指定日期已过完）',
        previewTip: '你选的 ' + todo.repeat_dates.length + ' 天都已经过了，这条之后不会再提醒。',
      })
      return
    }
    if (!next) {
      const why = todo.repeat_type === 'none'
        ? '无（单次提醒已过）'
        : range
        ? '无（已超出生效日期范围）'
        : '无'
      this.setData({
        previewNext: why,
        previewTip: todo.repeat_type === 'none' ? '单次提醒到期后不再重复。' : '当前设置下没有后续的提醒时刻。',
      })
      return
    }
    this.setData({ previewNext: next.atText })

    let tip = ''
    const key = core.dateKey(new Date(next.at))
    if (range) tip = '生效范围 ' + range + '；'
    if (todo.repeat_type === 'dates') {
      const list = core.selectedDates(todo)
      let offCount = 0
      list.forEach((d) => {
        if (holidayMap[d] === 'holiday') offCount++
      })
      tip += '共 ' + list.length + ' 个指定日期：' + core.describeRepeatDates(todo, 6) + '，最后一天之后不再提醒。'
      if (offCount && todo.skip_holiday) {
        tip +=
          ' 其中 ' + offCount + ' 天是法定节假日，' +
          (todo.holiday_action === 'postpone' ? '会顺延到下一个工作日再提醒。' : '会按「跳过节假日」不提醒。')
      }
      this.setData({ previewTip: tip })
      return
    }
    if (todo.repeat_type === 'restday') {
      tip += '仅周末及法定节假日提醒（调休补班日不提醒）。'
      this.setData({ previewTip: tip })
      return
    }
    if (holidayMap[key] === 'holiday') {
      tip += '注意：该日被标为法定节假日，请到「我的 → 节假日维护」确认。'
    } else if (todo.skip_holiday) {
      tip += todo.holiday_action === 'postpone'
        ? '遇到法定节假日将顺延到下一个工作日再提醒。'
        : '遇到法定节假日将跳过当日，本次不提醒。'
    } else {
      tip += '不跳过节假日，照常提醒。'
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
    wx.showLoading({ title: '上传中…', mask: true })
    try {
      const ids = await attachments.chooseAndUpload(this.data.images)
      this.setData({ images: ids })
      wx.showToast({ title: '已添加', icon: 'success' })
    } catch (e) {
      // 用户取消选图不算失败，静默返回
      const msg = String((e && e.errMsg) || (e && e.message) || '')
      if (msg.indexOf('cancel') >= 0) return
      wx.showToast({ title: msg || '添加失败', icon: 'none' })
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
        title: '无法选择位置',
        content: '需要你授权位置权限，并在小程序后台开通「地理位置」接口。可到小程序右上角「··· → 设置」里开启后重试。',
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
      wx.showToast({ title: '协作待办由创建者统一管理', icon: 'none' })
      return
    }
    const type = String(e.currentTarget.dataset.type || '')
    const d = this.data
    let title = ''
    let columns = []
    let value = []

    if (isDateCp(type)) {
      title =
        type === 'date' ? '选择日期' : type === 'rangeStart' ? '选择开始日期' : '选择结束日期'
      const cur = type === 'date' ? d.dateStr : type === 'rangeStart' ? d.rangeStart : d.rangeEnd
      const parts = String(cur || d.dateStr).split('-')
      const y = Math.min(CP_YEAR_END, Math.max(CP_YEAR_START, Number(parts[0]) || CP_YEAR_START))
      const m = Math.min(12, Math.max(1, Number(parts[1]) || 1))
      const day = Math.max(1, Number(parts[2]) || 1)
      const days = cpDaysOfMonth(y, m)
      columns = [
        { key: 'year', items: CP_YEARS },
        { key: 'month', items: CP_MONTHS },
        { key: 'day', items: days },
      ]
      value = [y - CP_YEAR_START, m - 1, Math.min(day, days.length) - 1]
    } else if (type === 'time') {
      title = '选择时间'
      const tp = String(d.timeStr).split(':')
      columns = [
        { key: 'hour', items: CP_HOURS },
        { key: 'minute', items: CP_MINUTES },
      ]
      value = [Number(tp[0]) || 0, Number(tp[1]) || 0]
    } else if (type === 'repeat') {
      title = '重复方式'
      columns = [{ key: 'value', items: d.repeatNames }]
      value = [d.repeatIndex]
    } else if (type === 'priority') {
      title = '优先级'
      columns = [{ key: 'value', items: d.priorityNames }]
      value = [d.priorityIndex]
    } else if (type === 'action') {
      title = '遇到节假日'
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
          mark: kind === 'holiday' ? '休' : kind === 'workday' ? '班' : '',
        })
      }
      out.push({ key: ym, title: y + '年' + m + '月', days: days })
    }
    return out
  },

  /** 打开月历：从「提醒日期所在月」与「当月」中较晚的那个开始 */
  openCalendar() {
    if (this.data.isShared) {
      wx.showToast({ title: '协作待办由创建者统一管理', icon: 'none' })
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
      console.warn('[edit] 自动写日历跳过：', info.reason)
      setCalendarNotice('当前规则不支持写入日历，已跳过')
      return false
    }
    // 基础库过低时日历 API 根本不存在：必须在点击链里同步判掉，
    // 否则 writeTodoCalendar 会在异步回调里返回失败，这次点击的订阅额度就白丢了。
    const apiName = info.single ? 'addPhoneCalendar' : 'addPhoneRepeatCalendar'
    if (typeof wx[apiName] !== 'function') {
      setCalendarNotice('当前微信版本过低，无法写入日历')
      return false
    }
    // 同步发起：这一句必须在点击手势链里，不能移到任何 await 之后
    calendar.writeTodoCalendar(todo).then((res) => {
      if (!res.ok) console.warn('[edit] 自动写日历失败：', res.message)
      setCalendarNotice(res.ok ? '已写入手机日历' : '手机日历未写入，可在编辑页重试')
    }).catch(() => {
      setCalendarNotice('手机日历未写入，可在编辑页重试')
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
      bail('协作待办由创建者统一管理')
      return
    }
    // 生效范围：结束日早于开始日是一条永远不会响的规则，直接拦住
    if (this.data.rangeEnabled && this.data.rangeStart && this.data.rangeEnd) {
      if (String(this.data.rangeEnd) < String(this.data.rangeStart)) {
        bail('结束日期不能早于开始日期')
        return
      }
    }
    // 按日历选择：一天都没挑就是一条永远不会响的规则，拦住
    if (REPEAT_KEYS[this.data.repeatIndex] === 'dates' && !(this.data.repeatDates || []).length) {
      bail('请选择提醒日期')
      return
    }
    const title = String(this.data.title || '').trim()
    if (!title) {
      bail('请填写标题')
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
    wx.showLoading({ title: '保存中…', mask: true })
    const fail = (msg) => {
      wx.hideLoading()
      this.setData({ saving: false })
      // 日历已经先写入了，而微信没有删除日历事件的接口，必须提醒用户去日历 App 手动删
      wx.showToast({
        title: calendarStarted ? '保存失败；日历若已写入请手动删除' : msg,
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
          fail('没有权限修改这条待办')
          return
        }
      } else {
        res = await saveGuard.withTimeout(store.insertTodo(todo))
        if (!res.error && (!res.data || res.data.length === 0)) {
          fail('请先登录再创建待办')
          return
        }
      }
      if (res.error) {
        fail(res.error.message || '保存失败，请重试')
        return
      }
    } catch (e) {
      fail((e && e.message) || '保存失败，请重试')
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
    wx.showToast({ title: '已保存', icon: 'success' })
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
      wx.showModal({ title: '这条待办不适合写入日历', content: info.reason, showCancel: false })
      return
    }
    calendar.writeTodoCalendar(todo).then((res) => {
      wx.showModal({
        title: res.ok ? '已写入手机日历' : '写入失败',
        content: res.message,
        showCancel: false,
        confirmText: res.ok ? '知道了' : '关闭',
      })
    })
  },

  onDelete() {
    const self = this
    wx.showModal({
      title: '删除待办',
      content: '确定删除这条待办？历史提醒记录会保留。',
      async success(res) {
        if (!res.confirm) return
        const result = await store.removeTodo(self.data.id)
        if (result.error) {
          wx.showToast({ title: '删除失败', icon: 'none' })
          return
        }
        wx.showToast({ title: '已删除', icon: 'success' })
        app.globalData.todosDirty = true
        setTimeout(() => {
          wx.navigateBack()
        }, 500)
      },
    })
  },
})
