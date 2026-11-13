/**
 * 批量删除 + 卡片单条删除按钮 · 回归测试（纯 Node，mock 掉 wx / 云开发 / Page）：
 *   node tests/batch-delete.js
 *
 * 覆盖：
 *   1. 卡片删除按钮：catchtap 自己补额度、二次确认（不可恢复 / 历史记录保留）、防连点、
 *      取消不写库、确认后只删一条并本地移除 + 回源、失败与无权限提示；长按菜单走同一入口。
 *   2. 批量删除：未勾选拦住、二次确认条数 / 协作提示、只删选中、成功后退出批量并回源、
 *      部分失败提示、与「批量确认完成」互斥。
 *   3. store.batchDeleteTodos：云函数优先（一次调用）、云端旧版 / 抛错时端上逐条兜底、
 *      逐条部分失败时 removed 准确、空 ids 不发请求。
 *   4. dataapi.batchDelete 结构：归属校验（_id + openid）、BUILD、main 分支。
 *   5. WXML / WXSS 结构断言（按钮、两行操作条、避开 tabBar）。
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
const tick = () => new Promise((r) => setTimeout(r, 10))

/* ── 运行环境 ─────────────────────────────────────────────────────────────── */
const events = []
const modalOpts = []
const actionSheetOpts = []
const batchDeleteCalls = []
const singleDeleteCalls = []
const cloudCalls = []
let refreshCalls = 0
let batchDeleteResult = null
let singleDeleteResult = { data: [{ id: 'x' }], error: null }
let cloudHandler = null
const removedDocs = []
let failIds = []

const fakeStore = {
  async batchUpdateTodos(items) { return { updated: items.length, error: null } },
  async batchDeleteTodos(ids) {
    batchDeleteCalls.push(ids.slice())
    return batchDeleteResult || { removed: ids.length, error: null }
  },
  async removeTodo(id) { singleDeleteCalls.push(String(id)); return singleDeleteResult },
  async updateTodo() { return { data: [{}], error: null } },
  async listTodos() { return { data: [], error: null } },
}
const fakeSubscribe = {
  onAnyTap() {},
  renew() { events.push('renew') },
}
const pageMocks = {
  '../../utils/store': fakeStore,
  '../../utils/subscribe': fakeSubscribe,
  '../../utils/nav-guard': { guard: () => true },
  '../../utils/share': { onShareAppMessage() {}, onShareTimeline() {} },
  '../../utils/reminders': {
    decorate: (t) => Object.assign({}, t),
    syncDueReminders: async () => ({ fresh: [], updated: [], error: null }),
  },
}

const cloudMock = {
  db: {
    collection() {
      return {
        doc(id) {
          return {
            async remove() {
              if (failIds.indexOf(String(id)) !== -1) throw new Error('模拟删除失败')
              removedDocs.push(String(id))
              return { stats: { removed: 1 } }
            },
            async update() { return { stats: { updated: 1 } } },
          }
        },
        where() { return { get: async () => ({ data: [] }), remove: async () => ({}) } },
        add: async () => ({ _id: 'new' }),
        orderBy() { return this },
        limit() { return this },
        get: async () => ({ data: [] }),
      }
    },
    RegExp: (o) => o,
    command: { in: (a) => a, lt: (v) => v },
  },
  cloud: {},
  async callFunction(name, data) {
    cloudCalls.push({ name: name, data: data })
    if (cloudHandler) return cloudHandler(name, data)
    return { ok: true, removed: (data.ids || []).length }
  },
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(pageMocks, request)) return pageMocks[request]
  if (request === './cloud') return cloudMock
  return originalLoad.apply(this, arguments)
}

global.getApp = () => ({ globalData: { holidayMap: {}, todosDirty: false } })
let pageConfig = null
global.Page = (cfg) => { pageConfig = cfg }
global.wx = {
  getStorageSync() { return 'openid-A' },
  setStorageSync() {},
  removeStorageSync() {},
  showToast(opt) { events.push('toast:' + (opt && opt.title)) },
  showLoading() { events.push('loading') },
  hideLoading() { events.push('hideLoading') },
  showModal(opt) { events.push('modal'); modalOpts.push(opt) },
  showActionSheet(opt) { events.push('actionSheet'); actionSheetOpts.push(opt) },
  navigateTo(opt) { events.push('nav:' + opt.url) },
  stopPullDownRefresh() {},
}

