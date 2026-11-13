/**
 * 提醒核心逻辑冒烟测试：node tests/smoke.js
 * 覆盖单次 / 每天跳过 / 每天顺延 / 每工作日含调休补班 / 每月月末溢出。
 */
const assert = require('assert')
const core = require('../utils/reminder-core')
const { HOLIDAYS_2026 } = require('../utils/holidays-2026')
const { HOLIDAYS_2027 } = require('../utils/holidays-2027')

const ALL_HOLIDAYS = HOLIDAYS_2026.concat(HOLIDAYS_2027)

const MAP = core.buildHolidayMap(ALL_HOLIDAYS)

function at(y, m, d, hh, mm) {
  return new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0)
}

function todo(opts) {
  return Object.assign(
    {
      remind_at: null,
      repeat_type: 'none',
      repeat_interval: 1,
      skip_holiday: true,
      holiday_action: 'skip',
      title: '测试',
    },
    opts
  )
}

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

console.log('reminder-core 冒烟测试')

check('单次提醒只产生一条', () => {
  const t = todo({ remind_at: at(2026, 3, 10, 9, 0).toISOString() })
  const list = core.collectOccurrences(t, at(2026, 3, 1).getTime(), at(2026, 4, 1).getTime(), MAP, 50)
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].atText, '2026-03-10 09:00')
})

check('每天提醒遇到春节：跳过当日', () => {
  const t = todo({
    remind_at: at(2026, 2, 13, 9, 0).toISOString(),
    repeat_type: 'daily',
    holiday_action: 'skip',
  })
  const list = core.collectOccurrences(
    t,
    at(2026, 2, 13).getTime(),
    at(2026, 2, 25, 23, 59).getTime(),
    MAP,
    50
  )
  const sent = list.filter((x) => x.status === 'sent').map((x) => x.atText.slice(0, 10))
  const skipped = list.filter((x) => x.status === 'skipped').map((x) => x.atText.slice(0, 10))
  assert.deepStrictEqual(sent, ['2026-02-13', '2026-02-14', '2026-02-24', '2026-02-25'])
  assert.strictEqual(skipped.length, 9, '春节 9 天应被跳过')
  assert.strictEqual(skipped[0], '2026-02-15')
})

check('调休补班日照常提醒（不被当节假日）', () => {
  const t = todo({
    remind_at: at(2026, 2, 13, 9, 0).toISOString(),
    repeat_type: 'daily',
    holiday_action: 'skip',
  })
  const list = core.collectOccurrences(t, at(2026, 2, 14).getTime(), at(2026, 2, 14, 23, 59).getTime(), MAP, 50)
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].status, 'sent', '2026-02-14 是调休补班日，应正常提醒')
})

check('每天提醒遇到春节：顺延到节后第一个工作日', () => {
  const t = todo({
    remind_at: at(2026, 2, 13, 9, 0).toISOString(),
    repeat_type: 'daily',
    holiday_action: 'postpone',
  })
  const list = core.collectOccurrences(t, at(2026, 2, 15).getTime(), at(2026, 2, 15, 23, 59).getTime(), MAP, 50)
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].status, 'sent')
  assert.strictEqual(list[0].atText.slice(0, 10), '2026-02-24', '应顺延到 02-24')
})

check('每工作日：跳过周末但保留调休补班日', () => {
  const t = todo({ remind_at: at(2026,10,9,9,0).toISOString(), repeat_type: 'workday' })
  const list = core.collectOccurrences(t, at(2026,10,9).getTime(), at(2026,10,13).getTime(), MAP, 50)
  const days = list.map((x) => x.atText.slice(0,10))
  assert.deepStrictEqual(days, ['2026-10-09', '2026-10-10', '2026-10-12'])
})

check('每休息日：空节假日表下仅落在周末', () => {
  const t = todo({ remind_at: at(2026,10,9,9,0).toISOString(), repeat_type: 'restday' })
  const list = core.collectOccurrences(t, at(2026,10,9).getTime(), at(2026,10,13).getTime(), {}, 50)
  assert.deepStrictEqual(list.map((x) => x.atText.slice(0,10)), ['2026-10-10', '2026-10-11'])
})

check('每休息日：远未来 nextOccurrence 不越界（周一后应为最近周六，不是更远周日）', () => {
  const t = todo({ remind_at: at(2026,10,21,15,0).toISOString(), repeat_type: 'restday' })
  // 10-26 16:00（周一）之后的第一个休息日应为 10-31（周六），而不是 11-01（周日）
  const r = core.nextOccurrence(t, at(2026,10,26,16,0).getTime(), {})
  assert.strictEqual(r.atText.slice(0,10), '2026-10-31')
})

