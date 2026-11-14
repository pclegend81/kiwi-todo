/**
 * 「新建默认自动写入手机日历」回归测试（纯 Node，行为级）：
 *   node tests/auto-calendar.js
 *
 * 为什么用行为级而不是只 grep 源码：
 *   微信要求 wx.addPhoneCalendar / addPhoneRepeatCalendar「仅在点击行为时调用」，
 *   一旦被挪到 await 之后就必然 fail。「有没有在写库之前同步发起」是本功能最容易
 *   被后续改动破坏的点，必须真的把 Page 跑起来、记录调用顺序。
 *
 * 做法：把 pages/edit/edit.js 在 Node 里加载，注入 wx / getApp / Page 与工具模块空壳，
 * 拿到 Page({...}) 的配置后自己构造页面实例，直接调 onLoad / onSave。
 *
 * 覆盖：
 *   1. 新建默认 autoCalendar=true、编辑默认 false，manualDone 默认 false；
 *   2. 日历 API 在写库之前同步发起（手势链），且只发起一次；
 *   3. 写日历时不并发补订阅额度；规则不支持 / 关开关 / 编辑则把额度补回来；
 *   4. 编辑页开关打开确实会重写一条（不是死控件）；
 *   5. 规则不支持时跳过 + 实时提示；日历失败有兜底提示；
 *   6. 结果提示走 globalData + storage 双写，首页 onShow 消费；
 *   7. 写库失败但日历已写入时，如实提示用户手动删除（微信无删除日历事件 API）。
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
async function checkAsync(name, fn) {
  try { await fn(); ok(name) } catch (e) { bad(name + '：' + e.message) }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8') }

/* ── 运行沙箱 ───────────────────────────────────────────────────────── */

let calls = []          // 日历 API 调用记录
let order = []          // 关键动作先后顺序
let toasts = []
let renewCalls = 0
let insertResult = { data: [{ id: 'new1' }] }
let insertCalls = 0
let updateCalls = 0
let calendarShouldFail = false

const storage = {}
const appObj = { globalData: { holidayMap: {}, todosDirty: false } }

const wxStub = {
  addPhoneCalendar(p) {
    calls.push({ type: 'single', params: p })
    order.push('calendar')
    if (calendarShouldFail) p.fail({ errMsg: 'addPhoneCalendar:fail auth deny' })
    else p.success()
  },
  addPhoneRepeatCalendar(p) {
    calls.push({ type: 'repeat', params: p })
    order.push('calendar')
    if (calendarShouldFail) p.fail({ errMsg: 'addPhoneRepeatCalendar:fail auth deny' })
    else p.success()
  },
  getStorageSync(k) { return storage[k] },
  setStorageSync(k, v) { storage[k] = v },
  removeStorageSync(k) { delete storage[k] },
  setNavigationBarTitle() {},
  showToast(o) { toasts.push(String(o.title || '')) },
  hideToast() {},
  showLoading() {},
  hideLoading() {},
  showModal() {},
  navigateBack(o) { if (o && o.fail) o.fail() },
  showActionSheet() {},
}

const storeStub = {
  insertTodo(todo) {
    insertCalls++
    order.push('insert')
    return Promise.resolve(insertResult)
  },
  updateTodo(id, todo) {
    updateCalls++
    order.push('update')
    return Promise.resolve({ data: [1] })
  },
  listTodos() { return Promise.resolve({ data: [] }) },
  removeTodo() { return Promise.resolve({ data: [1] }) },
}
const subscribeStub = {
  renew() { renewCalls++; order.push('renew') },
  onAnyTap() {},
  renewWithToast() {},
}
const collabStub = {
  create() { return Promise.resolve({ data: {} }) },
  sync() { return Promise.resolve({ data: {} }) },
  members() { return Promise.resolve({ data: [] }) },
  leave() { return Promise.resolve({ data: {} }) },
}
const attachmentsStub = {
  MAX_IMAGES: 9,
  chooseAndUpload() { return Promise.resolve([]) },
  previewImage() {},
  chooseLocation() { return Promise.resolve(null) },
  openLocation() {},
}
const saveGuardStub = {
  makeSaveToken() { return 'test-token' },
  withTimeout(p) { return p },
}
const shareStub = {
  SHARE_TITLE: 'KIWI待办',
  SHARE_PATH: '/pages/index/index',
  onShareAppMessage() {},
  onShareTimeline() {},
}

const stubs = {
  '../../utils/store': storeStub,
  '../../utils/subscribe': subscribeStub,
  '../../utils/collab': collabStub,
  '../../utils/attachments': attachmentsStub,
  '../../utils/save-guard': saveGuardStub,
  '../../utils/share': shareStub,
}

global.getApp = () => appObj
global.wx = wxStub
let pageConfig = null
global.Page = (cfg) => { pageConfig = cfg }

