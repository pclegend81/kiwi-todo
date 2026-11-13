/**
 * 「完成方式可配置」回归测试（纯 Node）：
 *   node tests/manual-done.js
 *
 * 需求演进：
 *   - 早期：展示层 `item.finished = !next`，把「没有下一次提醒」当成「已完成」，
 *     单次待办一到点就从首页消失并跑进提醒记录，事情其实还没干。
 *   - 上一版：改成全局「必须手工确认完成」，所有到点待办都留在首页标「待确认完成」。
 *   - 本版（当前）：新增页给每条待办一个开关 `manual_done`，**默认关闭**。
 *       默认（false / 老数据无字段）：提醒发完就自动完成并归档；
 *       打开（true）：到点仍留在待办页标「待确认完成」，必须点「确认做完了」。
 *
 * 覆盖：
 *   1. decorate：两种模式的完成 / 待确认判定，含单次 / dates / repeat_end / 每天重复；
 *   2. 首页：按 finished 过滤、待确认项置顶与计数、确认入口不被破坏；
 *   3. 提醒记录页：手工完成 + 自动完成都收，标签区分，不再有「已自然结束」；
 *   4. 编辑页：开关默认关、写入 manual_done、编辑回显；
 *   5. 协作：两份 SHARE_FIELDS 白名单都带上 manual_done。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const Module = require('module')

const ROOT = path.join(__dirname, '..')
let problems = 0

function ok(msg) { console.log('  ✓ ' + msg) }
function bad(msg) { problems++; console.log('  ✗ ' + msg) }
function check(name, fn) {
  try { fn(); ok(name) } catch (e) { bad(name + '：' + e.message) }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8') }

/* utils/reminders.js 会 require('./store')，而 store 在 Node 下依赖 wx / 云开发 SDK。
   decorate 本身用不到 store，替换成空壳即可。 */
const originalLoad = Module._load
Module._load = function (request, parent) {
  if (request === './store' && parent && /reminders\.js$/.test(parent.filename || '')) {
    return { insertLogs: async () => ({ data: [] }), batchUpdateTodos: async () => ({}) }
  }
  return originalLoad.apply(this, arguments)
}
const reminders = require('../utils/reminders')
Module._load = originalLoad

const NOW = Date.parse('2026-11-12T12:00:00+08:00')
function todo(over) {
  return Object.assign({
    id: 't1',
    title: '双十一',
    remind_at: '2026-11-10T09:00:00+08:00',
    repeat_type: 'none',
    repeat_interval: 1,
    skip_holiday: false,
    holiday_action: 'skip',
    priority: 'medium',
    status: 'active',
  }, over || {})
}
function deco(over) { return reminders.decorate(todo(over), {}, NOW) }

