/**
 * 提醒核心逻辑：周期推进、中国大陆节假日跳过、到期时刻枚举。
 * 同一份文件同时被小程序（utils/）和推送服务（server/）使用，
 * 修改时必须同步两边，否则小程序内展示与真实推送会不一致。
 */

var REPEAT_TYPES = ['none', 'daily', 'weekly', 'monthly', 'yearly', 'workday', 'restday', 'hourly', 'minutely', 'dates']

/** 需要「间隔设置」的重复方式，以及各自的间隔单位文案 */
var INTERVAL_UNITS = {
  daily: '天',
  weekly: '周',
  monthly: '个月',
  yearly: '年',
  hourly: '小时',
  minutely: '分钟',
}

var WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 优先级：low / medium / high，排序权重高 > 中 > 低 */
var PRIORITIES = ['high', 'medium', 'low']
var PRIORITY_TEXT = { high: '高', medium: '中', low: '低' }

/** 排序权重，数字越大越靠前；未知值按「中」处理 */
function priorityRank(priority) {
  switch (priority) {
    case 'high':
      return 3
    case 'medium':
      return 2
    case 'low':
      return 1
    default:
      return 2
  }
}

function priorityText(priority) {
  return PRIORITY_TEXT[priority] || '中'
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

/** Date -> 'YYYY-MM-DD'（本地时区） */
function dateKey(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

/** Date -> 'YYYY-MM-DD HH:mm'（本地时区） */
function minuteKey(d) {
  return dateKey(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

/**
 * epoch 毫秒 -> 北京时间（UTC+8）的日期/时间/完整时刻。
 *
 * 云函数运行环境是 UTC，而本文件所有日期运算都基于「运行环境的本地时区」，
 * 因此云端必须设置 TZ=Asia/Shanghai（见两个云函数头部）；这个函数额外用
 * UTC getter 显式 +8，不依赖运行环境时区，专门给订阅消息里的时间字段用，
 * 即使 TZ 未生效也不会把 11:13 显示成 03:13。
 */
var BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
function beijingKey(atMs) {
  var d = new Date(Number(atMs) + BEIJING_OFFSET_MS)
  var date = d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
  var time = pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes())
  return { date: date, time: time, datetime: date + ' ' + time }
}

/** 'YYYY-MM-DD' -> Date（本地零点） */
function parseDayKey(key) {
  var p = String(key || '').split('-')
  if (p.length !== 3) return null
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 0, 0, 0, 0)
}

function weekdayName(d) {
  return WEEKDAY_NAMES[d.getDay()]
}

/**
 * 节假日表 -> { '2026-01-01': 'holiday', '2026-01-04': 'workday' }
 * @param {Array<{day:string, kind:string}>} list
 */
function buildHolidayMap(list) {
  var map = {}
  var arr = list || []
  for (var i = 0; i < arr.length; i++) {
    var row = arr[i]
    var key = typeof row.day === 'string' ? row.day.slice(0, 10) : row.day
    if (key) map[key] = row.kind === 'workday' ? 'workday' : 'holiday'
  }
  return map
}

function dayKind(key, holidayMap) {
  return holidayMap[key] || ''
}

/** 法定放假日（含周末连休） */
function isHoliday(key, holidayMap) {
  return dayKind(key, holidayMap) === 'holiday'
}

/** 调休补班日：周末但要上班 */
function isMakeupWorkday(key, holidayMap) {
  return dayKind(key, holidayMap) === 'workday'
}

/**
 * 实际需要上班的日子：周一至周五且非法定假日，或调休补班日。
 * 这是「顺延」和「每工作日」两种策略共同的判定基准。
 */
function isEffectiveWorkday(d, holidayMap) {
  var key = dateKey(d)
  if (isHoliday(key, holidayMap)) return false
  if (isMakeupWorkday(key, holidayMap)) return true
  var wd = d.getDay()
  return wd >= 1 && wd <= 5
}

function addMonths(d, months) {
  var day = d.getDate()
  var n = new Date(d.getFullYear(), d.getMonth() + months, 1, d.getHours(), d.getMinutes(), d.getSeconds(), 0)
  var lastDay = new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate()
  n.setDate(Math.min(day, lastDay))
  return n
}

function addYears(d, years) {
  var day = d.getDate()
  var n = new Date(d.getFullYear() + years, d.getMonth(), 1, d.getHours(), d.getMinutes(), d.getSeconds(), 0)
  var lastDay = new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate()
  n.setDate(Math.min(day, lastDay))
  return n
}

function nextWorkdayFrom(d, holidayMap) {
  var n = new Date(d.getTime())
  n.setDate(n.getDate() + 1)
  var guard = 0
  while (!isEffectiveWorkday(n, holidayMap) && guard < 400) {
    n.setDate(n.getDate() + 1)
    guard++
  }
  return n
}

function addDays(d, days) {
  var n = new Date(d.getTime())
  n.setDate(n.getDate() + days)
  return n
}

function addHours(d, hours) {
  return new Date(d.getTime() + hours * 3600000)
}

function addMinutes(d, minutes) {
  return new Date(d.getTime() + minutes * 60000)
}

function nthWorkday(base, n, holidayMap) {
  var d = new Date(base.getTime())
  var guard = 0
  while (!isEffectiveWorkday(d, holidayMap) && guard < 400) {
    d = addDays(d, 1)
    guard++
  }
  for (var i = 0; i < n; i++) {
    d = nextWorkdayFrom(d, holidayMap)
  }
  return d
}

function nextRestdayFrom(d, holidayMap) {
  var n = new Date(d.getTime())
  n.setDate(n.getDate() + 1)
  var guard = 0
  while (isEffectiveWorkday(n, holidayMap) && guard < 400) {
    n.setDate(n.getDate() + 1)
    guard++
  }
  return n
}

function nthRestday(base, n, holidayMap) {
  var d = new Date(base.getTime())
  var guard = 0
  while (isEffectiveWorkday(d, holidayMap) && guard < 400) {
    d = addDays(d, 1)
    guard++
  }
  for (var i = 0; i < n; i++) {
    d = nextRestdayFrom(d, holidayMap)
  }
  return d
}

/**
 * 第 n 次（从 0 开始）周期时刻。必须始终基于起始日 base 计算，
 * 不能拿上一次结果继续推进 —— 否则「每月 31 日」溢出到 2/28 后
 * 会固化成 28 日，再也回不到 31 日。
 */
/**
 * 重复的「生效日期范围」：repeat_start / repeat_end，格式 'YYYY-MM-DD'。
 * 空串表示该端不限。用于「只在几号到几号之间重复提醒」。
 */
function repeatRange(todo) {
  var start = typeof todo.repeat_start === 'string' ? todo.repeat_start.slice(0, 10) : ''
  var end = typeof todo.repeat_end === 'string' ? todo.repeat_end.slice(0, 10) : ''
  if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) start = ''
  if (end && !/^\d{4}-\d{2}-\d{2}$/.test(end)) end = ''
  return { start: start, end: end }
}

/** 范围起点的毫秒值（当天 00:00），无起点返回 0 */
function rangeStartMs(todo) {
  var r = repeatRange(todo)
  if (!r.start) return 0
  var d = parseDayKey(r.start)
  return d && !isNaN(d.getTime()) ? d.getTime() : 0
}

/** 范围终点的毫秒上界（当天 23:59:59.999），无终点返回 0 */
function rangeEndMs(todo) {
  var r = repeatRange(todo)
  if (!r.end) return 0
  var d = parseDayKey(r.end)
  return d && !isNaN(d.getTime()) ? d.getTime() + 86400000 - 1 : 0
}

/** 该时刻是否落在生效范围内（按自然日比较，含首尾两天） */
function inRepeatRange(d, todo) {
  var r = repeatRange(todo)
  if (!r.start && !r.end) return true
  var key = dateKey(d)
  if (r.start && key < r.start) return false
  if (r.end && key > r.end) return false
  return true
}

/**
 * 「按日历选择」的日期清单：todo.repeat_dates = ['YYYY-MM-DD', ...]。
 * 校验 + 去重 + 升序；非法值直接丢弃，空清单返回空数组。
 */
function selectedDates(todo) {
  var raw = todo && Array.isArray(todo.repeat_dates) ? todo.repeat_dates : []
  var seen = {}
  var out = []
  for (var i = 0; i < raw.length; i++) {
    var key = String(raw[i] || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
    if (seen[key]) continue
    seen[key] = 1
    out.push(key)
  }
  out.sort()
  return out
}

/**
 * 第 n 个选中日期对应的时刻：日期取自清单，时分取自 remind_at。
 * 清单是有限的，n 越界返回 null —— 枚举方靠它自然终止。
 */
function nthSelectedDate(base, todo, n) {
  var list = selectedDates(todo)
  if (n < 0 || n >= list.length) return null
  var d = parseDayKey(list[n])
  if (!d || isNaN(d.getTime())) return null
  d.setHours(base.getHours(), base.getMinutes(), 0, 0)
  return d
}

function nthOccurrence(base, todo, n, holidayMap) {
  var interval = Math.max(1, Number(todo.repeat_interval) || 1)
  switch (todo.repeat_type) {
    case 'dates':
      return nthSelectedDate(base, todo, n)
    case 'daily':
      return addDays(base, n * interval)
    case 'weekly':
      return addDays(base, n * 7 * interval)
    case 'monthly':
      return addMonths(base, n * interval)
    case 'yearly':
      return addYears(base, n * interval)
    case 'workday':
      return nthWorkday(base, n * interval, holidayMap)
    case 'restday':
      return nthRestday(base, n * interval, holidayMap)
    case 'hourly':
      return addHours(base, n * interval)
    case 'minutely':
      return addMinutes(base, n * interval)
    default:
      return n === 0 ? new Date(base.getTime()) : null
  }
}

/**
 * 估算「第 n 次时刻已到达 afterMs」时 n 的下界，避免从 0 开始空转。
 * 取值偏保守，宁可小一点也不越过目标。
 */
function estimateIndex(base, todo, afterMs) {
  var diff = afterMs - base.getTime()
  if (diff <= 0) return 0
  var day = 86400000
  var interval = Math.max(1, Number(todo.repeat_interval) || 1)
  switch (todo.repeat_type) {
    // 日期清单是有穷的，从 0 开始枚举即可（n 越界会拿到 null 自然终止）
    case 'dates':
      return 0
    case 'daily':
      return Math.floor(diff / (day * interval))
    case 'weekly':
      return Math.floor(diff / (7 * day * interval))
    case 'monthly':
      return Math.floor(diff / (28 * day * interval))
    case 'yearly':
      return Math.floor(diff / (365 * day * interval))
    // 「第 n 次」在工作日/休息日里是第 n 个有效日，不是第 n 个自然日。
    // 按每周 5 / 2 天折算成下界，再除以间隔（nthOccurrence 里会乘回去）。
    case 'workday':
      return Math.floor(diff / day * 5 / 7 / interval)
    case 'restday':
      return Math.floor(diff / day * 2 / 7 / interval)
    case 'hourly':
      return Math.floor(diff / (3600000 * interval))
    case 'minutely':
      return Math.floor(diff / (60000 * interval))
    default:
      return 0
  }
}

/**
 * 找枚举起点：estimateIndex 只是估算，每工作日 / 休息日遇长假时实际有效日数
 * 会明显少于按周折算的数量，估算值反而偏大 —— 第一次枚举就越过上界会直接
 * break，这类待办从此一条提醒都发不出（「打卡」漏发即此因）。
 * 往回退到「第 n 次时刻 <= probeMs」，再多留 2 个周期做补偿。
 */
function findStartIndex(base, todo, probeMs, holidayMap) {
  var n = Math.max(0, estimateIndex(base, todo, probeMs))
  var guard = 0
  while (n > 0 && guard < 60) {
    var raw = nthOccurrence(base, todo, n, holidayMap)
    if (!raw || raw.getTime() <= probeMs) break
    n--
    guard++
  }
  return Math.max(0, n - 2)
}

/**
 * 应用节假日策略，把一个原始时刻调整为真正生效的时刻。
 * @returns {{time:Date, status:string, reason:string}|null}
 *   status: 'due' 正常提醒 / 'skipped_holiday' 节假日跳过 / null 表示无有效时刻
 */
function applyHolidayPolicy(raw, todo, holidayMap) {
  // 每休息日：本身就是「周末 + 法定假日、剔除调休补班」，节假日已内含，不再额外跳过 / 顺延
  if (todo.repeat_type === 'restday') {
    return { time: raw, status: 'due', reason: '' }
  }
  var key = dateKey(raw)
  var isOff = isHoliday(key, holidayMap)

  // 每工作日模式：本身已经按工作日推进，仍可能被临时标注为放假日
  if (todo.repeat_type === 'workday' && isOff) {
    if (todo.skip_holiday && todo.holiday_action === 'postpone') {
      var moved = nextWorkdayFrom(raw, holidayMap)
      return { time: moved, status: 'due', reason: '因节假日顺延至 ' + dateKey(moved) }
    }
    if (todo.skip_holiday) {
      return { time: raw, status: 'skipped_holiday', reason: '节假日跳过' }
    }
  }

  if (!isOff || !todo.skip_holiday) {
    return { time: raw, status: 'due', reason: '' }
  }

  if (todo.holiday_action === 'postpone') {
    var moved2 = new Date(raw.getTime())
    var guard = 0
    while (!isEffectiveWorkday(moved2, holidayMap) && guard < 400) {
      moved2.setDate(moved2.getDate() + 1)
      guard++
    }
    return { time: moved2, status: 'due', reason: '节假日顺延至 ' + dateKey(moved2) }
  }

  return { time: raw, status: 'skipped_holiday', reason: '节假日跳过（' + holidayNameOf(key, holidayMap) + '）' }
}

function holidayNameOf(key, holidayMap) {
  return holidayMap[key] === 'holiday' ? '法定节假日' : '非工作日'
}

/**
 * 枚举 [fromMs, toMs] 区间内所有应产生的提醒事件（含被跳过的），
 * 用于小程序端补写历史提醒记录。
 * @returns {Array<{at:number, atText:string, status:string, reason:string}>}
 */
function collectOccurrences(todo, fromMs, toMs, holidayMap, limit) {
  var out = []
  if (!todo || !todo.remind_at) return out
  var max = limit || 100
  var base = new Date(todo.remind_at)
  if (isNaN(base.getTime())) return out

  var endMs = rangeEndMs(todo)
  var startMs = rangeStartMs(todo)
  // 范围整体早于查询区间时直接跳过枚举，避免从 0 空转几千次
  var probe = startMs > fromMs ? startMs : fromMs
  var n = findStartIndex(base, todo, probe, holidayMap)
  var guard = 0
  while (guard < 6000) {
    guard++
    var raw = nthOccurrence(base, todo, n, holidayMap)
    if (!raw) break
    if (endMs && raw.getTime() > endMs) break
    if (raw.getTime() > toMs) break
    if (raw.getTime() >= fromMs && inRepeatRange(raw, todo)) {
      var applied = applyHolidayPolicy(raw, todo, holidayMap)
      if (applied) {
        out.push({
          at: applied.time.getTime(),
          atText: minuteKey(applied.time),
          status: applied.status === 'skipped_holiday' ? 'skipped' : 'sent',
          reason: applied.reason || '',
        })
        if (out.length >= max) break
      }
    }
    if (todo.repeat_type === 'none') break
    n++
  }
  return out
}

/**
 * 计算下一次提醒时刻（用于列表展示与推送服务调度）。
 * @returns {{at:number, atText:string, skipped:boolean, reason:string}|null}
 */
function nextOccurrence(todo, afterMs, holidayMap) {
  var base = new Date(todo.remind_at)
  if (isNaN(base.getTime())) return null

  var endMs = rangeEndMs(todo)
  var startMs = rangeStartMs(todo)
  if (endMs && afterMs > endMs) return null
  // 范围起点在未来时，直接从起点附近开始枚举，否则「每分钟 + 远期起点」会撞上 6000 次守卫
  var probe = startMs > afterMs ? startMs : afterMs
  var n = findStartIndex(base, todo, probe, holidayMap)
  var guard = 0
  while (guard < 6000) {
    guard++
    var raw = nthOccurrence(base, todo, n, holidayMap)
    if (!raw) return null
    if (endMs && raw.getTime() > endMs) return null
    if (raw.getTime() >= afterMs && inRepeatRange(raw, todo)) {
      var applied = applyHolidayPolicy(raw, todo, holidayMap)
      if (applied && applied.status === 'due') {
        return { at: applied.time.getTime(), atText: minuteKey(applied.time), skipped: false, reason: applied.reason }
      }
    }
    if (todo.repeat_type === 'none') return null
    n++
  }
  return null
}

function describeRepeat(todo) {
  var interval = Math.max(1, Number(todo.repeat_interval) || 1)
  switch (todo.repeat_type) {
    case 'none':
      return '仅一次'
    case 'daily':
      return interval === 1 ? '每天' : '每 ' + interval + ' 天'
    case 'weekly':
      return interval === 1 ? '每周' : '每 ' + interval + ' 周'
    case 'monthly':
      return interval === 1 ? '每月' : '每 ' + interval + ' 个月'
    case 'yearly':
      return interval === 1 ? '每年' : '每 ' + interval + ' 年'
    case 'workday':
      return '每工作日'
    case 'restday':
      return '每休息日'
    case 'hourly':
      return interval === 1 ? '每小时' : '每 ' + interval + ' 小时'
    case 'minutely':
      return interval === 1 ? '每分钟' : '每 ' + interval + ' 分钟'
    case 'dates': {
      var n = selectedDates(todo).length
      return n ? '指定 ' + n + ' 天' : '指定日期（未选）'
    }
    default:
      return '仅一次'
  }
}

/** 「按日历选择」的具体日期清单文案，超过 max 个用「等 N 天」收尾 */
function describeRepeatDates(todo, max) {
  var list = selectedDates(todo)
  if (!list.length) return ''
  var lim = max || 3
  var parts = []
  for (var i = 0; i < list.length && i < lim; i++) {
    parts.push(list[i].slice(5).replace('-', '/'))
  }
  return parts.join('、') + (list.length > lim ? ' 等 ' + list.length + ' 天' : '')
}

/** 生效日期范围的可读文案；两端都不限时返回空串 */
function describeRepeatRange(todo) {
  var r = repeatRange(todo)
  if (!r.start && !r.end) return ''
  if (r.start && r.end) return r.start + ' 至 ' + r.end
  if (r.start) return r.start + ' 起'
  return '至 ' + r.end
}

module.exports = {
  REPEAT_TYPES: REPEAT_TYPES,
  INTERVAL_UNITS: INTERVAL_UNITS,
  PRIORITIES: PRIORITIES,
  priorityRank: priorityRank,
  priorityText: priorityText,
  WEEKDAY_NAMES: WEEKDAY_NAMES,
  pad2: pad2,
  dateKey: dateKey,
  minuteKey: minuteKey,
  beijingKey: beijingKey,
  parseDayKey: parseDayKey,
  weekdayName: weekdayName,
  buildHolidayMap: buildHolidayMap,
  isHoliday: isHoliday,
  isMakeupWorkday: isMakeupWorkday,
  isEffectiveWorkday: isEffectiveWorkday,
  collectOccurrences: collectOccurrences,
  nextOccurrence: nextOccurrence,
  describeRepeat: describeRepeat,
  describeRepeatDates: describeRepeatDates,
  selectedDates: selectedDates,
  repeatRange: repeatRange,
  inRepeatRange: inRepeatRange,
  describeRepeatRange: describeRepeatRange,
}
