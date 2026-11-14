const store = require('../../utils/store')
const core = require('../../utils/reminder-core')
const reminders = require('../../utils/reminders')
const subscribe = require('../../utils/subscribe')
const { onShareAppMessage } = require('../../utils/share')
const i18n = require('../../utils/i18n')
const fmt = require('../../utils/i18n-format')

const t = (key, vars) => i18n.t(key, vars)

const app = getApp()

// 只存字典键，真正的显示名在 applyLangTexts() 里按当前语言生成
const PRIORITY_FILTERS = [
  { key: 'all', labelKey: 'f_all_s' },
  { key: 'high', labelKey: 'prio_high' },
  { key: 'medium', labelKey: 'prio_medium' },
  { key: 'low', labelKey: 'prio_low' },
]

// 苹果日历风格：周日开头。Intl 不可用时用的中性兜底，不放任何语言字样
const WEEK_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

/** 日历表头星期按当前语言显示；不支持 Intl 时用中性兜底 */
function weekLabels() {
  try {
    const out = []
    for (let i = 0; i < 7; i++) {
      out.push(new Date(2024, 0, 7 + i).toLocaleDateString(i18n.locale(), { weekday: 'short' }))
    }
    return out
  } catch (e) { return WEEK_LABELS }
}

/** 'YYYY-MM-DD' -> 'MM-DD'：筛选行胶囊要短，否则一行放不下 */
function shortDate(v) {
  const s = String(v || '')
  return s.length >= 10 ? s.slice(5, 10) : s
}

function hhmmOf(ms) {
  const d = new Date(ms)
  return core.pad2(d.getHours()) + ':' + core.pad2(d.getMinutes())
}

/** 生成某个月的 42 格日历（6 周 × 7 天），含每天的提醒条数 */
function buildMonthGrid(year, month, countMap, selectedKey, todayKey) {
  const first = new Date(year, month, 1)
  const offset = first.getDay() // 0=周日
  const start = new Date(year, month, 1 - offset)
  const days = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    const key = core.dateKey(d)
    days.push({
      key: key,
      day: d.getDate(),
      inMonth: d.getMonth() === month,
      isToday: key === todayKey,
      selected: key === selectedKey,
      count: Number(countMap[key]) || 0,
    })
  }
  return days
}

