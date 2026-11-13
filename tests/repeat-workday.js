/**
 * 「每工作日 / 每休息日老待办收不到提醒」回归测试：node tests/repeat-workday.js
 *
 * 根因：estimateIndex() 把 workday 的 n 当成自然日天数，而 nthWorkday(base, n) 的 n 是
 * 第 n 个「工作日」；估算值偏大 → 第一次枚举就越过扫描窗口直接 break → 一条都发不出。
 * 「打卡」是登录时补的示例待办（每工作日 18:01），所以一直收不到；「双十一」是仅一次，不受影响。
 * restday 估算为 0 则会从 base 枚举到 20 条上限被历史占满，游标永远追不上现在。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const core = require('../utils/reminder-core')
const { HOLIDAYS_2027 } = require('../utils/holidays-2027')

let problems = 0
function ok(msg) { console.log('  ✓ ' + msg) }
function bad(msg) { problems++; console.log('  ✗ ' + msg) }
function check(name, fn) {
  try { fn(); ok(name) } catch (e) { bad(name + '：' + e.message) }
}

const MAP = {}
HOLIDAYS_2027.forEach((h) => { MAP[h.day] = h.kind })

function at(y, m, d, h, mi) {
  return new Date(y, m - 1, d, h || 0, mi || 0, 0, 0)
}

function todo(patch) {
  return Object.assign({
    title: '测试',
    remind_at: at(2026, 10, 19, 18, 1).toISOString(),
    repeat_type: 'workday',
    repeat_interval: 1,
    skip_holiday: true,
    holiday_action: 'skip',
    status: 'active',
  }, patch)
}

function days(list) { return list.map((e) => e.atText) }

console.log('每工作日 / 每休息日漏发回归测试')

// 1. 复现「打卡」：pusher 15 分钟窗口里必须能枚举到当天 18:01
const legacy = todo({ title: '打卡' })
const due = core.collectOccurrences(
  legacy,
  at(2026, 11, 12, 18, 0).getTime(),
  at(2026, 11, 12, 18, 16).getTime(),
  {},
  20
)
check('登录补的示例「打卡」在 18:01 窗口内能枚举到一条', () => {
  assert.deepStrictEqual(days(due), ['2026-11-12 18:01'])
  assert.strictEqual(due[0].status, 'sent')
})

// 2. 首页「下次提醒」不能跳到 11/17
check('首页下次提醒是 11/12 18:01，不再跳到 11/17', () => {
  const next = core.nextOccurrence(legacy, at(2026, 11, 12, 12, 0).getTime(), {})
  assert.ok(next)
  assert.strictEqual(next.atText, '2026-11-12 18:01')
})

// 3. 「仅一次」不受影响（双十一能收到的对照组）
check('仅一次待办行为不变（双十一对照组）', () => {
  const once = todo({
    title: '双十一',
    remind_at: at(2026, 11, 11, 9, 0).toISOString(),
    repeat_type: 'none',
  })
  const list = core.collectOccurrences(
    once,
    at(2026, 11, 11, 8, 50).getTime(),
    at(2026, 11, 11, 9, 10).getTime(),
    MAP,
    20
  )
  assert.deepStrictEqual(days(list), ['2026-11-11 09:00'])
})

// 4. 周末不产生工作日提醒
check('每工作日不落在周末', () => {
  const list = core.collectOccurrences(
    legacy,
    at(2026, 11, 14, 0, 0).getTime(),
    at(2026, 11, 15, 23, 59).getTime(),
    {},
    20
  )
  assert.deepStrictEqual(list, [])
})

// 5. 长假让按周折算的估算偏大时，起点回退仍能枚举到节后首个工作日
check('跨 2027 春节长假后仍能枚举到 2/15（节后首个工作日）', () => {
  const t = todo({ remind_at: at(2027, 1, 20, 9, 0).toISOString() })
  const list = core.collectOccurrences(
    t,
    at(2027, 2, 15, 9, 0).getTime(),
    at(2027, 2, 15, 9, 16).getTime(),
    MAP,
    20
  )
  assert.deepStrictEqual(days(list), ['2027-02-15 09:00'])
})

// 6. 长假表里标注的调休补班日照常提醒
check('春节调休补班日（1/31 周日）照常提醒', () => {
  const t = todo({ remind_at: at(2027, 1, 20, 9, 0).toISOString() })
  const list = core.collectOccurrences(
    t,
    at(2027, 1, 31, 9, 0).getTime(),
    at(2027, 1, 31, 9, 16).getTime(),
    MAP,
    20
  )
  assert.deepStrictEqual(days(list), ['2027-01-31 09:00'])
})

// 7. 每休息日：base 很老时不再被 20 条上限截断、游标追不上现在
check('每休息日老待办不会被历史记录占满 20 条上限', () => {
  const t = todo({
    remind_at: at(2025, 1, 1, 9, 0).toISOString(),
    repeat_type: 'restday',
  })
  const list = core.collectOccurrences(
    t,
    at(2026, 11, 14, 9, 0).getTime(),
    at(2026, 11, 14, 9, 16).getTime(),
    {},
    20
  )
  assert.deepStrictEqual(days(list), ['2026-11-14 09:00'])
})

// 8. repeat_interval 对工作日真正生效（此前被 nthWorkday 静默忽略）
check('每 2 个工作日：间隔生效，不再每个工作日都提醒', () => {
  const t = todo({
    remind_at: at(2026, 11, 9, 9, 0).toISOString(),
    repeat_interval: 2,
  })
  const list = core.collectOccurrences(
    t,
    at(2026, 11, 9, 0, 0).getTime(),
    at(2026, 11, 20, 23, 59).getTime(),
    {},
    50
  )
  assert.deepStrictEqual(days(list), [
    '2026-11-09 09:00',
    '2026-11-11 09:00',
    '2026-11-13 09:00',
    '2026-11-17 09:00',
    '2026-11-19 09:00',
  ])
})

// 9. 高频重复（每分钟）在大估算值下仍不漏发
check('每分钟重复的高估算值起点不漏发（17 个整点分钟）', () => {
  const t = todo({
    remind_at: at(2026, 11, 12, 0, 0).toISOString(),
    repeat_type: 'minutely',
  })
  const list = core.collectOccurrences(
    t,
    at(2026, 11, 12, 12, 0).getTime(),
    at(2026, 11, 12, 12, 16).getTime(),
    {},
    200
  )
  assert.strictEqual(list.length, 17)
  assert.strictEqual(list[0].atText, '2026-11-12 12:00')
  assert.strictEqual(list[16].atText, '2026-11-12 12:16')
})

// 10. 三份 reminder-core.js 必须同步
check('小程序端 / pusher / pushapi 三份 reminder-core.js 完全一致', () => {
  const files = [
    'utils/reminder-core.js',
    'cloudfunctions/pusher/reminder-core.js',
    'cloudfunctions/pushapi/reminder-core.js',
  ]
  const sums = files.map((f) =>
    crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, f))).digest('hex')
  )
  assert.strictEqual(sums[0], sums[1])
  assert.strictEqual(sums[1], sums[2])
})

console.log(problems === 0 ? '\n全部通过（10 项）' : '\n失败 ' + problems + ' 项')
if (problems > 0) process.exit(1)
