/**
 * 「日期选择显示周几」回归测试（纯 Node，行为级）：
 *   node tests/weekday.js
 *
 * 为什么必须真跑编辑页：原来 onCpChange 只在「日列长度变化」时重建列，
 * 但周几由年+月+日共同决定 —— 7 月和 8 月都是 31 天，旧逻辑会显示上个月的
 * 星期。这里把 Page({...}) 配置跑起来，直接调 openCp / onCpChange / onCpConfirm。
 *
 * 覆盖：
 *   1. 共享字典新增 wd_cp_day / wd_picker_full，11 语言与占位符一致、两份 md5 一致；
 *   2. 滚轮日列每一天都带周几，顶部实时显示选中日期的周几；
 *   3. 换月（含天数相同的两个月）必须整列重建；
 *   4. 周几只是展示层：onCpConfirm 仍换算出纯 'YYYY-MM-DD'，范围值不被污染；
 *   5. 生效范围起止、Web 新建/编辑弹层都有周几。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const Module = require('module')

const ROOT = path.join(__dirname, '..')
let passed = 0
let failed = 0
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { failed++; console.log('  ✗ ' + name + '：' + e.message) }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8') }
function md5(p) { return crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, p))).digest('hex') }

/* ── 运行沙箱：与 tests/auto-calendar.js 相同的精简 stub ─────────────── */
const storage = {}
const appObj = { globalData: { holidayMap: {}, todosDirty: false }, setHolidayMap() {} }
const wxStub = {
  getStorageSync(k) { return storage[k] },
  setStorageSync(k, v) { storage[k] = v },
  removeStorageSync(k) { delete storage[k] },
  getSystemInfoSync() { return { language: 'zh-CN' } },
  setNavigationBarTitle() {},
  showToast() {}, hideToast() {}, showLoading() {}, hideLoading() {},
  showModal() {}, showActionSheet() {}, navigateBack() {},
  addPhoneCalendar() {}, addPhoneRepeatCalendar() {},
}
const stubs = {
  '../../utils/store': {
    insertTodo() { return Promise.resolve({ data: [{ id: 'x' }] }) },
    updateTodo() { return Promise.resolve({ data: [1] }) },
    listTodos() { return Promise.resolve({ data: [] }) },
    removeTodo() { return Promise.resolve({ data: [1] }) },
    readHolidayCache() { return { rows: [] } },
    mergeActiveHolidays() { return [] },
  },
  '../../utils/subscribe': { renew() {}, onAnyTap() {}, renewWithToast() {} },
  '../../utils/collab': {
    create() { return Promise.resolve({ data: {} }) }, sync() { return Promise.resolve({ data: {} }) },
    members() { return Promise.resolve({ data: [] }) }, leave() { return Promise.resolve({ data: {} }) },
  },
  '../../utils/attachments': {
    MAX_IMAGES: 9, chooseAndUpload() { return Promise.resolve([]) },
    previewImage() {}, chooseLocation() { return Promise.resolve(null) }, openLocation() {},
  },
  '../../utils/save-guard': { makeSaveToken() { return 'tk' }, withTimeout(p) { return p } },
  '../../utils/share': {
    SHARE_TITLE: 'KIWI待办', SHARE_PATH: '/pages/index/index',
    onShareAppMessage() {}, onShareTimeline() {},
  },
}

global.getApp = () => appObj
global.wx = wxStub
let pageConfig = null
global.Page = (cfg) => { pageConfig = cfg }
const originalLoad = Module._load
Module._load = function (request, parent) {
  if (parent && /pages[\\/]edit[\\/]edit\.js$/.test(parent.filename || '') && stubs[request]) return stubs[request]
  return originalLoad.apply(this, arguments)
}
require('../pages/edit/edit')
Module._load = originalLoad
assert.ok(pageConfig, '编辑页 Page 配置没被捕获')

const i18n = require('../utils/i18n')
const fmt = require('../utils/i18n-format')
const t = (k, v) => i18n.t(k, v)
const week = (y, m, d) => fmt.weekday(new Date(y, m - 1, d))

function makePage() {
  const page = Object.assign({}, pageConfig)
  page.data = Object.assign({}, pageConfig.data)
  page.setData = function (patch) { Object.assign(this.data, patch) }
  return page
}
/** 打开「日期」滚轮，返回页面实例 */
function openDate(dateStr) {
  const p = makePage()
  p.data.dateStr = dateStr
  p.applyLang()
  p.openCp({ currentTarget: { dataset: { type: 'date' } }, detail: {} })
  return p
}

console.log('\n== 日期选择周几：字典 ==')

