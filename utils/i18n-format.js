/**
 * 展示层本地化薄封装。
 *
 * reminder-core.js 里有若干返回中文的展示函数（priorityText / weekdayName /
 * describeRepeat / describeRepeatRange / describeRepeatDates / INTERVAL_UNITS），
 * 但那份文件与推送链路共用、零改动，所以这里用 i18n 字典重新实现一遍，
 * 只给页面展示用。所有文案一律走字典，不在本文件里写死中文。
 */
const i18n = require('./i18n')
const core = require('./reminder-core')

const t = (key, vars) => i18n.t(key, vars)

const REPEAT_KEYS = ['none', 'daily', 'hourly', 'minutely', 'weekly', 'monthly', 'yearly', 'workday', 'restday', 'dates']
const ACTION_KEYS = ['skip', 'postpone']
const PRIORITY_KEYS = ['high', 'medium', 'low']

/** core.INTERVAL_UNITS 的 6 个 key -> 基础字典里的单位词条 */
const UNIT_KEYS = {
  daily: 'unit_day',
  weekly: 'unit_week',
  monthly: 'unit_month',
  yearly: 'unit_year',
  hourly: 'unit_hour',
  minutely: 'unit_minute',
}

/** 本地化短星期；环境不支持 Intl 时回落 reminder-core（零改动） */
function weekday(d) {
  try {
    return d.toLocaleDateString(i18n.locale(), { weekday: 'short' })
  } catch (e) {
    return core.weekdayName(d)
  }
}

/** 周一起 7 个本地化短星期标签；异常时用 core 的中文表按周一开头重排 */
function weekHead() {
  try {
    const out = []
    for (let i = 0; i < 7; i++) {
      out.push(new Date(2024, 0, 1 + i).toLocaleDateString(i18n.locale(), { weekday: 'short' }))
    }
    return out
  } catch (e) {
    const w = core.WEEKDAY_NAMES || []
    return [w[1], w[2], w[3], w[4], w[5], w[6], w[0]]
  }
}

/** 本地化「2月11日 周四」形式，供历史页选中日期展示 */
function dateLabel(d) {
  return t('fmt_date_label', {
    month: d.getMonth() + 1,
    day: d.getDate(),
    week: weekday(d),
  })
}

function priorityText(p) {
  return t('prio_' + (p === 'high' || p === 'low' ? p : 'medium'))
}

function repeatNames() {
  return REPEAT_KEYS.map((k) => t('rep_' + k))
}

function actionNames() {
  return ACTION_KEYS.map((k) => t(k === 'postpone' ? 'h_postpone' : 'h_skip'))
}

function priorityNames() {
  return PRIORITY_KEYS.map((k) => t('prio_' + k))
}

/** 本地化的 天/周/个月/年/小时/分钟，对应 core.INTERVAL_UNITS 的 6 个 key */
function intervalUnit(type) {
  return t(UNIT_KEYS[type] || 'unit_day')
}

/** 本地化替换 core.describeRepeat */
function describeRepeat(todo) {
  const interval = Math.max(1, Number(todo.repeat_interval) || 1)
  switch (todo.repeat_type) {
    case 'none':
      return t('rep_none')
    case 'daily':
      return interval === 1 ? t('rep_daily') : t('rep_every', { n: interval, unit: intervalUnit('daily') })
    case 'hourly':
      return interval === 1 ? t('rep_hourly') : t('rep_every', { n: interval, unit: intervalUnit('hourly') })
    case 'minutely':
      return interval === 1 ? t('rep_minutely') : t('rep_every', { n: interval, unit: intervalUnit('minutely') })
    case 'weekly':
      return interval === 1 ? t('rep_weekly') : t('rep_every', { n: interval, unit: intervalUnit('weekly') })
    case 'monthly':
      return interval === 1 ? t('rep_monthly') : t('rep_every', { n: interval, unit: intervalUnit('monthly') })
    case 'yearly':
      return interval === 1 ? t('rep_yearly') : t('rep_every', { n: interval, unit: intervalUnit('yearly') })
    case 'workday':
      return t('rep_workday')
    case 'restday':
      return t('rep_restday')
    case 'dates': {
      const n = core.selectedDates(todo).length
      return n ? t('fmt_dates_n', { n: n }) : t('fmt_dates_empty')
    }
    default:
      return t('rep_none')
  }
}

/** 本地化替换 core.describeRepeatRange；两端都不限返回 '' */
function describeRepeatRange(todo) {
  const r = core.repeatRange(todo)
  if (!r.start && !r.end) return ''
  if (r.start && r.end) return t('fmt_range_both', { start: r.start, end: r.end })
  if (r.start) return t('fmt_range_from', { start: r.start })
  return t('fmt_range_to', { end: r.end })
}

/** 本地化替换 core.describeRepeatDates */
function describeRepeatDates(todo, max) {
  const list = core.selectedDates(todo)
  if (!list.length) return ''
  const lim = max || 3
  const parts = []
  for (let i = 0; i < list.length && i < lim; i++) {
    parts.push(list[i].slice(5).replace('-', '/'))
  }
  return parts.join(t('fmt_date_sep')) + (list.length > lim ? t('fmt_dates_etc', { n: list.length }) : '')
}

module.exports = {
  weekday: weekday,
  weekHead: weekHead,
  dateLabel: dateLabel,
  priorityText: priorityText,
  repeatNames: repeatNames,
  actionNames: actionNames,
  priorityNames: priorityNames,
  intervalUnit: intervalUnit,
  describeRepeat: describeRepeat,
  describeRepeatRange: describeRepeatRange,
  describeRepeatDates: describeRepeatDates,
}