check('每月重复处理月末溢出（1/31 → 2/28 → 3/31）', () => {
  const t = todo({
    remind_at: at(2026, 1, 31, 9, 0).toISOString(),
    repeat_type: 'monthly',
    skip_holiday: false,
  })
  const list = core.collectOccurrences(t, at(2026, 1, 31).getTime(), at(2026, 4, 30).getTime(), MAP, 50)
  assert.deepStrictEqual(list.map((x) => x.atText.slice(0, 10)), ['2026-01-31', '2026-02-28', '2026-03-31'])
})

check('每 2 周重复按 14 天推进', () => {
  const t = todo({
    remind_at: at(2026, 3, 2, 8, 30).toISOString(),
    repeat_type: 'weekly',
    repeat_interval: 2,
    skip_holiday: false,
  })
  const list = core.collectOccurrences(t, at(2026, 3, 2).getTime(), at(2026, 4, 1).getTime(), MAP, 50)
  assert.deepStrictEqual(list.map((x) => x.atText.slice(0, 10)), ['2026-03-02', '2026-03-16', '2026-03-30'])
})

check('关闭节假日跳过时照常提醒', () => {
  const t = todo({
    remind_at: at(2026, 10, 1, 9, 0).toISOString(),
    repeat_type: 'daily',
    skip_holiday: false,
  })
  const list = core.collectOccurrences(
    t,
    at(2026, 10, 1).getTime(),
    at(2026, 10, 3, 23, 59).getTime(),
    MAP,
    50
  )
  assert.strictEqual(list.length, 3)
  assert.ok(list.every((x) => x.status === 'sent'))
})

check('nextOccurrence 返回下一次生效时刻', () => {
  const t = todo({
    remind_at: at(2026, 10, 1, 9, 0).toISOString(),
    repeat_type: 'daily',
    holiday_action: 'skip',
  })
  const next = core.nextOccurrence(t, at(2026, 9, 30).getTime(), MAP)
  assert.strictEqual(next.atText.slice(0, 10), '2026-10-08', '国庆假期后第一个工作日')
})

check('隔 X 小时重复按小时推进', () => {
  const t = todo({
    remind_at: at(2026, 3, 10, 9, 0).toISOString(),
    repeat_type: 'hourly',
    repeat_interval: 4,
    skip_holiday: false,
  })
  const list = core.collectOccurrences(t, at(2026, 3, 10, 9, 0).getTime(), at(2026, 3, 10, 23, 0).getTime(), MAP, 50)
  assert.deepStrictEqual(list.map((x) => x.atText.slice(11)), ['09:00', '13:00', '17:00', '21:00'])
  assert.strictEqual(core.describeRepeat(t), '每 4 小时')
})

check('隔 X 分钟重复按分钟推进', () => {
  const t = todo({
    remind_at: at(2026, 3, 10, 9, 0).toISOString(),
    repeat_type: 'minutely',
    repeat_interval: 30,
    skip_holiday: false,
  })
  const list = core.collectOccurrences(t, at(2026, 3, 10, 9, 0).getTime(), at(2026, 3, 10, 10, 30).getTime(), MAP, 50)
  assert.deepStrictEqual(list.map((x) => x.atText.slice(11)), ['09:00', '09:30', '10:00', '10:30'])
  assert.strictEqual(core.describeRepeat(t), '每 30 分钟')
})

check('隔 X 日重复按天间隔推进', () => {
  const t = todo({
    remind_at: at(2026, 3, 2, 8, 0).toISOString(),
    repeat_type: 'daily',
    repeat_interval: 3,
    skip_holiday: false,
  })
  const list = core.collectOccurrences(t, at(2026, 3, 2).getTime(), at(2026, 3, 15).getTime(), MAP, 50)
  assert.deepStrictEqual(list.map((x) => x.atText.slice(0, 10)), ['2026-03-02', '2026-03-05', '2026-03-08', '2026-03-11', '2026-03-14'])
  assert.strictEqual(core.describeRepeat(t), '每 3 天')
})

check('限定生效日期范围：只产生范围内的提醒', () => {
  const t = todo({
    remind_at: at(2026, 3, 1, 9, 0).toISOString(),
    repeat_type: 'daily',
    repeat_start: '2026-03-02',
    repeat_end: '2026-03-04',
    skip_holiday: false,
  })
  const list = core.collectOccurrences(t, at(2026, 2, 28).getTime(), at(2026, 3, 10).getTime(), MAP, 50)
  assert.deepStrictEqual(list.map((x) => x.atText.slice(0, 10)), ['2026-03-02', '2026-03-03', '2026-03-04'])
})

