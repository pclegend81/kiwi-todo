const store = require('../../utils/store')
const core = require('../../utils/reminder-core')
const subscribe = require('../../utils/subscribe')
const { onShareAppMessage } = require('../../utils/share')

const app = getApp()

const KIND_KEYS = ['holiday', 'workday']
const KIND_NAMES = ['放假（跳过提醒）', '调休补班（照常提醒）']

function weekdayOf(day) {
  const d = core.parseDayKey(day)
  return d ? core.weekdayName(d) : ''
}

Page({
  onAnyTap: subscribe.onAnyTap,
  onShareAppMessage: onShareAppMessage,

  data: {
    list: [],
    loading: false,
    kindNames: KIND_NAMES,
    newDay: '',
    newName: '',
    newKindIndex: 0,
    minDay: '2027-01-01', // 日期选择器下限 = 有效年份，避免加了却不显示
    missingCount: 0, // 内置表里还没写进云端的天数
    seedYearsText: '内置官方安排，可自行增删',
    // 编辑弹层
    editVisible: false,
    editId: '',
    editDay: '',
    editOldDay: '',
    editName: '',
    editKindIndex: 0,
  },

  async onLoad() {
    this._dbDays = []
    const minDay = String(store.MIN_HOLIDAY_YEAR || new Date().getFullYear()) + '-01-01'
    const today = core.dateKey(new Date())
    this.setData({
      // 默认日期落在有效年份内，避免默认选中已结束的 2026
      newDay: today < minDay ? minDay : today,
      minDay: minDay,
    })
    const seedYears = Array.from(
      new Set((store.SEED_HOLIDAYS || []).map((h) => String(h.day).slice(0, 4)))
    ).sort()
    this.setData({
      seedYearsText: seedYears.length
        ? '内置 ' + seedYears.join('、') + ' 年官方安排，可自行增删'
        : '内置官方安排，可自行增删',
    })
    // 自动清理已结束年份（fire-and-forget，不阻塞首屏）
    store.pruneOldHolidays().catch(() => {})
    // App 启动不会自动登录，而写入（回灌/编辑/删除）都要求身份；
    // 这里静默取一次 openid，否则 seedHolidays 会直接返回 0，页面显示「已维护 0 天」。
    await store.ensureOpenid()
    this.load()
  },

  /**
   * 显示层以内置种子为骨架：即使数据库为空、未登录或写入失败，
   * 也一定展示有效年份（当前 2027）的完整安排。云端记录按 day 覆盖名称/类型并带真实 id。
   * 回灌只作为后台动作，不再决定列表能不能显示。
   */
  async load(skipSeed) {
    if (!skipSeed) this.setData({ loading: true })
    const res = await store.listHolidays()
    if (!skipSeed) this.setData({ loading: false })
    const dbRows = store.filterActiveHolidays(res.data || [])
    this._dbDays = dbRows.map((row) => String(row.day).slice(0, 10))
    const merged = store.mergeActiveHolidays(res.data || [])

    const list = merged.map((row) => ({
      id: row.id,
      day: row.day,
      name: row.name,
      kind: row.kind,
      source: row.source,
      weekday: weekdayOf(row.day),
    }))
    // 提醒计算也用合并后的表，保证库里为空时节假日顺延依然正确
    app.setHolidayMap(core.buildHolidayMap(merged))

    const known = new Set(this._dbDays)
    const excluded = store.readExcludedDays()
    const missing = (store.SEED_HOLIDAYS || []).filter(
      (h) => !known.has(h.day) && excluded.indexOf(h.day) < 0
    )
    this.setData({ list: list, missingCount: missing.length })

    if (!skipSeed && missing.length > 0) {
      const seedRes = await store.seedHolidays(this._dbDays)
      if (!seedRes.error && seedRes.inserted > 0) {
        store.clearHolidayCache()
        this.load(true) // 静默刷新拿真实 id；skipSeed 防止无限回灌
      }
    }
  },

  onNewDay(e) {
    this.setData({ newDay: e.detail.value })
  },

  onNewName(e) {
    this.setData({ newName: e.detail.value })
  },

  onNewKind(e) {
    this.setData({ newKindIndex: Number(e.detail.value) })
  },

  async onAdd() {
    const name = String(this.data.newName || '').trim()
    if (!name) {
      wx.showToast({ title: '请填写名称', icon: 'none' })
      return
    }
    const okLogin = await store.ensureOpenid()
    if (!okLogin) {
      wx.showToast({ title: '请先到「我的」页登录后再维护', icon: 'none' })
      return
    }
    const day = this.data.newDay
    const year = Number(String(day).slice(0, 4))
    const res = await store.upsertHoliday({
      day: day,
      name: name,
      kind: KIND_KEYS[this.data.newKindIndex] || 'holiday',
      year: isNaN(year) ? new Date().getFullYear() : year,
    })
    if (res.error) {
      wx.showToast({ title: res.error.message || '添加失败', icon: 'none' })
      return
    }
    if (!res.data || res.data.length === 0) {
      wx.showToast({ title: '请先登录再维护节假日', icon: 'none' })
      return
    }
    wx.showToast({ title: '已添加', icon: 'success' })
    store.restoreHolidayDay(day) // 保存成功后才取消排除，避免失败时被删的日期自己复活
    this.setData({ newName: '' })
    store.clearHolidayCache()
    this.load()
  },

  /** 恢复内置安排：取消所有本地排除，并把云端缺的日期补回去 */
  async onRestore() {
    const okLogin = await store.ensureOpenid()
    if (!okLogin) {
      wx.showToast({ title: '请先到「我的」页登录', icon: 'none' })
      return
    }
    store.clearExcludedDays()
    const res = await store.seedHolidays(this._dbDays || [])
    if (res.error) {
      wx.showToast({ title: '恢复失败', icon: 'none' })
      return
    }
    wx.showToast({
      title: res.inserted > 0 ? '已恢复 ' + res.inserted + ' 天' : '内置安排已完整',
      icon: 'none',
    })
    store.clearHolidayCache()
    this.load()
  },

  /* ── 编辑 ─────────────────────────────────────────────────────────── */

  onEdit(e) {
    const d = e.currentTarget.dataset
    this.setData({
      editVisible: true,
      editId: d.id || '',
      editDay: d.day,
      editOldDay: d.day,
      editName: d.name || '',
      editKindIndex: d.kind === 'workday' ? 1 : 0,
    })
  },

  onEditDay(e) {
    this.setData({ editDay: e.detail.value })
  },

  onEditName(e) {
    this.setData({ editName: e.detail.value })
  },

  onEditKind(e) {
    this.setData({ editKindIndex: Number(e.detail.value) })
  },

  onEditCancel() {
    this.setData({ editVisible: false })
  },

  /** 弹层内点击统一走这里：截断根节点冒泡，同时补一次订阅额度 */
  noop() {
    subscribe.renew()
  },

  async onEditSave() {
    const name = String(this.data.editName || '').trim()
    if (!name) {
      wx.showToast({ title: '请填写名称', icon: 'none' })
      return
    }
    const okLogin = await store.ensureOpenid()
    if (!okLogin) {
      wx.showToast({ title: '请先到「我的」页登录后再编辑', icon: 'none' })
      return
    }
    const day = this.data.editDay
    const oldDay = this.data.editOldDay
    const res = await store.saveHoliday(
      {
        id: this.data.editId,
        day: day,
        name: name,
        kind: KIND_KEYS[this.data.editKindIndex] || 'holiday',
      },
      oldDay
    )
    if (res.error || !res.data || res.data.length === 0) {
      wx.showToast({ title: '保存失败，请稍后重试', icon: 'none' })
      return
    }
    // 改了日期：旧日期不再由内置表补回；新日期解除排除
    if (oldDay && oldDay !== day) store.excludeHolidayDay(oldDay)
    store.restoreHolidayDay(day)
    wx.showToast({ title: '已保存', icon: 'success' })
    this.setData({ editVisible: false })
    store.clearHolidayCache()
    this.load()
  },

  /* ── 删除 ─────────────────────────────────────────────────────────── */

  onDelete(e) {
    const d = e.currentTarget.dataset
    this.confirmDelete(d.id || '', d.day)
  },

  onLongPress(e) {
    const d = e.currentTarget.dataset
    this.confirmDelete(d.id || '', d.day)
  },

  confirmDelete(id, day) {
    const self = this
    wx.showModal({
      title: '删除节假日',
      content: '确定删除 ' + day + ' 的安排？删除后可在右上角「恢复内置安排」找回。',
      async success(confirm) {
        if (!confirm.confirm) return
        // 删库结果不强求：公共表可能受「仅创建者可删」限制，
        // 本地排除集保证这一条不再显示、也不会被自动回灌补回。
        await store.removeHoliday(id, day)
        store.excludeHolidayDay(day)
        wx.showToast({ title: '已删除', icon: 'success' })
        store.clearHolidayCache()
        self.load()
      },
    })
  },
})