require('../pages/index/index')
const realStore = require('../utils/store')
Module._load = originalLoad

/* ── 页面实例 ─────────────────────────────────────────────────────────────── */
function makePage() {
  const page = Object.assign({}, pageConfig)
  page.data = JSON.parse(JSON.stringify(pageConfig.data))
  page.setData = function (patch) {
    Object.keys(patch).forEach((k) => { page.data[k] = patch[k] })
  }
  page.refreshTodos = async () => { refreshCalls++; page.applyView() }
  page._activeRaw = [
    { id: 't1', title: '双十一', priority: 'high', needDone: true, nextAt: 0, remind_at: '2026-11-10T09:00:00+08:00' },
    { id: 't2', title: '打卡', priority: 'medium', needDone: false, nextAt: 1794531600000, remind_at: '2026-10-19T18:01:00+08:00', shared: true },
    { id: 't3', title: '送舒明', priority: 'low', needDone: true, nextAt: 0, remind_at: '2026-11-11T09:00:00+08:00' },
  ]
  page.applyView()
  return page
}
function delTap(page, id, title) {
  return page.onDeleteTap({ currentTarget: { dataset: { id: id, title: title || '某待办' } } })
}

async function main() {
  console.log('批量删除 + 单条删除按钮 · 回归测试')

  /* 1. 卡片单条删除 */
  const page = makePage()
  check('初始有 3 条待办、不在批量模式', () => {
    assert.strictEqual(page.data.activeList.length, 3)
    assert.strictEqual(page.data.batchMode, false)
  })

  events.length = 0
  modalOpts.length = 0
  delTap(page, 't2', '打卡')
  check('删除按钮：补额度在 showModal 之前的同步点击链里', () => {
    const renewAt = events.indexOf('renew')
    const modalAt = events.indexOf('modal')
    assert.ok(renewAt > -1 && modalAt > -1 && renewAt < modalAt)
  })

  check('二次确认写明「不可恢复」「历史提醒记录会保留」并标红确认', () => {
    assert.strictEqual(modalOpts.length, 1)
    const opt = modalOpts[0]
    assert.strictEqual(opt.title, '删除待办')
    assert.ok(/打卡/.test(opt.content))
    assert.ok(/不可恢复/.test(opt.content))
    assert.ok(/历史提醒记录会保留/.test(opt.content))
    assert.strictEqual(opt.confirmText, '删除')
    assert.strictEqual(opt.confirmColor, '#d70015')
  })

  delTap(page, 't2', '打卡')
  check('弹窗在途时连点不会开出第二个确认框', () => {
    assert.strictEqual(modalOpts.length, 1)
  })

  singleDeleteCalls.length = 0
  await modalOpts[0].success({ confirm: false })
  await tick()
  check('点「再想想」不写库、列表不变', () => {
    assert.strictEqual(singleDeleteCalls.length, 0)
    assert.strictEqual(page.data.activeList.length, 3)
  })

  refreshCalls = 0
  events.length = 0
  modalOpts.length = 0
  delTap(page, 't2', '打卡')
  await modalOpts[0].success({ confirm: true })
  await tick()
  check('确认后只删这一条，并先本地移除再回源', () => {
    assert.deepStrictEqual(singleDeleteCalls, ['t2'])
    assert.ok(!page.data.activeList.some((i) => i.id === 't2'))
    assert.strictEqual(page.data.activeList.length, 2)
    assert.strictEqual(refreshCalls, 1)
  })

  await new Promise((r) => setTimeout(r, 380))
  check('删除成功给出可见反馈', () => {
    assert.ok(events.some((e) => String(e).indexOf('已删除') >= 0))
  })

  // 删除失败 / 无权限
  singleDeleteResult = { data: [], error: { message: '云数据库操作失败' } }
  const failPage = makePage()
  modalOpts.length = 0
  delTap(failPage, 't1', '双十一')
  await modalOpts[0].success({ confirm: true })
  await tick()
  check('删除失败时提示且不从列表移除', () => {
    assert.strictEqual(failPage.data.activeList.length, 3)
  })

  singleDeleteResult = { data: [], error: null }
  const noPermPage = makePage()
  modalOpts.length = 0
  events.length = 0
  delTap(noPermPage, 't1', '双十一')
  await modalOpts[0].success({ confirm: true })
  await tick()
  check('无权限删除时给出明确提示', () => {
    assert.ok(events.some((e) => String(e).indexOf('没有权限删除') >= 0))
    assert.strictEqual(noPermPage.data.activeList.length, 3)
  })
  singleDeleteResult = { data: [{ id: 'x' }], error: null }

  // 长按菜单的「删除」走同一入口
  const longPage = makePage()
  actionSheetOpts.length = 0
  modalOpts.length = 0
  events.length = 0
  longPage.onLongPress({ currentTarget: { dataset: { id: 't1', title: '双十一' } } })
  check('长按弹出操作菜单且含「删除」', () => {
    assert.strictEqual(actionSheetOpts.length, 1)
    assert.ok(actionSheetOpts[0].itemList.indexOf('删除') >= 0)
  })
  actionSheetOpts[0].success({ tapIndex: 2 })
  check('长按「删除」走统一的 onDeleteTap（仍要二次确认）', () => {
    assert.strictEqual(modalOpts.length, 1)
    assert.ok(/删除待办/.test(modalOpts[0].title || ''))
    assert.ok(events.includes('renew'))
  })
  check('批量模式下长按不弹操作菜单', () => {
    const batchPage = makePage()
    batchPage.openBatch()
    actionSheetOpts.length = 0
    batchPage.onLongPress({ currentTarget: { dataset: { id: 't1', title: '双十一' } } })
    assert.strictEqual(actionSheetOpts.length, 0)
  })

  /* 2. 批量删除 */
  const bpage = makePage()
  bpage.openBatch()
  bpage.onBatchSelect({ currentTarget: { dataset: { mode: 'none' } } })
  events.length = 0
  modalOpts.length = 0
  bpage.onBatchDelete()
  check('一条都没勾时不弹确认框，直接提示', () => {
    assert.ok(events.some((e) => String(e).indexOf('请先勾选待办') >= 0))
    assert.strictEqual(modalOpts.length, 0)
  })

  bpage.onBatchSelect({ currentTarget: { dataset: { mode: 'all' } } })
  events.length = 0
  modalOpts.length = 0
  bpage.onBatchDelete()
  check('批量删除二次确认写明条数、不可恢复与协作提示', () => {
    assert.strictEqual(modalOpts.length, 1)
    const opt = modalOpts[0]
    assert.strictEqual(opt.title, '批量删除')
    assert.ok(/3 条待办/.test(opt.content))
    assert.ok(/不可恢复/.test(opt.content))
    assert.ok(/1 条是协作待办/.test(opt.content))
    assert.strictEqual(opt.confirmText, '确认删除')
    assert.strictEqual(opt.confirmColor, '#d70015')
  })

  check('批量删除补额度也在 showModal 之前', () => {
    assert.ok(events.indexOf('renew') > -1 && events.indexOf('renew') < events.indexOf('modal'))
  })

  batchDeleteCalls.length = 0
  refreshCalls = 0
  await modalOpts[0].success({ confirm: false })
  await tick()
  check('点「再想想」不删库、不退出批量模式', () => {
    assert.strictEqual(batchDeleteCalls.length, 0)
    assert.strictEqual(bpage.data.batchMode, true)
  })

  events.length = 0
  modalOpts.length = 0
  bpage.onBatchDelete()
  bpage.onBatchDelete()
  check('弹窗在途时连点不会开出第二个批量删除确认框', () => {
    assert.strictEqual(modalOpts.length, 1)
  })

  await modalOpts[0].success({ confirm: true })
  await tick()
  check('只把选中的 3 条交给批量删除', () => {
    assert.strictEqual(batchDeleteCalls.length, 1)
    assert.deepStrictEqual(batchDeleteCalls[0].slice().sort(), ['t1', 't2', 't3'])
  })

  check('批量删除成功后退出批量、清空勾选并回源', () => {
    assert.strictEqual(bpage.data.batchMode, false)
    assert.strictEqual(bpage.data.selectedCount, 0)
    assert.strictEqual(refreshCalls, 1)
    assert.ok(!bpage.data.activeList.some((i) => i._checked))
  })

  await new Promise((r) => setTimeout(r, 380))
  check('批量删除成功提示条数', () => {
    assert.ok(events.some((e) => String(e).indexOf('已删除 3 条') >= 0))
  })

  // 部分失败
  batchDeleteResult = { removed: 2, error: null }
  const partial = makePage()
  partial.openBatch()
  modalOpts.length = 0
  events.length = 0
  partial.onBatchDelete()
  await modalOpts[0].success({ confirm: true })
  await new Promise((r) => setTimeout(r, 380))
  check('部分删除失败时提示失败条数且仍回源', () => {
    assert.ok(events.some((e) => String(e).indexOf('2 条') >= 0 && String(e).indexOf('1 条失败') >= 0))
    assert.ok(refreshCalls >= 2)
  })
  batchDeleteResult = null

  // 只删勾选的（取消一条）
  const pickPage = makePage()
  pickPage.openBatch()
  pickPage.onCardTap({ currentTarget: { dataset: { id: 't2' } } })
  modalOpts.length = 0
  batchDeleteCalls.length = 0
  pickPage.onBatchDelete()
  await modalOpts[0].success({ confirm: true })
  await tick()
  check('取消勾选的那条不会被删', () => {
    assert.strictEqual(batchDeleteCalls[0].length, 2)
    assert.ok(batchDeleteCalls[0].indexOf('t2') === -1)
  })

  // 与批量确认完成互斥
  const busyPage = makePage()
  busyPage.openBatch()
  busyPage.data.batchBusy = true
  modalOpts.length = 0
  busyPage.onBatchDelete()
  busyPage.onBatchConfirm()
  check('写库进行中（batchBusy）时两个批量操作都被拦住', () => {
    assert.strictEqual(modalOpts.length, 0)
  })

  /* 3. store.batchDeleteTodos */
  cloudCalls.length = 0
  removedDocs.length = 0
  cloudHandler = null
  const okRes = await realStore.batchDeleteTodos(['a1', 'a2'])
  check('云函数优先：一次 callFunction，返回真实删除条数', () => {
    assert.strictEqual(cloudCalls.length, 1)
    assert.strictEqual(cloudCalls[0].name, 'dataapi')
    assert.strictEqual(cloudCalls[0].data.action, 'batchDelete')
    assert.deepStrictEqual(cloudCalls[0].data.ids, ['a1', 'a2'])
    assert.strictEqual(okRes.removed, 2)
    assert.strictEqual(removedDocs.length, 0)
  })

  cloudCalls.length = 0
  removedDocs.length = 0
  cloudHandler = () => ({ ok: false, message: '未知操作：batchDelete｜dataapi 版本 2026-11-12b' })
  const oldRes = await realStore.batchDeleteTodos(['b1', 'b2'])
  check('云端是旧版（未知操作）时回退端上逐条删', () => {
    assert.strictEqual(oldRes.removed, 2)
    assert.deepStrictEqual(removedDocs.slice().sort(), ['b1', 'b2'])
  })

  removedDocs.length = 0
  cloudHandler = () => { throw new Error('云函数未部署') }
  const throwRes = await realStore.batchDeleteTodos(['c1'])
  check('云函数抛错时也能端上兜底', () => {
    assert.strictEqual(throwRes.removed, 1)
    assert.deepStrictEqual(removedDocs, ['c1'])
  })

  removedDocs.length = 0
  failIds = ['d2']
  const partRes = await realStore.batchDeleteTodos(['d1', 'd2', 'd3'])
  failIds = []
  check('端上逐条部分失败时 removed 只算真正删掉的', () => {
    assert.strictEqual(partRes.removed, 2)
    assert.deepStrictEqual(removedDocs.slice().sort(), ['d1', 'd3'])
  })

  cloudHandler = () => ({ ok: true, removed: 0 })
  const zeroRes = await realStore.batchDeleteTodos(['z1', 'z2'])
  check('云端返回 removed:0 时如实上报 0（不能被 || 误报成全删成功）', () => {
    assert.strictEqual(zeroRes.removed, 0)
  })

  cloudCalls.length = 0
  const emptyRes = await realStore.batchDeleteTodos([])
  check('空 ids 不发任何请求', () => {
    assert.strictEqual(emptyRes.removed, 0)
    assert.strictEqual(cloudCalls.length, 0)
  })
  cloudHandler = null

  /* 4 / 5. 结构与样式断言 */
  const wxml = read('pages/index/index.wxml')
  const wxss = read('pages/index/index.wxss')
  const appWxss = read('app.wxss')
  const js = read('pages/index/index.js')
  const storeJs = read('utils/store.js')
  const apiJs = read('cloudfunctions/dataapi/index.js')

  check('卡片上有独立的删除按钮，且用 catchtap 截断冒泡', () => {
    assert.ok(/class="del-btn"/.test(wxml))
    assert.ok(/catchtap="onDeleteTap"/.test(wxml))
    assert.ok(/data-title="\{\{item\.title\}\}"/.test(wxml))
  })

  check('批量模式下隐藏单条完成/删除按钮', () => {
    assert.ok(/wx:if="\{\{!batchMode\}\}" class="row todo-actions"/.test(wxml))
    const block = wxml.slice(wxml.indexOf('wx:if="{{!batchMode}}" class="row todo-actions"'))
    assert.ok(block.indexOf('del-btn') > -1)
    assert.ok(block.indexOf('</view>') > -1)
  })

  check('操作条有两个按钮：红色删除 + 确认完成，仍是两行布局', () => {
    assert.ok(/bindtap="onBatchDelete"/.test(wxml))
    assert.ok(/bindtap="onBatchConfirm"/.test(wxml))
    assert.ok(/class="btn btn-batch btn-danger btn-batch-del/.test(wxml))
    assert.ok(/class="row batch-actions"/.test(wxml))
  })

  check('删除按钮与批量条样式：红色、两按钮等宽、不遮 tabBar', () => {
    assert.ok(/\.del-btn\s*\{/.test(wxss))
    assert.ok(/color: #d70015/.test(wxss))
    assert.ok(/\.btn-batch\s*\{[^}]*flex: 1/.test(wxss))
    assert.ok(/\.batch-actions\s*\{/.test(wxss))
    assert.ok(/bottom: calc\(148rpx \+ env\(safe-area-inset-bottom\)\)/.test(wxss))
    assert.ok(/\.container-batch\s*\{[^}]*padding-bottom: 420rpx/.test(appWxss))
  })

  check('页面删除统一走二次确认入口，长按菜单也复用它', () => {
    assert.ok(/onDeleteTap\(e\)/.test(js))
    assert.ok(/self\.onDeleteTap\(\{ currentTarget/.test(js))
    assert.ok(!/self\.removeTodo\(id, title\)/.test(js))
    assert.ok(/store\.batchDeleteTodos\(ids\)/.test(js))
  })

  check('store 导出 batchDeleteTodos，且云端失败才逐条兜底', () => {
    assert.ok(/async function batchDeleteTodos\(ids\)/.test(storeJs))
    assert.ok(/batchDeleteTodos,/.test(storeJs))
    assert.ok(/action: 'batchDelete'/.test(storeJs))
    assert.ok(/removeTodo\(id\)\.then\(/.test(storeJs))
  })

  check('dataapi 的 batchDelete 先按 openid 校验归属，再逐条删', () => {
    assert.ok(/async function batchDelete\(ids, openid\)/.test(apiJs))
    assert.ok(/where\(\{ _id: _\.in\(list\), openid: openid \}\)/.test(apiJs))
    assert.ok(/action === 'batchDelete'/.test(apiJs))
    assert.ok(/const BUILD = '2026-11-12d'/.test(apiJs))
  })

  console.log(problems === 0 ? '\n全部通过（' + checks + ' 项）' : '\n失败 ' + problems + ' 项')
  if (problems > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
