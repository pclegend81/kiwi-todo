/**
 * 系统日历兜底回归测试（纯 Node，mock 掉 wx 的日历接口）。
 *
 * 守住几个容易写错、且真机上不好排查的点：
 *   1. 时间戳是「秒」不是「毫秒」；
 *   2. 只有「仅一次 / 按天 / 按周 / 按月 / 按年且间隔为 1」可写，其余明确拒绝；
 *   3. month 模式日期不能大于 28 号（微信官方限制）；
 *   4. repeat_start / repeat_end 的换算；
 *   5. writeTodoCalendar 必须**同步**发起 wx API 调用
 *      （官方要求「仅在点击行为时调用」，放到 await 之后就失效）。
 */
const assert = require('assert')

const calls = []
global.wx = {
  addPhoneCalendar(opt) {
    calls.push({ type: 'single', opt: opt })
    if (opt.success) opt.success({})
  },
  addPhoneRepeatCalendar(opt) {
    calls.push({ type: 'repeat', opt: opt })
    if (opt.success) opt.success({})
  },
}

const calendar = require('../utils/calendar')

/** 本地时区构造提醒时间，避免测试机时区差异影响断言 */
function at(y, m, d, h, mi) {
  return new Date(y, m - 1, d, h || 9, mi || 0, 0, 0)
}

function todo(patch) {
  return Object.assign({
    title: '交房租',
    note: '记得转账',
    location: { name: '家里', address: '幸福路 1 号' },
    remind_at: at(2026, 11, 11, 9, 0).toISOString(),
    repeat_type: 'daily',
    repeat_interval: 1,
    repeat_start: '',
    repeat_end: '',
    repeat_dates: [],
    skip_holiday: false,
  }, patch || {})
}

async function main() {
  // 1. 按天重复：映射成 day，时间戳为秒级
  const t1 = todo()
  const i1 = calendar.supportInfo(t1)
  assert.strictEqual(i1.ok, true)
  assert.strictEqual(i1.single, false)
  assert.strictEqual(i1.interval, 'day')
  const o1 = calendar.buildOptions(t1, i1)
  assert.strictEqual(o1.startTime, Math.floor(at(2026, 11, 11, 9, 0).getTime() / 1000), 'startTime 必须是秒')
  assert.strictEqual(o1.repeatInterval, 'day')
  assert.strictEqual(o1.alarm, true)
  assert.strictEqual(o1.alarmOffset, 0)
  assert.ok(o1.endTime > o1.startTime)
  assert.ok(o1.description.indexOf('不会自动删除') >= 0, '必须提示没有删除 API')
  assert.strictEqual(o1.location, '家里')

  // 2. 间隔 > 1 拒绝
  assert.strictEqual(calendar.supportInfo(todo({ repeat_interval: 2 })).ok, false)

  // 3. 每工作日 / 按日历选择 / 按分钟 都拒绝
  ;['workday', 'restday', 'dates', 'hourly', 'minutely'].forEach((type) => {
    assert.strictEqual(calendar.supportInfo(todo({ repeat_type: type })).ok, false, type + ' 不应可写')
  })

  // 4. month 模式日期 > 28 号拒绝，28 号通过
  assert.strictEqual(calendar.supportInfo(todo({ repeat_type: 'monthly', remind_at: at(2026, 10, 29).toISOString() })).ok, false)
  assert.strictEqual(calendar.supportInfo(todo({ repeat_type: 'monthly', remind_at: at(2026, 10, 28).toISOString() })).ok, true)

  // 5. 仅一次：走 addPhoneCalendar，不带任何重复参数
  const i5 = calendar.supportInfo(todo({ repeat_type: 'none' }))
  assert.strictEqual(i5.ok, true)
  assert.strictEqual(i5.single, true)
  const o5 = calendar.buildOptions(todo({ repeat_type: 'none' }), i5)
  assert.ok(!o5.repeatInterval && !o5.repeatEndTime, '单次事件不应带重复参数')

  // 6. repeat_end 转成 repeatEndTime，且晚于开始
  const i6 = calendar.supportInfo(todo({ repeat_end: '2026-12-31' }))
  const o6 = calendar.buildOptions(todo({ repeat_end: '2026-12-31' }), i6)
  assert.ok(o6.repeatEndTime > o6.startTime)
  assert.strictEqual(o6.repeatEndTime, Math.floor(at(2026, 12, 31, 23, 59).getTime() / 1000) + 59)

  // 7. repeat_start 在未来时把起点挪到那天同一时刻
  const i7 = calendar.supportInfo(todo({ repeat_start: '2026-11-20' }))
  assert.strictEqual(i7.startMs, at(2026, 11, 20, 9, 0).getTime())

  // 8. skip_holiday 时如实列出差异
  const i8 = calendar.supportInfo(todo({ skip_holiday: true }))
  assert.ok(i8.warnings.some((w) => w.indexOf('节假日') >= 0))
  assert.ok(i8.warnings.some((w) => w.indexOf('手动删') >= 0))

  // 9. 重复规则走 addPhoneRepeatCalendar，且**同步**发起（不能等 await）
  calls.length = 0
  const p9 = calendar.writeTodoCalendar(t1)
  assert.strictEqual(calls.length, 1, 'wx API 必须在调用当帧同步发起，否则脱离点击手势链')
  assert.strictEqual(calls[0].type, 'repeat')
  const r9 = await p9
  assert.strictEqual(r9.ok, true)
  assert.ok(r9.message.indexOf('不消耗微信额度') >= 0)

  // 10. 单次走 addPhoneCalendar；不支持的类型不碰 wx 接口
  calls.length = 0
  const r10 = await calendar.writeTodoCalendar(todo({ repeat_type: 'none' }))
  assert.strictEqual(r10.ok, true)
  assert.strictEqual(calls[0].type, 'single')
  calls.length = 0
  const r11 = await calendar.writeTodoCalendar(todo({ repeat_type: 'dates' }))
  assert.strictEqual(r11.ok, false)
  assert.strictEqual(calls.length, 0, '不支持的规则不应调用日历接口')

  console.log('系统日历映射测试 10 项通过')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