async function main() {
  console.log('完成方式可配置 · 回归测试')

  /* ── 1. 默认模式：提醒发完自动完成 ───────────────────────────────── */

  check('默认（manual_done 缺失）单次提醒已过 → 自动完成、不待确认', () => {
    const item = deco()
    assert.strictEqual(item.manualDone, false)
    assert.strictEqual(item.finished, true)
    assert.strictEqual(item.needDone, false)
    assert.strictEqual(item.nextText, '')
  })

  check('老数据 manual_done=false 与字段缺失行为一致', () => {
    const a = deco()
    const b = deco({ manual_done: false })
    assert.strictEqual(a.finished, b.finished)
    assert.strictEqual(a.needDone, b.needDone)
  })

  check('默认模式下按日历选的日期过完 → 自动完成', () => {
    const item = deco({ repeat_type: 'dates', repeat_dates: ['2026-11-10'] })
    assert.strictEqual(item.finished, true)
    assert.strictEqual(item.needDone, false)
  })

  check('默认模式下超出生效范围 → 自动完成', () => {
    const item = deco({ repeat_type: 'daily', repeat_end: '2026-11-11' })
    assert.strictEqual(item.finished, true)
    assert.strictEqual(item.needDone, false)
  })

  check('还没到点的单次提醒 → 任何模式都不完成、不待确认', () => {
    const future = { remind_at: '2026-11-13T09:00:00+08:00' }
    for (const manual of [undefined, false, true]) {
      const item = deco(Object.assign({}, future, { manual_done: manual }))
      assert.strictEqual(item.finished, false)
      assert.strictEqual(item.needDone, false)
      assert.ok(item.nextText)
    }
  })

  check('每天重复（还有下一次）→ 任何模式都不完成、不待确认', () => {
    for (const manual of [false, true]) {
      const item = deco({ repeat_type: 'daily', manual_done: manual })
      assert.strictEqual(item.finished, false)
      assert.strictEqual(item.needDone, false)
      assert.ok(item.nextText)
    }
  })

  /* ── 2. 手工确认模式 ───────────────────────────────────────────── */

  check('勾了手工确认、单次提醒已过 → 不算完成，标「待确认完成」', () => {
    const item = deco({ manual_done: true })
    assert.strictEqual(item.manualDone, true)
    assert.strictEqual(item.finished, false)
    assert.strictEqual(item.needDone, true)
  })

  check('勾了手工确认但用户点过完成（status=done）→ 完成且不待确认', () => {
    const item = deco({ manual_done: true, status: 'done' })
    assert.strictEqual(item.finished, true)
    assert.strictEqual(item.needDone, false)
  })

  check('默认模式里手工点了完成，也照样算完成（不会因开关而漏掉）', () => {
    const item = deco({ status: 'done', remind_at: '2026-11-13T09:00:00+08:00' })
    assert.strictEqual(item.finished, true)
    assert.strictEqual(item.needDone, false)
  })

  check('手工确认模式下 dates 过完 / 超出范围 → 都只待确认', () => {
    const dates = deco({ manual_done: true, repeat_type: 'dates', repeat_dates: ['2026-11-10'] })
    const range = deco({ manual_done: true, repeat_type: 'daily', repeat_end: '2026-11-11' })
    assert.strictEqual(dates.finished, false)
    assert.strictEqual(dates.needDone, true)
    assert.strictEqual(range.finished, false)
    assert.strictEqual(range.needDone, true)
  })

  /* ── 3. 首页与提醒记录页 ───────────────────────────────────────── */

  const indexJs = read('pages/index/index.js')
  const indexWxml = read('pages/index/index.wxml')
  const indexWxss = read('pages/index/index.wxss')
  const appWxss = read('app.wxss')
  const remindersJs = read('utils/reminders.js')
  const historyJs = read('pages/history/history.js')
  const historyWxml = read('pages/history/history.wxml')
  const editJs = read('pages/edit/edit.js')
  const editWxml = read('pages/edit/edit.wxml')
  const collabJs = read('utils/collab.js')
  const pushapiJs = read('cloudfunctions/pushapi/index.js')

  check('decorate 按 manual_done 分支，不再单纯用 !next 当完成', () => {
    assert.ok(!/item\.finished\s*=\s*!next/.test(remindersJs))
    assert.ok(/const manual = todo\.manual_done === true/.test(remindersJs))
    assert.ok(/item\.finished = todo\.status === 'done' \|\| \(!manual && !next\)/.test(remindersJs))
    assert.ok(/item\.needDone = manual && !next && !item\.finished/.test(remindersJs))
  })

  check('首页按 decorate 的 finished 过滤（两种完成方式都离开待办页）', () => {
    assert.ok(/const activeDecorated = decorated\.filter\(\(item\) => !item\.finished\)/.test(indexJs))
    assert.ok(!/item\.status !== 'done'\)/.test(indexJs))
  })

  check('待确认完成的项仍置顶，并有副标题计数', () => {
    assert.ok(/pendingFirst/.test(indexJs))
    assert.ok(/\(b\.needDone \? 1 : 0\) - \(a\.needDone \? 1 : 0\)/.test(indexJs))
    assert.ok(/pendingDoneCount: activeRaw\.filter/.test(indexJs))
    assert.ok(/待确认 \{\{pendingDoneCount\}\} 条/.test(indexWxml))
  })

  check('卡片「确认做完了」入口保持完整（catchtap / 二次确认 / 同步补额度）', () => {
    assert.ok(/catchtap="onDoneTap"/.test(indexWxml))
    assert.ok(/确认做完了/.test(indexWxml))
    assert.ok(/wx:if="\{\{item\.needDone\}\}" class="tag tag-red"/.test(indexWxml))
    assert.ok(/\.tag-red\s*\{/.test(appWxss))
    assert.ok(/\.done-btn-on\s*\{/.test(indexWxss))
    assert.ok(/if \(!id \|\| this\._doneBusy\) return/.test(indexJs))
    const renewAt = indexJs.indexOf('subscribe.renew()', indexJs.indexOf('onDoneTap(e)'))
    const modalAt = indexJs.indexOf('wx.showModal({', indexJs.indexOf('onDoneTap(e)'))
    assert.ok(renewAt > -1 && modalAt > -1 && renewAt < modalAt)
    assert.ok(/status: 'done'/.test(indexJs))
    assert.ok(/done_at: new Date\(\)\.toISOString\(\)/.test(indexJs))
  })

  check('首页待办列表下方不再有「提醒」说明横幅（用户要求去掉）', () => {
    // 之前那条底部提示已移除
    assert.ok(!/默认提醒发完就自动完成并归档/.test(indexWxml))
    // 「需要手工确认完成」开关标签仍在（编辑页 + 首页空态提示）
    assert.ok(/需要手工确认完成/.test(indexWxml) || /需要手工确认完成/.test(editWxml))
    assert.ok(!/提醒到点不会自动算完成/.test(indexWxml))
  })

  check('提醒记录页用 decorate 的 finished 统一收两类完成', () => {
    assert.ok(/\.map\(\(t\) => reminders\.decorate\(t, holidayMap\)\)/.test(historyJs))
    assert.ok(/\.filter\(\(item\) => item\.finished\)/.test(historyJs))
    assert.ok(!/已自然结束/.test(historyJs))
  })

  check('提醒记录页用「手工完成 / 自动完成」区分，只有手工完成显示确认时间', () => {
    assert.ok(/doneText: manual \? '手工完成' : '自动完成'/.test(historyJs))
    assert.ok(/const manual = item\.status === 'done'/.test(historyJs))
    assert.ok(/doneAtText: manual && !isNaN\(doneAt\) && doneAt > 0/.test(historyJs))
    assert.ok(/已完成的待办/.test(historyWxml))
    assert.ok(/默认提醒发完自动完成并归档/.test(historyWxml))
  })

  /* ── 4. 编辑页开关 ─────────────────────────────────────────────── */

  check('新增页有「需要手工确认完成」开关，且默认关闭', () => {
    assert.ok(/需要手工确认完成/.test(editWxml))
    assert.ok(/<switch checked="\{\{manualDone\}\}"[^>]*bindchange="onManualDone"/.test(editWxml))
    assert.ok(/manualDone: false,/.test(editJs))
    const onLoadAt = editJs.indexOf('onLoad(options)')
    assert.ok(onLoadAt > -1)
    const onLoad = editJs.slice(onLoadAt, onLoadAt + 3000)
    assert.ok(/manualDone: false/.test(onLoad))
    assert.ok(/onManualDone\(e\)/.test(editJs))
  })

  check('保存写入 manual_done，编辑时按云端值回显', () => {
    assert.ok(/manual_done: this\.data\.manualDone === true/.test(editJs))
    assert.ok(/manualDone: todo\.manual_done === true/.test(editJs))
  })

  check('协作两端 SHARE_FIELDS 都同步了 manual_done', () => {
    assert.ok(/'manual_done'/.test(collabJs))
    assert.ok(/'manual_done'/.test(pushapiJs))
    // status / done_at 仍然故意不同步：完成状态各成员各自维护
    assert.ok(!/'done_at'/.test(collabJs))
  })

  console.log(problems === 0 ? '\n全部通过（22 项）' : '\n失败 ' + problems + ' 项')
  if (problems > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