const originalLoad = Module._load
Module._load = function (request, parent) {
  if (parent && /pages[\\/]edit[\\/]edit\.js$/.test(parent.filename || '') && stubs[request]) {
    return stubs[request]
  }
  return originalLoad.apply(this, arguments)
}
require('../pages/edit/edit')
Module._load = originalLoad

assert.ok(pageConfig, '编辑页 Page 配置没被捕获')

function makePage() {
  const page = Object.assign({}, pageConfig)
  page.data = Object.assign({}, pageConfig.data)
  page.setData = function (patch) { Object.assign(this.data, patch) }
  return page
}
function reset() {
  calls = []
  order = []
  toasts = []
  renewCalls = 0
  insertCalls = 0
  updateCalls = 0
  insertResult = { data: [{ id: 'new1' }] }
  calendarShouldFail = false
  Object.keys(storage).forEach((k) => delete storage[k])
  delete appObj.globalData.calendarNotice
  appObj.globalData.todosDirty = false
}
/** 刷新一遍微任务，让 writeTodoCalendar 的 .then 跑完 */
function flush() { return new Promise((r) => setImmediate(r)) }

/** 新建一个「可以保存」的页面：onLoad({}) 给全部默认字段，再补标题 */
function newPage() {
  const page = makePage()
  page.onLoad({})
  page.setData({ title: '测试待办' })
  return page
}