check('只设开始日期：起点之前不提醒', () => {
  const t = todo({
    remind_at: at(2026, 3, 1, 9, 0).toISOString(),
    repeat_type: 'daily',
    repeat_start: '2026-03-05',
    skip_holiday: false,
  })
  const list = core.collectOccurrences(t, at(2026, 3, 1).getTime(), at(2026, 3, 7, 23, 59).getTime(), MAP, 50)
  assert.deepStrictEqual(list.map((x) => x.atText.slice(0, 10)), ['2026-03-05', '2026-03-06', '2026-03-07'])
})

check('超出生效范围后不再有下一次提醒', () => {
  const t = todo({
    remind_at: at(2026, 3, 1, 9, 0).toISOString(),
    repeat_type: 'daily',
    repeat_end: '2026-03-03',
    skip_holiday: false,
  })
  assert.strictEqual(core.nextOccurrence(t, at(2026, 3, 4).getTime(), MAP), null)
})

check('范围起点在未来时仍能算出首次提醒（不撞枚举守卫）', () => {
  const t = todo({
    remind_at: at(2026, 3, 1, 9, 0).toISOString(),
    repeat_type: 'minutely',
    repeat_interval: 1,
    repeat_start: '2026-03-02',
    repeat_end: '2026-03-02',
    skip_holiday: false,
  })
  const r = core.nextOccurrence(t, at(2026, 3, 1, 9, 0).getTime(), MAP)
  assert.ok(r, '应能找到 2026-03-02 当天的最小提醒')
  assert.strictEqual(r.atText.slice(0, 10), '2026-03-02')
})

check('生效日期范围文案', () => {
  assert.strictEqual(
    core.describeRepeatRange(todo({ repeat_start: '2026-03-02', repeat_end: '2026-03-04' })),
    '2026-03-02 至 2026-03-04'
  )
  assert.strictEqual(core.describeRepeatRange(todo({ repeat_start: '2026-03-02' })), '2026-03-02 起')
  assert.strictEqual(core.describeRepeatRange(todo({ repeat_end: '2026-03-04' })), '至 2026-03-04')
  assert.strictEqual(core.describeRepeatRange(todo({})), '')
})

check('按日历选择：只在选中的那几天提醒，时刻取「提醒时间」', () => {
  const t = todo({
    remind_at: at(2026, 3, 10, 9, 30).toISOString(),
    repeat_type: 'dates',
    repeat_dates: ['2026-03-10', '2026-03-13', '2026-03-20'],
    skip_holiday: false,
  })
  const list = core.collectOccurrences(t, at(2026, 3, 1).getTime(), at(2026, 4, 1).getTime(), MAP, 50)
  assert.deepStrictEqual(list.map((x) => x.atText), [
    '2026-03-10 09:30',
    '2026-03-13 09:30',
    '2026-03-20 09:30',
  ])
})

check('按日历选择：清单去重升序、非法值丢弃', () => {
  const t = todo({
    remind_at: at(2026, 3, 10, 9, 0).toISOString(),
    repeat_type: 'dates',
    repeat_dates: ['2026-03-20', '2026-03-10', '2026-03-20', 'bad', '', '2026-03-13'],
    skip_holiday: false,
  })
  assert.deepStrictEqual(core.selectedDates(t), ['2026-03-10', '2026-03-13', '2026-03-20'])
  assert.strictEqual(core.describeRepeat(t), '指定 3 天')
  assert.strictEqual(core.describeRepeatDates(t, 3), '03/10、03/13、03/20')
  assert.strictEqual(core.describeRepeatDates(t, 2), '03/10、03/13 等 3 天')
})

check('按日历选择：清单过完后不再有下一次提醒', () => {
  const t = todo({
    remind_at: at(2026, 3, 10, 9, 0).toISOString(),
    repeat_type: 'dates',
    repeat_dates: ['2026-03-10', '2026-03-13'],
    skip_holiday: false,
  })
  assert.strictEqual(core.nextOccurrence(t, at(2026, 3, 12).getTime(), MAP).atText, '2026-03-13 09:00')
  assert.strictEqual(core.nextOccurrence(t, at(2026, 3, 14).getTime(), MAP), null)
})

