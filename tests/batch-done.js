/**
 * 批量勾选确认完成 · 回归测试（纯 Node，mock 掉 wx / 云开发 / Page）：
 *   node tests/batch-done.js
 *
 * 覆盖：
 *   1. 进入批量模式默认全选当前可见待办；点卡片切换勾选；全选/仅待确认/清空；
 *   2. 批量确认二次弹窗、条数提示、补额度在同步点击链里、防连点锁；
 *   3. 只写选中的条目（status/done_at）、成功后退出批量并回源、部分失败提示；
 *   4. 批量模式下卡片不跳编辑、长按菜单不弹；
 *   5. WXML / WXSS 结构断言（勾选框、操作条、不遮 tabBar）。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const Module = require('module')

const ROOT = path.join(__dirname, '..')
let problems = 0
let checks = 0

function ok(msg) { console.log('  ✓ ' + msg) }
function bad(msg) { problems++; console.log('  ✗ ' + msg) }
function check(name, fn) {
  checks++
  try { fn(); ok(name) } catch (e) { bad(name + '：' + e.message) }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8') }

/* ── 运行环境 ─────────────────────────────────────────────────────────────── */
const events = []
const modalOpts = []
let batchResult = null
const batchCalls = []
let refreshCalls = 0

const fakeStore = {
  async batchUpdateTodos(items) {
    batchCalls.push(items)
    return batchResult || { updated: items.length, error: null }
  },
  async updateTodo() { return { data: [{}], error: null } },
  async listTodos() { return { data: [], error: null } },
}
const fakeSubscribe = {
  onAnyTap() {},
  renew() { events.push('renew') },
}
const mocks = {
  '../../utils/store': fakeStore,
  '../../utils/subscribe': fakeSubscribe,
  '../../utils/nav-guard': { guard: () => true },
  '../../utils/share': { onShareAppMessage() {}, onShareTimeline() {} },
  '../../utils/reminders': {
    decorate: (t) => Object.assign({}, t),
    syncDueReminders: async () => ({ fresh: [], updated: [], error: null }),
  },
}
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request]
  return originalLoad.apply(this, arguments)
}

global.getApp = () => ({ globalData: { holidayMap: {}, todosDirty: false } })
let pageConfig = null
global.Page = (cfg) => { pageConfig = cfg }
global.wx = {
  showToast(opt) { events.push('toast:' + (opt && opt.title)) },
  showLoading() { events.push('loading') },
  hideLoading() { events.push('hideLoading') },
  showModal(opt) { events.push('modal'); modalOpts.push(opt) },
  navigateTo(opt) { events.push('nav:' + opt.url) },
  showActionSheet() { events.push('actionSheet') },
  stopPullDownRefresh() {},
}

require('../pages/index/index')
Module._load = originalLoad

/* ── 页面实例 ─────────────────────────────────────────────────────────────── */
function makePage() {
  const page = Object.assign({}, pageConfig)
  page.data = JSON.parse(JSON.stringify(pageConfig.data))
  page.setData = function (patch) {
    Object.keys(patch).forEach((k) => { page.data[k] = patch[k] })
  }
  // 真实 refreshTodos 末尾会走 applyView 重建列表；mock 里也照做
  page.refreshTodos = async () => { refreshCalls++; page.applyView() }
  page._activeRaw = [
    { id: 't1', title: '双十一', priority: 'high', needDone: true, nextAt: 0, remind_at: '2026-11-10T09:00:00+08:00' },
    { id: 't2', title: '打卡', priority: 'medium', needDone: false, nextAt: 1794531600000, remind_at: '2026-10-19T18:01:00+08:00' },
    { id: 't3', title: '送舒明', priority: 'low', needDone: true, nextAt: 0, remind_at: '2026-11-11T09:00:00+08:00' },
  ]
  page.applyView()
  return page
}
function tap(page, id, mode) {
  page.onCardTap({ currentTarget: { dataset: { id: id } } })
}
function pick(page, mode) {
  page.onBatchSelect({ currentTarget: { dataset: { mode: mode } } })
}