async function main() {
  console.log('新建默认写入手机日历 · 回归测试')

  reset()
  check('新建默认 autoCalendar=true、manualDone=false', () => {
    const page = makePage()
    page.onLoad({})
    assert.strictEqual(page.data.autoCalendar, true)
    assert.strictEqual(page.data.manualDone, false)
    assert.ok(/保存时将自动写入手机系统日历/.test(page.data.calendarHint))
    assert.strictEqual(page.data.calendarSupported, true)
  })

  reset()
  check('编辑默认不自动写日历（避免重复事件）', () => {
    const page = makePage()
    page.onLoad({ id: 'todo-1' })
    assert.strictEqual(page.data.autoCalendar, false)
    assert.strictEqual(page.data.isEdit, true)
  })

  reset()
  await checkAsync('新建保存：日历 API 在写库之前同步发起，且只写一次', async () => {
    const page = newPage()
    await page.onSave()
    await flush()
    assert.strictEqual(calls.length, 1)
    assert.strictEqual(calls[0].type, 'single')
    assert.strictEqual(insertCalls, 1)
    assert.ok(order.indexOf('calendar') >= 0 && order.indexOf('insert') >= 0)
    assert.ok(order.indexOf('calendar') < order.indexOf('insert'), '日历必须在写库 await 之前发起')
    assert.ok(calls[0].params.title.indexOf('【KIWI待办】') === 0)
    assert.strictEqual(typeof calls[0].params.startTime, 'number')
  })

  reset()
  await checkAsync('写日历的那次点击不并发补订阅额度', async () => {
    const page = newPage()
    await page.onSave()
    await flush()
    assert.strictEqual(renewCalls, 0)
  })

  reset()
  await checkAsync('日历写入成功：结果写进 globalData + storage 双份', async () => {
    const page = newPage()
    await page.onSave()
    await flush()
    assert.strictEqual(appObj.globalData.calendarNotice, '已写入手机日历')
    assert.strictEqual(storage.kiwi_calendar_notice, '已写入手机日历')
    assert.ok(!toasts.some((t) => /已写入手机日历/.test(t)), '保存流程里不该直接弹 toast 打断「已保存」')
  })

  reset()
  await checkAsync('关掉开关：保存照常、不写日历、补一次订阅额度', async () => {
    const page = newPage()
    page.onAutoCalendar({ detail: { value: false } })
    await page.onSave()
    await flush()
    assert.strictEqual(calls.length, 0)
    assert.strictEqual(insertCalls, 1)
    assert.strictEqual(renewCalls, 1)
    assert.strictEqual(page.data.calendarHint.indexOf('已关闭自动写入'), 0)
  })

  reset()
  await checkAsync('规则不支持（每工作日）：跳过日历、把额度补回来、给出提示', async () => {
    const page = newPage()
    page.setData({ repeatIndex: 7 }) // REPEAT_KEYS[7] = workday
    page.updatePreview()
    assert.strictEqual(page.data.calendarSupported, false)
    assert.ok(/无法写入系统日历/.test(page.data.calendarHint))
    await page.onSave()
    await flush()
    assert.strictEqual(calls.length, 0)
    assert.strictEqual(insertCalls, 1, '规则不支持不能拦住保存')
    assert.strictEqual(renewCalls, 1)
    assert.strictEqual(appObj.globalData.calendarNotice, '当前规则不支持写入日历，已跳过')
  })

  reset()
  await checkAsync('日历授权失败：不阻塞保存，提示可在编辑页重试', async () => {
    calendarShouldFail = true
    const page = newPage()
    await page.onSave()
    await flush()
    assert.strictEqual(calls.length, 1)
    assert.strictEqual(insertCalls, 1)
    assert.strictEqual(appObj.globalData.calendarNotice, '手机日历未写入，可在编辑页重试')
    assert.ok(toasts.indexOf('已保存') >= 0)
  })

  reset()
  await checkAsync('低版本微信没有日历 API：同步跳过、补回订阅额度、给出提示', async () => {
    const original = wxStub.addPhoneCalendar
    wxStub.addPhoneCalendar = undefined
    try {
      const page = newPage()
      await page.onSave()
      await flush()
      assert.strictEqual(calls.length, 0)
      assert.strictEqual(insertCalls, 1)
      assert.strictEqual(renewCalls, 1, '没写成日历就别把这次点击的额度让掉')
      assert.strictEqual(appObj.globalData.calendarNotice, '当前微信版本过低，无法写入日历')
    } finally {
      wxStub.addPhoneCalendar = original
    }
  })

  reset()
  await checkAsync('编辑页默认不写日历，但把开关打开确实会重写一条', async () => {
    const page = newPage()
    page.setData({ isEdit: true, id: 'todo-1', autoCalendar: false })
    await page.onSave()
    await flush()
    assert.strictEqual(calls.length, 0)
    assert.strictEqual(updateCalls, 1)

    reset()
    const page2 = newPage()
    page2.setData({ isEdit: true, id: 'todo-2' })
    // 用户在编辑页打开开关：onAutoCalendar 会顺带刷新提示
    page2.onAutoCalendar({ detail: { value: true } })
    await page2.onSave()
    await flush()
    assert.strictEqual(calls.length, 1, '编辑页的「重新写入手机日历」开关不能是死控件')
    assert.ok(/重新写入一条日历事件/.test(page2.data.calendarHint))
  })

  reset()
  await checkAsync('写库失败但日历已写入：如实提示手动删除（微信没有删除事件 API）', async () => {
    insertResult = { error: { message: '网络错误' } }
    const page = newPage()
    await page.onSave()
    await flush()
    assert.strictEqual(calls.length, 1)
    assert.ok(toasts.some((t) => /保存失败；日历若已写入请手动删除/.test(t)))
  })

  reset()
  await checkAsync('标题为空被拦截：不写日历，且这次点击的订阅额度不白丢', async () => {
    const page = newPage()
    page.setData({ title: '' })
    await page.onSave()
    await flush()
    assert.strictEqual(calls.length, 0)
    assert.strictEqual(insertCalls, 0)
    assert.strictEqual(renewCalls, 1)
    assert.ok(toasts.indexOf('请填写标题') >= 0)
  })

  /* ── 结构 / 文案 / 首页消费 ───────────────────────────────────────── */
  const editWxml = read('pages/edit/edit.wxml')
  const editJs = read('pages/edit/edit.js')
  const indexJs = read('pages/index/index.js')
  const calendarJs = read('utils/calendar.js')

  check('编辑页有自动写日历开关与实时提示，保存按钮用 catchtap 截断冒泡', () => {
    assert.ok(/<switch checked="\{\{autoCalendar\}\}"[^>]*bindchange="onAutoCalendar"/.test(editWxml))
    assert.ok(/\{\{calendarHint\}\}/.test(editWxml))
    assert.ok(/catchtap="onSave"/.test(editWxml))
    assert.ok(/onManualDone\(e\)/.test(editJs) && /onAutoCalendar\(e\)/.test(editJs))
  })

  check('日历写入是「点击链里同步发起」：writeTodoCalendar 在 Promise executor 里调 API', () => {
    const fn = calendarJs.slice(calendarJs.indexOf('function writeTodoCalendar'))
    assert.ok(/api\(params\)/.test(fn))
    assert.ok(!/await /.test(fn.slice(0, fn.indexOf('api(params)'))))
  })

  check('首页 onShow 消费日历结果提示（含延迟兜底，读完即清）', () => {
    assert.ok(/consumeCalendarNotice\(\)/.test(indexJs))
    assert.ok(/setTimeout\(\(\) => this\.consumeCalendarNotice\(\), 1600\)/.test(indexJs))
    assert.ok(/wx\.removeStorageSync\('kiwi_calendar_notice'\)/.test(indexJs))
    assert.ok(/app\.globalData\.calendarNotice = ''/.test(indexJs))
  })

  check('编辑页 WXML 保留「手动补写」入口，用于失败重试 / 改时间后重写', () => {
    assert.ok(/手机日历 · 手动补写|T\.ed_calendar_manual_title/.test(editWxml))
    assert.ok(/catchtap="onWriteCalendar"/.test(editWxml))
    assert.ok(/新建保存时已默认写入|T\.ed_calendar_manual_hint/.test(editWxml))
  })

  console.log(problems === 0 ? '\n全部通过（18 项）' : '\n失败 ' + problems + ' 项')
  if (problems > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
