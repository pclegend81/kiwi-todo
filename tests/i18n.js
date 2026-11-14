/**
 * 多语言 / 地区节假日 / 当地社交登录 回归测试
 *   node tests/i18n.js
 *
 * 重点锁住这次改造最容易回退的四件事：
 *  1. 11 种语言的字典必须齐全、占位符一致，Web 与小程序共享文件 md5 一致；
 *  2. **选择语言必须真的切换对应地区的节假日表**（不是只换界面文字）；
 *  3. 小程序端切换语言要作废 holidayMap 缓存，且非中国大陆地区绝不回灌公共表；
 *  4. 6 个页面（含编辑页 / 邀请页 / 历史页）的可见文案全部走字典，
 *    历史页 / 编辑页的 holidayMap 兜底必须按当前 region 重建，不能用 CN 缓存复活。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const assert = require('assert')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const md5 = (p) => crypto.createHash('md5').update(read(p)).digest('hex')

let passed = 0
let failed = 0
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + e.message) }
}

const base = require('../webapp/i18n.js')
const extra = require('../webapp/i18n-extra.js')
const regionHolidays = require('../webapp/holidays-region.js').HOLIDAYS_REGION
const mpi18n = require('../utils/i18n.js')
const CODES = base.LANGS.map((l) => l.code)

console.log('多语言 / 地区节假日联动测试')

test('11 种苹果实时翻译语言齐全，各绑定一个地区', () => {
  assert.strictEqual(base.LANGS.length, 11)
  assert.deepStrictEqual(CODES, [
    'zh-CN', 'zh-TW', 'en-US', 'en-GB', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'pt-BR',
  ])
  assert.ok(base.LANGS.every((l) => l.code && l.label && l.region))
  assert.strictEqual(extra.CODES.join(','), CODES.join(','))
  for (const l of base.LANGS) assert.ok(base.LOCALES[l.code], l.code + ' 缺 locale')
})

test('基础字典 129 键 × 11 语言完整，无缺失无多余', () => {
  const keys = Object.keys(base.I18N['zh-CN'])
  assert.strictEqual(keys.length, 129)
  for (const c of CODES) {
    assert.ok(base.I18N[c], c + ' 缺整段字典')
    assert.deepStrictEqual(Object.keys(base.I18N[c]).sort(), keys.slice().sort(), c + ' 键不齐')
    // prio_suffix 在西方语言里故意为空（优先级词本身已含「优先级」含义，不再叠后缀）
    assert.ok(Object.keys(base.I18N[c]).every((k) => base.I18N[c][k] || k === 'prio_suffix'), c + ' 有空词条')
  }
})

test('补充字典每个键 11 个值齐全，且占位符在 11 种语言一致', () => {
  const keys = Object.keys(extra.ROWS)
  assert.ok(keys.length >= 400, '补充字典键数异常：' + keys.length)
  const placeholders = (v) => (String(v).match(/\{\w+\}/g) || []).sort().join(',')
  for (const k of keys) {
    const row = extra.ROWS[k]
    assert.strictEqual(row.length, 11, k + ' 不是 11 个值')
    assert.ok(row.every((v) => typeof v === 'string' && v.length), k + ' 有空值')
    const p0 = placeholders(row[0])
    row.forEach((v, i) => assert.strictEqual(placeholders(v), p0, k + ' 第 ' + i + ' 种语言占位符不一致'))
    CODES.forEach((c) => assert.strictEqual(extra.EXTRA[k][c], row[CODES.indexOf(c)], k + '/' + c + ' 映射错位'))
  }
})

test('Web 与小程序共享的 3 份字典/地区表 md5 完全一致', () => {
  const pairs = [
    ['webapp/i18n.js', 'utils/i18n-data.js'],
    ['webapp/i18n-extra.js', 'utils/i18n-extra.js'],
    ['webapp/holidays-region.js', 'utils/holidays-region.js'],
  ]
  for (const [a, b] of pairs) assert.strictEqual(md5(a), md5(b), a + ' 与 ' + b + ' 不同步')
})

test('每个语言绑定的地区都有对应节假日表，格式合法且全部是 2027 年', () => {
  const regions = Array.from(new Set(base.LANGS.map((l) => l.region)))
  assert.deepStrictEqual(Object.keys(regionHolidays).sort(), regions.sort())
  for (const rg of Object.keys(regionHolidays)) {
    const rows = regionHolidays[rg]
    assert.ok(Array.isArray(rows) && rows.length >= 8, rg + ' 节假日太少')
    for (const r of rows) {
      assert.ok(/^2027-\d{2}-\d{2}$/.test(r.day), rg + ' 日期非法：' + r.day)
      assert.ok(r.name && (r.kind === 'holiday' || r.kind === 'workday'), rg + ' 字段非法')
    }
  }
})

test('中国大陆地区表原样复用 HOLIDAYS_2027（含调休补班 workday）', () => {
  const cn = require('../webapp/holidays-2027.js').HOLIDAYS_2027
  assert.deepStrictEqual(regionHolidays.cn, cn)
  assert.ok(regionHolidays.cn.some((r) => r.kind === 'workday'))
})

test('语言 → 地区 → 节假日：切到日语真的换成日本祝日表', () => {
  // 与 webapp/app.js 的 buildHolidayMap(region) 同构
  function buildMap(region) {
    const rows = regionHolidays[region] || []
    const m = {}
    rows.forEach((r) => { m[r.day] = r.kind === 'workday' ? 'workday' : 'holiday' })
    return m
  }
  const cn = buildMap('cn')
  const jp = buildMap('jp')
  const kr = buildMap('kr')
  const us = buildMap('us')
  assert.strictEqual(jp['2027-02-23'], 'holiday', '日本天皇誕生日应在日语地区生效')
  assert.strictEqual(cn['2027-02-23'], undefined, '中国大陆表不应有日本假日')
  assert.strictEqual(cn['2027-07-19'], undefined)
  assert.strictEqual(jp['2027-05-05'], 'holiday', '日本こどもの日')
  assert.strictEqual(kr['2027-03-01'], 'holiday', '韩国三一節')
  assert.strictEqual(us['2027-07-05'], 'holiday', '美国独立日补休')
  assert.strictEqual(cn['2027-10-01'], 'holiday', '中国国庆节')
  // 每个地区至少与 cn 有一半以上不同，避免「切了语言其实还是同一张表」
  for (const rg of ['us', 'gb', 'jp', 'kr', 'de', 'fr', 'es', 'it', 'br']) {
    const m = buildMap(rg)
    const diff = Object.keys(m).filter((d) => m[d] !== cn[d]).length
    assert.ok(diff > Object.keys(m).length / 2, rg + ' 与 cn 表几乎相同，疑似未切换')
  }
})

test('行为级：store.mergeActiveHolidays 按 region 真的换表，非中国大陆忽略云端行', () => {
  const Module = require('module')
  const origLoad = Module._load
  const fakeDb = {}
  const fakeCloud = { init() {}, database() { return fakeDb }, callFunction() {} }
  global.wx = {
    cloud: fakeCloud,
    getStorageSync() { return '' },
    setStorageSync() {},
  }
  Module._load = function (request, parent) {
    if (parent && /utils[\\/]store\.js$/.test(parent.filename || '') && request === './cloud') {
      return { db: fakeDb, cloud: fakeCloud, callFunction: () => Promise.resolve({}) }
    }
    return origLoad.apply(this, arguments)
  }
  let store
  try {
    delete require.cache[require.resolve('../utils/store')]
    store = require('../utils/store')
  } finally {
    Module._load = origLoad
    delete global.wx
  }
  const has = (rows, day) => rows.some((r) => r.day === day)
  const cn = store.mergeActiveHolidays([], 'cn')
  const jp = store.mergeActiveHolidays([], 'jp')
  const kr = store.mergeActiveHolidays([], 'kr')
  assert.strictEqual(has(cn, '2027-10-01'), true, '中国大陆表丢了国庆节')
  assert.strictEqual(has(jp, '2027-02-23'), true, '日本表没切过来（天皇誕生日）')
  assert.strictEqual(has(cn, '2027-02-23'), false, '中国大陆表里混进了日本假日')
  assert.strictEqual(has(jp, '2027-10-01'), false, '日本表里还留着中国国庆')
  assert.strictEqual(has(kr, '2027-03-01'), true, '韩国表没切过来（三一節）')
  // 非中国大陆地区绝不读云端公共表：塞一条中国口径的行进去也不该出现
  const polluted = store.mergeActiveHolidays([{ day: '2027-10-01', name: '国庆节', kind: 'holiday' }], 'jp')
  assert.strictEqual(has(polluted, '2027-10-01'), false, '非中国地区用了云端公共 holidays 行')
  // 中国大陆路径仍能用云端行覆盖，原有能力不能丢
  const cnOverride = store.mergeActiveHolidays([{ day: '2027-10-01', name: '自定义', kind: 'workday' }], 'cn')
  assert.strictEqual(cnOverride.filter((r) => r.day === '2027-10-01')[0].kind, 'workday')
})

test('webapp/app.js 的 holidayMap 由 region 构建，切换语言会重建', () => {
  const js = read('webapp/app.js')
  assert.ok(js.includes('REGION_HOLIDAYS[region]'), '未按地区取节假日表')
  assert.ok(js.includes('this.holidayMap = buildHolidayMap(regionOf(c))'), '切语言未重建 holidayMap')
  assert.ok(js.includes('core.nextOccurrence(list[i], Date.now(), this.holidayMap)'), '下一次提醒未使用响应式 map')
  assert.ok(js.includes('core.nextOccurrence(t, Date.now(), this.holidayMap)'), '卡片下次提醒未使用响应式 map')
  assert.ok(js.includes("app.config.globalProperties.$t"), '模板 $t 未注册')
  assert.ok(js.includes('visibleProviders'), '登录按钮未按地区过滤')
  assert.ok(js.includes('rs.indexOf(rg) >= 0'), '地区过滤条件缺失')
})

test('网页端模板与逻辑没有残留写死的可见中文', () => {
  const html = read('webapp/index.html')
  const body = html.slice(html.indexOf('<body>'), html.indexOf('<!-- 本地 Vue'))
  const cjk = body.split('\n').filter((l) => /[\u4e00-\u9fff]/.test(l) && !l.trim().startsWith('<!--'))
  assert.deepStrictEqual(cjk, [], 'index.html 仍有中文：' + cjk.slice(0, 3).join(' | '))
  const js = read('webapp/app.js')
  assert.ok(!/showToast\('[\u4e00-\u9fff]/.test(js), 'app.js 仍有中文 toast 字面量')
})

test('Service Worker 缓存了全部新字典并升到 v4', () => {
  const sw = read('webapp/sw.js')
  assert.ok(sw.includes("'kiwi-web-v4'"))
  for (const f of ['i18n.js', 'i18n-extra.js', 'holidays-region.js']) {
    assert.ok(sw.includes("'./" + f + "'"), 'SW 未缓存 ' + f)
  }
  assert.ok(sw.includes("url.pathname.indexOf('oauth-callback.html') >= 0"), '回调页不能进缓存')
})

test('index.html 桥接了字典与地区表，语言选择器三处都在', () => {
  const html = read('webapp/index.html')
  for (const k of ['window.KIWI_LANGS', 'window.KIWI_I18N', 'window.KIWI_I18N_EXTRA',
    'window.KIWI_REGION_HOLIDAYS']) {
    assert.ok(html.includes(k), '缺桥接 ' + k)
  }
  assert.ok((html.match(/setLang\(\$event\.target\.value\)/g) || []).length >= 3, '语言选择器不全')
  assert.ok(html.includes('langList'), '语言列表未注入')
  assert.ok(html.includes("holiday_from"), '未展示当前地区节假日来源')
})

test('OAuth 回调页跟随语言，且仍不缓存、仍校验 state', () => {
  const cb = read('webapp/oauth-callback.html')
  assert.ok(cb.includes('KIWI_CB_BASE') && cb.includes('KIWI_CB_EXTRA'))
  assert.ok(cb.includes("kiwi_web_lang"), '回调页未读主界面的语言选择')
  assert.ok(cb.includes("params.get('state') !== saved.state"))
  assert.ok(cb.includes("'oauthCallback'") && cb.includes('kiwi_web_token'))
  const cjk = cb.split('\n').filter((l) => /[\u4e00-\u9fff]/.test(l) &&
    !l.trim().startsWith('//') && !l.trim().startsWith('/*') && !l.trim().startsWith('*') &&
    !l.trim().startsWith('<!--') && !/KIWI待办/.test(l))
  assert.deepStrictEqual(cjk, [], '回调页仍有中文提示：' + cjk.slice(0, 2).join(' | '))
})

test('小程序 i18n 封装：无 wx 环境可用，取词/地区/回退正确', () => {
  assert.strictEqual(mpi18n.LANGS.length, 11)
  assert.strictEqual(mpi18n.region('ja'), 'jp')
  assert.strictEqual(mpi18n.region('ko'), 'kr')
  assert.strictEqual(mpi18n.region('pt-BR'), 'br')
  assert.strictEqual(mpi18n.region('zh-TW'), 'cn')
  assert.strictEqual(mpi18n.region('不存在的语言'), 'cn')
  assert.strictEqual(mpi18n.t('app_name', {}, 'zh-CN'), 'KIWI待办')
  // 品牌名在 ja / en 都保留罗马字，改用长句验证语言确实不同
  assert.notStrictEqual(mpi18n.t('howto', {}, 'ja'), mpi18n.t('howto', {}, 'en-US'))
  assert.ok(mpi18n.t('holiday_from', { name: 'Japan' }, 'en-US').includes('Japan'), '占位符未替换')
  assert.strictEqual(mpi18n.t('不存在的键'), '不存在的键', '缺词应回退 key 本身')
  const captured = {}
  mpi18n.applyPage({ setData: (d) => Object.assign(captured, d) })
  assert.ok(captured.T && captured.lang && captured.region && captured.regionName)
})

test('小程序「我的」页提供 11 语言选择器，切换即重置节假日缓存', () => {
  const wxml = read('pages/mine/mine.wxml')
  const js = read('pages/mine/mine.js')
  assert.ok(wxml.includes('T.mp_lang_card') && wxml.includes('onLangChange'))
  assert.ok(js.includes('i18n.LANGS') && js.includes('app.setLang(item.code)'))
  assert.ok(js.includes('subscribe.renew()'), 'picker 的 change 不在 tap 同步链，必须自己补额度')
  const appJs = read('app.js')
  assert.ok(appJs.includes('setLang(code)'))
  assert.ok(appJs.includes('holidaysLoaded = false'), '切语言未作废 holidayMap 缓存')
  assert.ok(appJs.includes('holidayMap = {}'), '切语言未清空旧地区 map')
  assert.ok(appJs.includes('refreshTabBar()'))
})

test('小程序首页/节假日页按地区取表，非中国大陆不读写公共 holidays 表', () => {
  const idx = read('pages/index/index.js')
  const hol = read('pages/holidays/holidays.js')
  const store = read('utils/store.js')
  assert.ok(store.includes('regionSeed(region)'), 'store 未按地区取内置种子')
  assert.ok(store.includes("region !== 'cn'"), 'store 未区分地区')
  assert.ok(store.includes('HOLIDAYS_REGION[region]'))
  assert.ok(idx.includes("if (region !== 'cn')"), '首页未做地区分支')
  assert.ok(hol.includes("if (region !== 'cn')"), '节假日页未做地区分支')
  assert.ok(hol.includes('guardReadOnly()'), '非中国地区应只读，避免写脏公共表')
  // cn 默认路径保持原逻辑不变
  assert.ok(store.includes('holidaysActive.filterFrom(dbRows || [], MIN_HOLIDAY_YEAR)'))
  assert.ok(store.includes('const SEED_HOLIDAYS = HOLIDAYS_2027'))
})

test('小程序 6 个页面 WXML 无残留写死的可见中文（注释不算）', () => {
  const files = ['pages/mine/mine.wxml', 'pages/index/index.wxml',
    'pages/holidays/holidays.wxml', 'pages/history/history.wxml',
    'pages/edit/edit.wxml', 'pages/invite/invite.wxml']
  for (const f of files) {
    const body = read(f).replace(/<!--[\s\S]*?-->/g, '')
    const lines = body.split('\n').filter((l) => /[\u4e00-\u9fff]/.test(l))
    assert.deepStrictEqual(lines, [], f + ' 仍有可见中文：' + lines.slice(0, 2).join(' | '))
  }
})

test('所有页面 JS 的用户可见提示都走字典，不再写死中文', () => {
  const files = ['pages/index/index.js', 'pages/history/history.js', 'pages/mine/mine.js',
    'pages/holidays/holidays.js', 'pages/edit/edit.js', 'pages/invite/invite.js',
    'custom-tab-bar/index.js']
  for (const f of files) {
    const lines = read(f).split('\n').filter((l) => /[\u4e00-\u9fff]/.test(l) &&
      /showToast|showModal|showLoading|showActionSheet|NavigationBarTitle/.test(l) &&
      !/^\s*(\/\/|\/\*|\*|<!--)/.test(l))
    assert.deepStrictEqual(lines, [], f + ' 仍有中文提示：' + lines.slice(0, 2).join(' | '))
  }
})

test('展示格式化层接管 reminder-core 的中文输出，且自身不写死中文', () => {
  const js = read('utils/i18n-format.js')
  const names = ['weekday', 'weekHead', 'dateLabel', 'priorityText', 'repeatNames',
    'actionNames', 'priorityNames', 'intervalUnit', 'describeRepeat',
    'describeRepeatRange', 'describeRepeatDates']
  for (const n of names) assert.ok(js.includes(n + ': ' + n), '缺导出 ' + n)
  const cjk = js.split('\n').filter((l) => /[\u4e00-\u9fff]/.test(l) &&
    !/^\s*(\/\/|\/\*|\*)/.test(l))
  assert.deepStrictEqual(cjk, [], 'i18n-format 不应写死中文')
  for (const f of ['pages/edit/edit.js', 'pages/invite/invite.js', 'pages/history/history.js']) {
    const s = read(f)
    assert.ok(!/core\.(describeRepeat|describeRepeatRange|describeRepeatDates|priorityText)\(/.test(s),
      f + ' 展示层仍在直调返回中文的 core 函数')
  }
})

test('历史页 / 编辑页的 holidayMap 兜底按当前地区重建（切语言不再落回中国大陆表）', () => {
  const hist = read('pages/history/history.js')
  const edit = read('pages/edit/edit.js')
  for (const [name, s] of [['history', hist], ['edit', edit]]) {
    assert.ok(s.includes('i18n.region()'), name + ' 未取当前地区')
    assert.ok(/mergeActiveHolidays\(rows, region\)/.test(s), name + ' 未按地区合并节假日表')
    assert.ok(/core\.buildHolidayMap\(store\.mergeActiveHolidays/.test(s), name + ' 地区表未进 holidayMap')
    assert.ok(/region === 'cn' && cached && cached\.rows/.test(s), name + ' 非中国地区不能拿 CN 缓存覆盖')
  }
  assert.ok(edit.includes('ensureHolidayMap()'), '编辑页缺地区节假日兜底方法')
  const onLoad = edit.slice(edit.indexOf('onLoad(options)'), edit.indexOf('onShareAppMessage()'))
  assert.ok(onLoad.includes('this.ensureHolidayMap()'), 'onLoad 未先建地区节假日表')
  assert.ok(/onLangChanged\(code\)[\s\S]{0,400}this\.ensureHolidayMap\(\)/.test(edit),
    '切语言未重建地区节假日表')
  assert.ok(edit.includes('typeof store.mergeActiveHolidays'), '兜底需兼容测试 stub，避免直调不存在的 API')
})

test('编辑页 / 邀请页切语言会重算文案，节假日标签按地区名动态生成', () => {
  for (const f of ['pages/edit/edit.js', 'pages/invite/invite.js']) {
    const s = read(f)
    assert.ok(s.includes('i18n.applyPage(this)'), f + ' 未注入字典')
    assert.ok(s.includes('_lastLang'), f + ' 未检测语言变化')
    assert.ok(s.includes('onLangChanged('), f + ' 未实现 onLangChanged')
  }
  const edit = read('pages/edit/edit.js')
  assert.ok(edit.includes("t('ed_holiday_skip', { name: i18n.regionName() })"),
    '节假日跳过标签未按地区名生成')
  assert.ok(read('pages/edit/edit.wxml').includes('{{holidaySkipText}}'), 'WXML 未使用动态地区标签')
  const rows = require('../webapp/i18n-extra.js').ROWS
  assert.ok(rows.ed_holiday_skip.every((v) => v.includes('{name}')), '地区名占位符在 11 语言里不齐')
  assert.strictEqual(mpi18n.t('ed_holiday_skip', { name: mpi18n.t('region_name', {}, 'zh-CN') }, 'zh-CN'),
    '中国大陆节假日跳过', '中国大陆口径不能被改坏')
})

test('自定义 tabBar 跟随语言，3 个 tab 页 onShow 都会刷新文案', () => {
  const bar = read('custom-tab-bar/index.js')
  assert.ok(bar.includes('applyLang()') && bar.includes('mp_tab_history_full'))
  for (const f of ['pages/index/index.js', 'pages/history/history.js', 'pages/mine/mine.js']) {
    assert.ok(read(f).includes('applyLang()'), f + ' onShow 未刷新 tabBar 文案')
  }
})

test('八个 OAuth 平台带 regions，当地平台只在对应地区出现', () => {
  const oa = read('cloudfunctions/webapi/oauth.js')
  for (const p of ['github', 'google', 'apple', 'x', 'wechat', 'line', 'kakao', 'naver']) {
    assert.ok(oa.includes("id: '" + p + "'"), '缺 ' + p)
  }
  assert.ok(oa.includes("regions: ['jp']") && oa.includes("regions: ['kr']") && oa.includes("regions: ['cn']"))
  assert.ok(oa.includes('regions: p.regions || []'), 'listProviders 未返回 regions')
  const idx = read('cloudfunctions/webapi/index.js')
  assert.ok(idx.includes('regions: p.regions || []'), 'actOauthProviders 下发丢了 regions')
})

test('提醒链路零改动：5 份 reminder-core 与 4 份中国节假日表仍一致', () => {
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