async function main() {
  console.log('批量勾选确认完成 · 回归测试')

  const page = makePage()
  check('初始状态不在批量模式、没有选中项', () => {
    assert.strictEqual(page.data.batchMode, false)
    assert.strictEqual(page.data.selectedCount, 0)
    assert.strictEqual(page.data.activeList.length, 3)
  })

  check('待确认完成的项排在列表最前', () => {
    assert.strictEqual(page.data.activeList[0].needDone, true)
    assert.strictEqual(page.data.activeList[2].needDone, false)
  })

  // 1. 默认全选
  page.openBatch()
  check('进入批量模式默认全选当前可见的 3 条', () => {
    assert.strictEqual(page.data.batchMode, true)
    assert.strictEqual(page.data.selectedCount, 3)
    assert.ok(page.data.activeList.every((item) => item._checked === true))
  })

  check('点卡片取消勾选，计数跟着变', () => {
    tap(page, 't2')
    assert.strictEqual(page.data.selectedCount, 2)
    assert.strictEqual(page.data.activeList.filter((i) => i.id === 't2')[0]._checked, false)
    tap(page, 't2')
    assert.strictEqual(page.data.selectedCount, 3)
  })

  check('「清空」一键全不选', () => {
    pick(page, 'none')
    assert.strictEqual(page.data.selectedCount, 0)
    assert.ok(page.data.activeList.every((i) => !i._checked))
  })

  check('「全选」恢复全选', () => {
    pick(page, 'all')
    assert.strictEqual(page.data.selectedCount, 3)
  })

  check('「仅待确认」只勾提醒已发完的项', () => {
    pick(page, 'pending')
    assert.strictEqual(page.data.selectedCount, 2)
    assert.ok(page.data.activeList.filter((i) => i.needDone).every((i) => i._checked))
    assert.ok(page.data.activeList.filter((i) => !i.needDone).every((i) => !i._checked))
  })

  check('批量模式下点卡片不跳编辑页', () => {
    events.length = 0
    tap(page, 't1')
    assert.ok(!events.some((e) => String(e).startsWith('nav:')))
  })

  check('批量模式下长按不弹操作菜单', () => {
    page.onLongPress({ currentTarget: { dataset: { id: 't1', title: '双十一' } } })
    assert.ok(!events.includes('actionSheet'))
  })

  // 2. 二次确认
  pick(page, 'none')
  events.length = 0
  page.onBatchConfirm()
  check('一条都没勾时不弹确认框，直接提示', () => {
    assert.ok(events.some((e) => String(e).indexOf('请先勾选待办') >= 0))
    assert.ok(!events.includes('modal'))
  })

  pick(page, 'all')
  events.length = 0
  modalOpts.length = 0
  page.onBatchConfirm()
  check('确认框列出条数，并提示「还有后续提醒」的风险', () => {
    assert.strictEqual(modalOpts.length, 1)
    assert.ok(/3 条待办/.test(modalOpts[0].content))
    assert.ok(/1 条还有后续提醒/.test(modalOpts[0].content))
    assert.strictEqual(modalOpts[0].confirmText, '确认完成')
  })

  check('补订阅额度在 showModal 之前的同步点击链里', () => {
    const renewAt = events.indexOf('renew')
    const modalAt = events.indexOf('modal')
    assert.ok(renewAt > -1 && modalAt > -1 && renewAt < modalAt)
  })

  check('弹窗在途时连点不会开出第二个确认框', () => {
    page.onBatchConfirm()
    assert.strictEqual(modalOpts.length, 1)
  })

  // 3. 真正写入
  batchCalls.length = 0
  refreshCalls = 0
  modalOpts[0].success({ confirm: false })
  check('点「再想想」不写库、不退出批量模式', () => {
    assert.strictEqual(batchCalls.length, 0)
    assert.strictEqual(page.data.batchMode, true)
  })

  events.length = 0
  modalOpts.length = 0
  page.onBatchConfirm()
  await modalOpts[0].success({ confirm: true })
  check('只把选中的 3 条写库，patch 含 status/done_at', () => {
    assert.strictEqual(batchCalls.length, 1)
    assert.strictEqual(batchCalls[0].length, 3)
    assert.ok(batchCalls[0].every((it) => it.patch.status === 'done' && !!it.patch.done_at))
    // id 顺序跟随列表排序（待确认项在前），只比较集合
    assert.deepStrictEqual(batchCalls[0].map((it) => it.id).slice().sort(), ['t1', 't2', 't3'])
  })

  check('写库成功后退出批量模式、清空勾选并回源拉真实结果', () => {
    assert.strictEqual(page.data.batchMode, false)
    assert.strictEqual(page.data.selectedCount, 0)
    assert.strictEqual(refreshCalls, 1)
    assert.ok(!page.data.activeList.some((i) => i._checked))
  })

  await new Promise((r) => setTimeout(r, 380))
  check('成功提示显示完成条数', () => {
    assert.ok(events.some((e) => String(e).indexOf('已完成 3 条') >= 0))
  })

  check('退出批量模式后点卡片恢复跳编辑页', () => {
    events.length = 0
    tap(page, 't1')
    assert.ok(events.some((e) => String(e).startsWith('nav:')))
  })

  // 部分失败
  batchResult = { updated: 2, error: null }
  const page2 = makePage()
  page2.openBatch()
  modalOpts.length = 0
  events.length = 0
  page2.onBatchConfirm()
  await modalOpts[0].success({ confirm: true })
  await new Promise((r) => setTimeout(r, 380))
  check('部分写失败时明确提示失败条数，且仍回源让失败项重新出现', () => {
    assert.ok(events.some((e) => String(e).indexOf('2 条') >= 0 && String(e).indexOf('1 条失败') >= 0))
    assert.ok(refreshCalls >= 2)
  })

  // 4. 结构断言
  const wxml = read('pages/index/index.wxml')
  const wxss = read('pages/index/index.wxss')
  const appWxss = read('app.wxss')
  const js = read('pages/index/index.js')

  check('页面有批量入口、勾选框与底部操作条', () => {
    assert.ok(/bindtap="openBatch"/.test(wxml))
    assert.ok(/class="check-box \{\{item\._checked/.test(wxml))
    assert.ok(/class="batch-bar"/.test(wxml))
    assert.ok(/bindtap="onBatchConfirm"/.test(wxml))
    assert.ok(/data-mode="pending"/.test(wxml))
  })

  check('批量模式下隐藏单条完成按钮、卡片点击走 onCardTap', () => {
    assert.ok(/bindtap="onCardTap"/.test(wxml))
    assert.ok(/wx:if="\{\{!batchMode\}\}" class="row todo-actions"/.test(wxml))
  })

  check('批量操作条浮在 tabBar 上方，容器留足底部空间', () => {
    assert.ok(/bottom: calc\(148rpx \+ env\(safe-area-inset-bottom\)\)/.test(wxss))
    assert.ok(/\.container-batch\s*\{[^}]*padding-bottom: 420rpx/.test(appWxss))
  })

  check('批量写入复用 store.batchUpdateTodos，不逐条发请求', () => {
    assert.ok(/store\.batchUpdateTodos\(/.test(js))
    assert.ok(!/ids\.map\(\(id\) => store\.updateTodo/.test(js))
  })

  console.log(problems === 0 ? '\n全部通过（' + checks + ' 项）' : '\n失败 ' + problems + ' 项')
  if (problems > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