test('共享字典新增 2 个 wd_ 词条，11 语言齐全且占位符一致', () => {
  const e = require('../webapp/i18n-extra.js')
  for (const k of ['wd_cp_day', 'wd_picker_full']) {
    const row = e.ROWS[k]
    assert.ok(row, '缺词条 ' + k)
    assert.strictEqual(row.length, 11, k + ' 不是 11 个值')
    assert.ok(row.every((v) => typeof v === 'string' && v.length), k + ' 有空值')
    const ph = (v) => (String(v).match(/\{\w+\}/g) || []).sort().join(',')
    const want = ph(row[0])
    row.forEach((v, i) => assert.strictEqual(ph(v), want, k + ' 第 ' + i + ' 种语言占位符不一致'))
    assert.ok(row.every((v) => v.indexOf('{week}') >= 0), k + ' 丢了周几占位符')
  }
  assert.strictEqual((e.ROWS.wd_cp_day[0].match(/\{\w+\}/g) || []).sort().join(','), '{n},{week}')
  assert.strictEqual((e.ROWS.wd_picker_full[0].match(/\{\w+\}/g) || []).sort().join(','), '{date},{week}')
  assert.ok(!/cpDaysOfMonth[\s\S]{0,400}t\('ed_cp_day'/.test(read('pages/edit/edit.js')),
    '日列回退成不带周几的旧词条了')
})

test('webapp / utils 两份补充字典 md5 一致', () => {
  assert.strictEqual(md5('webapp/i18n-extra.js'), md5('utils/i18n-extra.js'))
})

test('11 种语言的周几都由 Intl 生成，切换语言会变化', () => {
  const d = new Date(2027, 1, 11)
  const zh = i18n.t('wd_cp_day', { n: 11, week: fmt.weekday(d) }, 'zh-CN')
  const en = i18n.t('wd_cp_day', { n: 11, week: d.toLocaleDateString('en-US', { weekday: 'short' }) }, 'en-US')
  assert.notStrictEqual(zh, en, '中英文日列不应一样')
  assert.ok(zh.indexOf(fmt.weekday(d)) >= 0 && en.indexOf(d.toLocaleDateString('en-US', { weekday: 'short' })) >= 0)
})

console.log('\n== 日期选择周几：滚轮行为 ==')

test('打开日期滚轮：每一天都带周几，顶部显示选中日期周几', () => {
  const p = openDate('2027-02-11')
  assert.strictEqual(p.data.cpType, 'date')
  assert.strictEqual(p.data.cpYm, '2027-02')
  const items = p.data.cpColumns[2].items
  assert.strictEqual(items.length, 28, '2027 年 2 月应为 28 天')
  assert.strictEqual(items[10], t('wd_cp_day', { n: 11, week: week(2027, 2, 11) }))
  assert.ok(items.every((s, i) => s.indexOf(week(2027, 2, i + 1)) >= 0), '日列有条目没带正确的周几')
  assert.ok(p.data.cpWeekdayText.indexOf('2027-02-11') >= 0)
  assert.ok(p.data.cpWeekdayText.indexOf(week(2027, 2, 11)) >= 0)
})

test('换月（天数不同）重建日列并刷新周几', () => {
  const p = openDate('2027-02-11')
  const feb = p.data.cpColumns[2].items[10]
  p.onCpChange({ detail: { value: [27, 6, 10] } })   // 2027-07-11
  assert.strictEqual(p.data.cpYm, '2027-07')
  assert.strictEqual(p.data.cpColumns[2].items.length, 31)
  assert.strictEqual(p.data.cpColumns[2].items[10], t('wd_cp_day', { n: 11, week: week(2027, 7, 11) }))
  assert.notStrictEqual(p.data.cpColumns[2].items[10], feb)
  assert.ok(p.data.cpWeekdayText.indexOf('2027-07-11') >= 0)
})

test('同为 31 天的两个月切换也必须重建（旧的按长度判断会漏）', () => {
  const p = openDate('2027-07-11')
  const july = p.data.cpColumns[2].items[10]
  p.onCpChange({ detail: { value: [27, 7, 10] } })   // 2027-08-11，仍是 31 天
  assert.strictEqual(p.data.cpYm, '2027-08')
  assert.strictEqual(p.data.cpColumns[2].items.length, 31)
  assert.strictEqual(p.data.cpColumns[2].items[10], t('wd_cp_day', { n: 11, week: week(2027, 8, 11) }))
  assert.notStrictEqual(p.data.cpColumns[2].items[10], july, '周几没跟着月份变')
  assert.notStrictEqual(week(2027, 7, 11), week(2027, 8, 11), '测试数据本身应跨星期')
})

test('只在日列内滚动也实时刷新顶部周几', () => {
  const p = openDate('2027-02-01')
  p.onCpChange({ detail: { value: [27, 1, 10] } })   // 同一月份，换成 11 日
  assert.strictEqual(p.data.cpYm, '2027-02')
  assert.ok(p.data.cpWeekdayText.indexOf('2027-02-11') >= 0)
  assert.ok(p.data.cpWeekdayText.indexOf(week(2027, 2, 11)) >= 0)
})

test('2 月选到 31 日时索引被夹住，确认后仍是合法纯日期', () => {
  const p = openDate('2027-02-11')
  p.onCpChange({ detail: { value: [27, 1, 30] } })
  assert.strictEqual(p.data.cpValue[2], 27)
  let captured = ''
  p.onDate = (e) => { captured = e.detail.value }
  p.onCpConfirm()
  assert.strictEqual(captured, '2027-02-28')
})

test('生效范围起止滚轮同样带周几（新建 / 修改共用）', () => {
  const p = openDate('2027-02-11')
  p.onCpChange({ detail: { value: [27, 2, 10] } })   // 2027-03-11
  p.openCp({ currentTarget: { dataset: { type: 'rangeStart' } }, detail: {} })
  assert.strictEqual(p.data.cpType, 'rangeStart')
  assert.ok(p.data.cpWeekdayText.indexOf(week(2027, 2, 11)) >= 0)
  assert.ok(p.data.cpColumns[2].items[10].indexOf(week(2027, 2, 11)) >= 0)
})

test('范围展示值带周几，但 rangeStart / rangeEnd 仍是纯日期', () => {
  const p = makePage()
  p.data.rangeStart = '2027-03-01'
  p.data.rangeEnd = '2027-03-31'
  p.syncRangeTexts()
  assert.ok(p.data.rangeStartText.indexOf('2027-03-01') >= 0)
  assert.ok(p.data.rangeStartText.indexOf(week(2027, 3, 1)) >= 0)
  assert.ok(p.data.rangeEndText.indexOf(week(2027, 3, 31)) >= 0)
  assert.strictEqual(p.data.rangeStart, '2027-03-01')
  assert.strictEqual(p.data.rangeEnd, '2027-03-31')
})

console.log('\n== 日期选择周几：模板与 Web 弹层 ==')

test('WXML 渲染顶部周几，范围两行改用带周几的展示值', () => {
  const wxml = read('pages/edit/edit.wxml')
  assert.ok(/class="cp-week"[^>]*wx:if="\{\{cpWeekdayText\}\}"/.test(wxml))
  assert.ok(wxml.includes('{{cpWeekdayText}}'))
  assert.ok(wxml.includes('rangeStartText || T.ed_unlimited') && wxml.includes('rangeEndText || T.ed_unlimited'))
  assert.ok(!/\{\{rangeStart \|\|/.test(wxml) && !/\{\{rangeEnd \|\|/.test(wxml))
  assert.ok(read('pages/edit/edit.wxss').includes('.cp-week'))
})

test('Web 新建 / 编辑弹层共用 computed formWeekday 并绑定模板', () => {
  const js = read('webapp/app.js')
  const html = read('webapp/index.html')
  assert.ok(/formWeekday:\s*function/.test(js), '缺 formWeekday computed')
  assert.ok(js.includes("translate(this.lang, 'fmt_date_label'"), '周几未走本地化字典')
  assert.ok(/openNew:\s*function[\s\S]{0,220}defaultForm\(\)/.test(js), '新建未用默认表单')
  assert.ok(/openEdit:\s*function[\s\S]{0,400}remindLocal:/.test(js), '编辑未回填 remindLocal')
  const seg = html.slice(html.indexOf('type="datetime-local"'), html.indexOf('type="datetime-local"') + 260)
  assert.ok(seg.includes('v-if="formWeekday"') && seg.includes('{{ formWeekday }}'))
  assert.ok(html.includes("editing.id ? $t('m_edit') : $t('m_new')"), '新建/编辑共用一个弹层')
})

test('提醒链路 5 份 reminder-core 与中国节假日表 4 份仍一致', () => {
  const cores = ['utils/reminder-core.js', 'cloudfunctions/pusher/reminder-core.js',
    'cloudfunctions/pushapi/reminder-core.js', 'cloudfunctions/webapi/reminder-core.js',
    'webapp/reminder-core.js'].map(md5)
  assert.strictEqual(new Set(cores).size, 1)
  const hols = ['utils/holidays-2027.js', 'cloudfunctions/pusher/holidays-2027.js',
    'cloudfunctions/webapi/holidays-2027.js', 'webapp/holidays-2027.js'].map(md5)
  assert.strictEqual(new Set(hols).size, 1)
})

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败')
if (failed) process.exit(1)
