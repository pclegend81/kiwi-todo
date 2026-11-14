const store = require('../../utils/store')
const core = require('../../utils/reminder-core')
const subscribe = require('../../utils/subscribe')
const i18n = require('../../utils/i18n')
const { onShareAppMessage } = require('../../utils/share')

const app = getApp()
const t = (key, vars) => i18n.t(key, vars)

const KIND_KEYS = ['holiday', 'workday']

function kindNames() {
  return [t('mp_hol_holiday'), t('mp_hol_workday')]
}

/** 星期按当前语言显示（reminder-core 的 weekdayName 是中文，只在展示层换掉，引擎零改动） */
function weekdayOf(day) {
  const d = core.parseDayKey(day)
  if (!d) return ''
  try {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate())
      .toLocaleDateString(i18n.locale(), { weekday: 'short' })
  } catch (e) {
    return core.weekdayName(d)
  }
}

function decorate(rows) {
  return rows.map((row) => ({
    id: row.id,
    day: row.day,
    name: row.name,
    kind: row.kind,
    source: row.source,
    weekday: weekdayOf(row.day),
  }))
}

Page({
  onAnyTap: subscribe.onAnyTap,
  onShareAppMessage: onShareAppMessage,

  data: {
    T: {},
    lang: 'zh-CN',
    region: 'cn',
    regionName: '',
    regionNoteText: '',
    readOnly: false, // 非中国大陆地区：只读展示当地官方节假日，不写公共 holidays 表
    list: [],
    loading: false,
    kindNames: kindNames(),
    newDay: '',
    newName: '',
    newKindIndex: 0,
    minDay: '2027-01-01', // 日期选择器下限 = 有效年份，避免加了却不显示
    missingCount: 0, // 内置表里还没写进云端的天数
    seedYearsText: '',
    maintainedText: '',
    restoreText: '',
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
    this.applyLangTexts()
    const minDay = String(store.MIN_HOLIDAY_YEAR || new Date().getFullYear()) + '-01-01'
    const today = core.dateKey(new Date())
    this.setData({
      // 默认日期落在有效年份内，避免默认选中已结束的 2026
      newDay: today < minDay ? minDay : today,
      minDay: minDay,
    })
    const region = i18n.region()
    const seedYears = Array.from(
      new Set((store.regionSeed(region) || []).map((h) => String(h.day).slice(0, 4)))
    ).sort()
    this.setData({
      seedYearsText: seedYears.length
        ? t('hol_seed_years', { years: seedYears.join('、') })
        : t('hol_seed_default'),
    })
    if (region === 'cn') {
      // 自动清理已结束年份（fire-and-forget，不阻塞首屏）
      store.pruneOldHolidays().catch(() => {})
      // App 启动不会自动登录，而写入（回灌/编辑/删除）都要求身份；
      // 这里静默取一次 openid，否则 seedHolidays 会直接返回 0，页面显示「已维护 0 天」。
      await store.ensureOpenid()
    }
    this.load()
  },

  onShow() {
    // 从「我的」切完语言再回到本页（页面实例还在栈里）时，按新地区重新取表
    const lang = i18n.current()
    const changed = !!this._lastLang && this._lastLang !== lang
    this._lastLang = lang
    this.applyLangTexts()
    if (changed) this.load()
  },

  /** 注入当前语言字典、地区说明与只读标记 */
  applyLangTexts() {
    const region = i18n.region(undefined)
    const readOnly = region !== 'cn'
    i18n.applyPage(this)
    this.setData({
      kindNames: kindNames(),
      readOnly: readOnly,
      regionNoteText: readOnly
        ? t('mp_hol_region_note', { name: i18n.regionName() })
        : t('holiday_from', { name: i18n.regionName() }),
    })
    this.setTexts()
  },

  /** 带数字的文案在 JS 里格式化（WXML 无法给取词函数传参） */
  setTexts() {
    this.setData({
      maintainedText: t('hol_maintained', { n: (this.data.list || []).length }),
      restoreText: this.data.missingCount > 0
        ? t('hol_restore_n', { n: this.data.missingCount })
        : t('mp_hol_restore'),
      seedYearsText: this.data.seedYearsText,
    })
  },

  /** 非中国大陆地区：只读当地官方表，绝不读写云端公共表 */
  guardReadOnly() {
    if (!this.data.readOnly) return false
    wx.showToast({ title: this.data.regionNoteText, icon: 'none', duration: 2200 })
    return true
  },

  /**
   * 显示层以内置种子为骨架：即使数据库为空、未登录或写入失败，
   * 也一定展示有效年份（当前 2027）的完整安排。云端记录按 day 覆盖名称/类型并带真实 id。
   * 回灌只作为后台动作，不再决定列表能不能显示。
   */
  async load(skipSeed) {
    const region = i18n.region()
    if (region !== 'cn') {
      const merged = store.mergeActiveHolidays([], region)
      app.setHolidayMap(core.buildHolidayMap(merged))
      this.setData({ list: decorate(merged), loading: false, missingCount: 0, readOnly: true })
      this.setTexts()
      return
    }
    if (!skipSeed) this.setData({ loading: true })
    const res = await store.listHolidays()
    if (!skipSeed) this.setData({ loading: false })
    const dbRows = store.filterActiveHolidays(res.data || [])
    this._dbDays = dbRows.map((row) => String(row.day).slice(0, 10))
    const merged = store.mergeActiveHolidays(res.data || [], region)

    // 提醒计算也用合并后的表，保证库里为空时节假日顺延依然正确
    app.setHolidayMap(core.buildHolidayMap(merged))

    const known = new Set(this._dbDays)
    const excluded = store.readExcludedDays()
    const missing = (store.SEED_HOLIDAYS || []).filter(
      (h) => !known.has(h.day) && excluded.indexOf(h.day) < 0
    )
    this.setData({ list: decorate(merged), missingCount: missing.length, readOnly: false })
    this.setTexts()

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
    if (this.guardReadOnly()) return
    const name = String(this.data.newName || '').trim()
    if (!name) {
      wx.showToast({ title: t('hol_need_name'), icon: 'none' })
      return
    }
    const okLogin = await store.ensureOpenid()
    if (!okLogin) {
      wx.showToast({ title: t('hol_need_login'), icon: 'none' })
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
      wx.showToast({ title: res.error.message || t('hol_add_fail'), icon: 'none' })
      return
    }
    if (!res.data || res.data.length === 0) {
      wx.showToast({ title: t('hol_need_login2'), icon: 'none' })
      return
    }
    wx.showToast({ title: t('hol_added'), icon: 'success' })
    store.restoreHolidayDay(day) // 保存成功后才取消排除，避免失败时被删的日期自己复活
    this.setData({ newName: '' })
    store.clearHolidayCache()
    this.load()
  },

  /** 恢复内置安排：取消所有本地排除，并把云端缺的日期补回去 */
  async onRestore() {
    if (this.guardReadOnly()) return
    const okLogin = await store.ensureOpenid()
    if (!okLogin) {
      wx.showToast({ title: t('hol_need_login3'), icon: 'none' })
      return
    }
    store.clearExcludedDays()
    const res = await store.seedHolidays(this._dbDays || [])
    if (res.error) {
      wx.showToast({ title: t('hol_restore_fail'), icon: 'none' })
      return
    }
    wx.showToast({
      title: res.inserted > 0
        ? t('hol_restored_n', { n: res.inserted })
        : t('hol_complete'),
      icon: 'none',
    })
    store.clearHolidayCache()
    this.load()
  },

  /* ── 编辑 ─────────────────────────────────────────────────────────── */

  onEdit(e) {
    if (this.guardReadOnly()) return
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
    if (this.guardReadOnly()) return
    const name = String(this.data.editName || '').trim()
    if (!name) {
      wx.showToast({ title: t('hol_need_name'), icon: 'none' })
      return
    }
    const okLogin = await store.ensureOpenid()
    if (!okLogin) {
      wx.showToast({ title: t('hol_need_login_edit'), icon: 'none' })
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
      wx.showToast({ title: t('hol_save_fail'), icon: 'none' })
      return
    }
    // 改了日期：旧日期不再由内置表补回；新日期解除排除
    if (oldDay && oldDay !== day) store.excludeHolidayDay(oldDay)
    store.restoreHolidayDay(day)
    wx.showToast({ title: t('hol_saved'), icon: 'success' })
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
    if (this.guardReadOnly()) return
    const self = this
    wx.showModal({
      title: t('hol_delete_title'),
      content: t('hol_delete_content', { day: day }),
      async success(confirm) {
        if (!confirm.confirm) return
        // 删库结果不强求：公共表可能受「仅创建者可删」限制，
        // 本地排除集保证这一条不再显示、也不会被自动回灌补回。
        await store.removeHoliday(id, day)
        store.excludeHolidayDay(day)
        wx.showToast({ title: t('hol_deleted'), icon: 'success' })
        store.clearHolidayCache()
        self.load()
      },
    })
  },
})
