/**
 * 游标分离回归测试。
 *
 * 用假的 store 顶替数据库写入，验证小程序端补记：
 *   1. 不被推送游标 last_pushed_at 吞掉（旧逻辑下「微信收不到提醒」的根因）
 *   2. 有自己的 last_logged_at 游标，重复同步不会重复补记（首页不再莫名多出几条）
 *   3. 只补最近 2 小时内的到期项，且游标能推进到最近，不会停在半途
 */
const assert = require('assert')
const Module = require('module')

let captured = { logs: [], updates: [] }
const fakeStore = {
  insertLogs(rows) {
    captured.logs = rows
    return Promise.resolve({ data: rows, error: null })
  },
  batchUpdateTodos(items) {
    captured.updates = items
    return Promise.resolve({ updated: items.length, error: null })
  },
}

const originalLoad = Module._load
Module._load = function (request, parent) {
  if (request === './store' && parent && /utils[\\/]reminders\.js$/.test(parent.filename)) {
    return fakeStore
  }
  return originalLoad.apply(this, arguments)
}
const reminders = require('../utils/reminders')
Module._load = originalLoad

const HOUR = 60 * 60 * 1000

function makeTodo(extra) {
  return Object.assign({
    id: 't1',
    title: '测试待办',
    priority: 'medium',
    status: 'active',
    remind_at: new Date(Date.now() - 3 * HOUR).toISOString(),
    repeat_type: 'hourly',
    repeat_interval: 1,
    skip_holiday: false,
    holiday_action: 'skip',
  }, extra || {})
}

async function collect(row) {
  captured = { logs: [], updates: [] }
  const res = await reminders.syncDueReminders([row], {})
  assert.strictEqual(res.error, null, '同步不应报错')
  return { logs: captured.logs, patch: (captured.updates[0] || {}).patch || {} }
}

async function main() {
  const now = Date.now()

  // 1. 只有推送游标、没有记录游标：旧逻辑共用 last_reminded_at，会认为「已提醒」而一条都不补
  const a = await collect(makeTodo({
    last_pushed_at: new Date(now - 10 * 60 * 1000).toISOString(),
  }))
  assert(a.logs.length >= 2, '推送游标不得阻止补记，实际 ' + a.logs.length + ' 条')
  assert(a.patch.last_logged_at, '回写必须含独立的 last_logged_at')

  // 2. 已有记录游标：只补它之后的，数量明显更少
  const b = await collect(makeTodo({
    last_logged_at: new Date(now - 10 * 60 * 1000).toISOString(),
  }))
  assert(b.logs.length < a.logs.length, '记录游标应阻止重复补记')

  // 3. 游标为空且起点在 3 小时前：历史不整批补出来，游标要推进到最近
  const c = await collect(makeTodo({}))
  assert(c.logs.length <= 3, '不应把 3 小时前的历史全部补出来，实际 ' + c.logs.length + ' 条')
  c.logs.forEach((r) => {
    assert(new Date(r.scheduled_at).getTime() >= now - 2 * HOUR - 1000, '记录必须落在 2 小时窗口内')
  })
  assert(c.patch.last_logged_at, '即使只推进也要写游标')
  assert(new Date(c.patch.last_logged_at).getTime() > now - HOUR, '游标应推进到最近，不能停在半途')

  console.log('游标分离测试 3 项通过')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