check('按日历选择：选中的日子撞上法定节假日按策略跳过/顺延', () => {
  const skip = todo({
    remind_at: at(2026, 10, 1, 9, 0).toISOString(),
    repeat_type: 'dates',
    repeat_dates: ['2026-10-01', '2026-10-08'],
    skip_holiday: true,
    holiday_action: 'skip',
  })
  const list = core.collectOccurrences(skip, at(2026, 9, 30).getTime(), at(2026, 10, 20).getTime(), MAP, 50)
  assert.deepStrictEqual(list.map((x) => x.status), ['skipped', 'sent'])

  const postpone = todo({
    remind_at: at(2026, 10, 1, 9, 0).toISOString(),
    repeat_type: 'dates',
    repeat_dates: ['2026-10-01', '2026-10-08'],
    skip_holiday: true,
    holiday_action: 'postpone',
  })
  const r = core.nextOccurrence(postpone, at(2026, 10, 1).getTime(), MAP)
  assert.strictEqual(r.atText, '2026-10-08 09:00', '10-01~10-07 都是假期，应顺延到 10-08')
})

check('按日历选择：空清单不产生任何提醒', () => {
  const t = todo({
    remind_at: at(2026, 3, 10, 9, 0).toISOString(),
    repeat_type: 'dates',
    repeat_dates: [],
    skip_holiday: false,
  })
  assert.deepStrictEqual(core.collectOccurrences(t, at(2026, 3, 1).getTime(), at(2026, 4, 1).getTime(), MAP, 50), [])
  assert.strictEqual(core.nextOccurrence(t, at(2026, 3, 1).getTime(), MAP), null)
  assert.strictEqual(core.describeRepeat(t), '指定日期（未选）')
})

check('优先级排序权重：高 > 中 > 低', () => {
  assert.ok(core.priorityRank('high') > core.priorityRank('medium'))
  assert.ok(core.priorityRank('medium') > core.priorityRank('low'))
  assert.strictEqual(core.priorityText('high'), '高')
  assert.strictEqual(core.priorityText('low'), '低')
  assert.strictEqual(core.priorityText(undefined), '中', '未知值按中处理')
})

check('内置节假日表数据结构正确（2026 + 2027）', () => {
  assert.strictEqual(HOLIDAYS_2026.length, 39)
  assert.strictEqual(HOLIDAYS_2026.filter((h) => h.kind === 'holiday').length, 33)
  assert.strictEqual(HOLIDAYS_2026.filter((h) => h.kind === 'workday').length, 6)
  assert.strictEqual(HOLIDAYS_2027.length, 34, '2027：29 天假期 + 5 天调休补班')
  assert.strictEqual(HOLIDAYS_2027.filter((h) => h.kind === 'holiday').length, 29)
  assert.strictEqual(HOLIDAYS_2027.filter((h) => h.kind === 'workday').length, 5)
  const days = ALL_HOLIDAYS.map((h) => h.day)
  assert.strictEqual(new Set(days).size, days.length, '日期不应重复')
  // 2027 关键锚点（国办发明电〔2026〕10号）
  assert.strictEqual(MAP['2027-01-02'], 'holiday', '元旦 1/3 天')
  assert.strictEqual(MAP['2027-01-31'], 'workday', '春节调休补班 1/31 周日')
  assert.strictEqual(MAP['2027-02-06'], 'holiday', '春节假期含周末 2/6')
  assert.strictEqual(MAP['2027-02-14'], 'workday', '春节调休补班 2/14 周日')
  assert.strictEqual(MAP['2027-05-08'], 'workday', '劳动节调休补班 5/8 周六')
  assert.strictEqual(MAP['2027-06-09'], 'holiday', '端午单天 6/9')
  assert.strictEqual(MAP['2027-09-26'], 'workday', '国庆调休补班 9/26 周日')
  assert.strictEqual(MAP['2027-10-09'], 'workday', '国庆调休补班 10/9 周六')
})

check('北京时间格式化：云函数 UTC 环境不偏 8 小时', () => {
  // 用 Date.UTC 构造 epoch，测试本身不依赖运行环境的时区
  const a = core.beijingKey(Date.UTC(2026, 10, 9, 3, 13))
  assert.strictEqual(a.date, '2026-11-09')
  assert.strictEqual(a.time, '11:13', 'UTC 03:13 应显示北京时间 11:13')
  assert.strictEqual(a.datetime, '2026-11-09 11:13')
  // 跨日：UTC 17:00 → 次日 01:00，日期也要跟着进位
  const b = core.beijingKey(Date.UTC(2026, 10, 9, 17, 0))
  assert.strictEqual(b.date, '2026-11-10')
  assert.strictEqual(b.time, '01:00')
})

console.log('\n全部 ' + passed + ' 项通过')