Page({
  onAnyTap: subscribe.onAnyTap,
  onShareAppMessage: onShareAppMessage,
  data: {
    T: {},
    lang: 'zh-CN',
    totalText: '',
    signedIn: false,
    loading: false,
    logs: [],
    keyword: '',
    total: 0,
    sortMode: 'time',
    priorityFilters: PRIORITY_FILTERS,
    filterPriority: 'all',
    dateFrom: '',
    dateTo: '',
    dateFromText: '',
    dateToText: '',
    timeFrom: '',
    timeTo: '',
    showFilter: false,
    filterText: '',
    // 展示方式：list=列表（默认） / calendar=日历
    viewMode: 'list',
    weekLabels: WEEK_LABELS,
    calTitle: '',
    calDays: [],
    calSelected: '',
    calSelectedText: '',
    dayLogs: [],
    // 已结束的待办（标记完成 / 自然到期）不占待办页，统一在这里看
    finishedItems: [],
  },

  /** 注入当前语言字典 + 星期表头 + 筛选器 + 计数文案 */
  applyLangTexts() {
    i18n.applyPage(this)
    this.setData({
      weekLabels: weekLabels(),
      totalText: t('hist_total', { n: this.data.total || 0 }),
      priorityFilters: PRIORITY_FILTERS.map((f) => ({
        key: f.key,
        name: t(f.labelKey),
      })),
    })
  },

  onShow() {
    this.applyLangTexts()
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 })
      if (typeof this.getTabBar().applyLang === 'function') this.getTabBar().applyLang()
    }
    // 从编辑页回来可能把某条已结束的待办重新激活了，必须重拉一遍
    if (!this._raw || this._needReload || app.globalData.todosDirty) {
      this._needReload = false
      this.reload()
      return
    }
    this.applyView()
  },

  onPullDownRefresh() {
    this.reload().then(() => {
      wx.stopPullDownRefresh()
    })
  },

  async reload() {
    this.setData({ loading: true })
    const { session, error } = await store.getSession()
    if (error || !session) {
      this.setData({ signedIn: false, loading: false, logs: [] })
      return
    }
    this.setData({ signedIn: true })
    const [res, todoRes] = await Promise.all([store.listLogsAll(), store.listTodos()])
    if (res.error) {
      wx.showToast({ title: t('hist_load_fail'), icon: 'none' })
      this.setData({ loading: false })
      return
    }
    this._raw = (res.data || []).map((row) => {
      const d = new Date(row.scheduled_at)
      const ms = isNaN(d.getTime()) ? 0 : d.getTime()
      return {
        id: row.id,
        todoTitle: row.todo_title || '',
        priority: row.todo_priority || 'medium',
        priorityText: fmt.priorityText(row.todo_priority || 'medium'),
        at: ms,
        atText: ms ? core.minuteKey(d) + ' ' + fmt.weekday(d) : '',
        timeText: ms ? core.pad2(d.getHours()) + ':' + core.pad2(d.getMinutes()) : '',
        status: row.status,
        remark: row.remark || '',
      }
    })

    // 两种完成都收进「已完成的待办」：
    //   · 手工确认完成（status === 'done'，用户在待办页点过）
    //   · 默认自动完成（reminders.decorate 判定提醒已发完，新增页没勾「需要手工确认完成」）
    // 统一用 decorate 的 finished 判定，避免两处各写一套规则而漏掉一类。
    let holidayMap = app.globalData.holidayMap || {}
    if (Object.keys(holidayMap).length === 0) {
      const region = i18n.region()
      const cached = store.readHolidayCache()
      const rows = (region === 'cn' && cached && cached.rows) ? cached.rows : []
      holidayMap = core.buildHolidayMap(store.mergeActiveHolidays(rows, region))
    }
    this._finished = (todoRes.data || [])
      .map((t) => reminders.decorate(t, holidayMap))
      .filter((item) => item.finished)
      .map((item) => {
        // 最后一次提醒时间以记录游标为准，旧数据回退到合并前的旧字段
        const lastAt = item.last_logged_at || item.last_reminded_at
        const doneAt = item.done_at ? new Date(item.done_at).getTime() : 0
        const manual = item.status === 'done'
        return {
          id: item.id,
          title: item.title || '',
          repeatText: item.repeatText,
          priority: item.priority,
          priorityText: item.priorityText,
          remindText: item.remindText,
          doneText: manual ? t('manual_tag') : t('fmt_done_auto'),
          // 完整时间放小字行，别塞进胶囊标签：CJK 长文案会把同行的标签挤到换行。
          // 自动完成的没有 done_at，就不显示确认时间。
          doneAtText: manual && !isNaN(doneAt) && doneAt > 0
            ? core.minuteKey(new Date(doneAt))
            : '',
          lastText: lastAt ? core.minuteKey(new Date(lastAt)) : '',
        }
      })

    this.setData({ loading: false })
    this.applyView()
  },

  applyView() {
    const raw = this._raw || []
    const keyword = String(this.data.keyword || '').trim().toLowerCase()
    const list = raw.filter((item) => {
      if (keyword && String(item.todoTitle || '').toLowerCase().indexOf(keyword) < 0) return false
      return this.matchFilter(item)
    })

    if (this.data.sortMode === 'priority') {
      list.sort((a, b) => {
        const diff = core.priorityRank(b.priority) - core.priorityRank(a.priority)
        if (diff !== 0) return diff
        return (b.at || 0) - (a.at || 0)
      })
    } else {
      list.sort((a, b) => (b.at || 0) - (a.at || 0))
    }

    this.setData({ logs: list, total: list.length, totalText: t('hist_total', { n: list.length }) })
    this.updateFilterText(list.length, raw.length)
    this.refreshCalendar(list)

    const finished = (this._finished || []).filter(
      (item) => !keyword || String(item.title || '').toLowerCase().indexOf(keyword) >= 0
    )
    this.setData({ finishedItems: finished })
  },

  /* ── 日历视图 ───────────────────────────────────────────────────────── */

  /** 统计每天有几条提醒（跟随搜索/筛选后的结果），并重绘日历 */
  refreshCalendar(list) {
    const map = {}
    list.forEach((item) => {
      if (!item.at) return
      const key = core.dateKey(new Date(item.at))
      map[key] = (map[key] || 0) + 1
    })
    this._countMap = map
    if (this.data.viewMode !== 'calendar') return

    let year = Number(this.data.calYear) || 0
    let month = Number(this.data.calMonth)
    if (!year) {
      const now = new Date()
      year = now.getFullYear()
      month = now.getMonth()
    }
    let selected = String(this.data.calSelected || '')
    if (!selected) {
      // 默认落在本月：优先今天，其次本月第一条有记录的日期
      const todayKey = core.dateKey(new Date())
      const thisMonth = String(year) + '-' + core.pad2(month + 1)
      if (todayKey.slice(0, 7) === thisMonth) selected = todayKey
      else {
        const hit = list.filter((item) => item.at && core.dateKey(new Date(item.at)).slice(0, 7) === thisMonth)[0]
        selected = hit ? core.dateKey(new Date(hit.at)) : todayKey
      }
    }
    this.renderCalendar(year, month, selected, list, map)
  },

  renderCalendar(year, month, selected, list, countMap) {
    const todayKey = core.dateKey(new Date())
    const days = buildMonthGrid(year, month, countMap || this._countMap || {}, selected, todayKey)
    const dayList = (list || this.data.logs || []).filter((item) => item.at && core.dateKey(new Date(item.at)) === selected)
    dayList.sort((a, b) => (a.at || 0) - (b.at || 0))
    const sel = core.parseDayKey(selected)
    const selDate = sel ? new Date(sel[0], sel[1] - 1, sel[2]) : null
    this.setData({
      calYear: year,
      calMonth: month,
      calTitle: t('ed_cal_month_title', { year: year, month: month + 1 }),
      calDays: days,
      calSelected: selected,
      calSelectedText: selDate
        ? fmt.dateLabel(selDate)
        : selected,
      dayLogs: dayList,
    })
  },

  onViewMode(e) {
    const mode = e.currentTarget.dataset.mode === 'calendar' ? 'calendar' : 'list'
    if (mode === this.data.viewMode) return
    this.setData({ viewMode: mode })
    if (mode === 'calendar') this.refreshCalendar(this.data.logs || [])
  },

  onSelectDay(e) {
    const key = String((e.currentTarget.dataset && e.currentTarget.dataset.date) || '')
    if (!key) return
    this.renderCalendar(Number(this.data.calYear), Number(this.data.calMonth), key, this.data.logs || [])
  },

  onPrevMonth() {
    this.shiftMonth(-1)
  },

  onNextMonth() {
    this.shiftMonth(1)
  },

  shiftMonth(step) {
    let year = Number(this.data.calYear) || new Date().getFullYear()
    let month = (Number(this.data.calMonth) || 0) + step
    if (month < 0) {
      month = 11
      year -= 1
    } else if (month > 11) {
      month = 0
      year += 1
    }
    this.renderCalendar(year, month, this.data.calSelected, this.data.logs || [])
  },

  onToday() {
    const now = new Date()
    this.setData({ calSelected: core.dateKey(now) })
    this.renderCalendar(now.getFullYear(), now.getMonth(), core.dateKey(now), this.data.logs || [])
  },

  matchFilter(item) {
    if (this.data.filterPriority !== 'all' && item.priority !== this.data.filterPriority) return false
    if (!item.at) return !(this.data.dateFrom || this.data.dateTo || this.data.timeFrom || this.data.timeTo)
    const day = core.dateKey(new Date(item.at))
    if (this.data.dateFrom && day < this.data.dateFrom) return false
    if (this.data.dateTo && day > this.data.dateTo) return false
    if (this.data.timeFrom || this.data.timeTo) {
      const t = hhmmOf(item.at)
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
    const unlimited = t('ed_unlimited')
    const parts = []
    if (this.data.filterPriority !== 'all') {
      const hit = (this.data.priorityFilters || []).filter((p) => p.key === this.data.filterPriority)[0]
      parts.push(t('hist_filter_prio', { name: hit ? hit.name : '' }))
    }
    if (this.data.dateFrom || this.data.dateTo) {
      parts.push(t('hist_filter_range', {
        from: this.data.dateFrom || unlimited,
        to: this.data.dateTo || unlimited,
      }))
    }
    if (this.data.timeFrom || this.data.timeTo) {
      parts.push(t('hist_filter_range', {
        from: this.data.timeFrom || unlimited,
        to: this.data.timeTo || unlimited,
      }))
    }
    const text = parts.length
      ? parts.join(t('hist_filter_sep')) + t('hist_filter_count', { shown: shown, total: total })
      : ''
    this.setData({ filterText: text })
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
    this.setData({ dateFrom: e.detail.value, dateFromText: shortDate(e.detail.value) })
    this.applyView()
  },

  onDateTo(e) {
    this.setData({ dateTo: e.detail.value, dateToText: shortDate(e.detail.value) })
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
      dateFromText: '',
      dateToText: '',
      timeFrom: '',
      timeTo: '',
    })
    this.applyView()
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value })
    this.applyView()
  },

  onSearch() {
    this.applyView()
  },

  onClear() {
    this.setData({ keyword: '' })
    this.applyView()
  },

  /** 打开已结束的待办：改完保存会重新回到待办列表（status 置回 active） */
  goEditTodo(e) {
    const id = (e.currentTarget.dataset || {}).id
    if (!id) return
    this._needReload = true
    wx.navigateTo({ url: '/pages/edit/edit?id=' + id })
  },

  /** 点一条提醒记录：顺手补 1 次订阅额度 */
  onLogItem() {
    subscribe.renewWithToast()
  },

  onLongPress(e) {
    const id = e.currentTarget.dataset.id
    const title = e.currentTarget.dataset.title || t('hist_this_record')
    const self = this
    wx.showActionSheet({
      itemList: [t('hist_delete_item')],
      success(res) {
        if (res.tapIndex !== 0) return
        wx.showModal({
          title: t('hist_delete_title'),
          content: t('hist_delete_content', { title: title }),
          async success(confirm) {
            if (!confirm.confirm) return
            const result = await store.removeLog(id)
            if (result.error) {
              wx.showToast({ title: t('hist_delete_fail'), icon: 'none' })
              return
            }
            if (!result.data || result.data.length === 0) {
              wx.showToast({ title: t('hist_delete_no_perm'), icon: 'none' })
              return
            }
            wx.showToast({ title: t('hist_deleted'), icon: 'success' })
            self.reload()
          },
        })
      },
      fail() {},
    })
  },
})
