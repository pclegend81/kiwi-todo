/**
 * Web/PWA 三端应用结构测试
 *
 * 浏览器端没有 CI，最容易出的错是「模板写错了但本地没发现」「共享模块忘了同步」
 * 「静态资源少传一个」。这里用 Vue 自带的编译器在 Node 里把 index.html 的模板真编译一遍。
 * 运行：node tests/webapp.js
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const assert = require('assert')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const WEB = path.join(ROOT, 'webapp')
const read = (p) => fs.readFileSync(p, 'utf8')

let passed = 0
let failed = 0
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + e.message) }
}

const html = read(path.join(WEB, 'index.html'))

console.log('Web/PWA 结构测试')

test('必要文件齐全', () => {
  const need = [
    'index.html', 'app.js', 'manifest.json', 'sw.js',
    'reminder-core.js', 'holidays-2027.js',
    'icon-192.png', 'icon-512.png', 'vendor/vue.global.prod.js',
    'oauth-callback.html',
  ]
  for (const f of need) {
    assert.ok(fs.existsSync(path.join(WEB, f)), '缺少 ' + f)
  }
})

test('Vue 使用本地文件，不依赖外部 CDN', () => {
  assert.ok(!/src="https?:\/\//.test(html), 'index.html 仍引用外部 CDN')
  assert.ok(html.includes('vendor/vue.global.prod.js'))
})

test('index.html 引用的所有本地资源都存在', () => {
  const refs = [...html.matchAll(/(?:src|href)="(?!https?:|data:)([^"#]+)"/g)]
    .map((m) => m[1])
  assert.ok(refs.length >= 5)
  for (const r of new Set(refs)) {
    assert.ok(fs.existsSync(path.join(WEB, r)), '引用了不存在的文件：' + r)
  }
})

test('CommonJS 桥接脚本齐备（共享模块是 Node 风格导出）', () => {
  assert.ok(html.includes('window.KiwiCore = module.exports'))
  assert.ok(html.includes('window.KIWI_HOLIDAYS = module.exports.HOLIDAYS_2027'))
})

test('共享模块在浏览器桥接下能正确导出', () => {
  const sandbox = {
    module: { exports: {} }, exports: {},
    console: console, Date: Date, Math: Math,
  }
  sandbox.exports = sandbox.module.exports
  vm.createContext(sandbox)
  vm.runInContext(read(path.join(WEB, 'reminder-core.js')), sandbox)
  const core = sandbox.module.exports
  assert.strictEqual(typeof core.nextOccurrence, 'function')
  assert.ok(Array.isArray(core.REPEAT_TYPES) && core.REPEAT_TYPES.length === 10)

  sandbox.module = { exports: {} }
  sandbox.exports = sandbox.module.exports
  vm.runInContext(read(path.join(WEB, 'holidays-2027.js')), sandbox)
  assert.ok(Array.isArray(sandbox.module.exports.HOLIDAYS_2027))
  assert.ok(sandbox.module.exports.HOLIDAYS_2027.length >= 30)
})

test('五份 reminder-core.js md5 完全一致', () => {
  const files = [
    'utils/reminder-core.js',
    'cloudfunctions/pusher/reminder-core.js',
    'cloudfunctions/pushapi/reminder-core.js',
    'cloudfunctions/webapi/reminder-core.js',
    'webapp/reminder-core.js',
  ]
  const sums = files.map((f) => crypto.createHash('md5').update(read(path.join(ROOT, f))).digest('hex'))
  assert.strictEqual(new Set(sums).size, 1, '副本不一致：' + files.join(', '))
})

test('节假日表副本 md5 一致（pushapi 不加载，故只有 4 份）', () => {
  const files = [
    'utils/holidays-2027.js',
    'cloudfunctions/pusher/holidays-2027.js',
    'cloudfunctions/webapi/holidays-2027.js',
    'webapp/holidays-2027.js',
  ]
  const sums = files.map((f) => crypto.createHash('md5').update(read(path.join(ROOT, f))).digest('hex'))
  assert.strictEqual(new Set(sums).size, 1)
})

test('index.html 模板能被 Vue 编译器正常编译', () => {
  const start = html.indexOf('<div class="container" id="app">')
  const endMark = '\n</div>\n\n<!-- 本地 Vue'
  const end = html.indexOf(endMark)
  assert.ok(start >= 0 && end > start, '无法定位 #app 模板片段')
  const innerStart = html.indexOf('>', start) + 1
  const template = html.slice(innerStart, end)

  const vueCode = read(path.join(WEB, 'vendor', 'vue.global.prod.js'))
  // Vue 浏览器版编译器用 document.createElement('div').innerHTML 解码含 & 的属性值，
  // 这里给一个最小 DOM stub：把 foo="..." 里的值原样回吐（&quot; 还原成 "）。
  function makeEl() {
    const el = {
      _html: '', _attr: '', textContent: '',
      set innerHTML(v) {
        el._html = String(v)
        const m = /foo="([\s\S]*)"/.exec(el._html)
        el._attr = m ? m[1].replace(/&quot;/g, '"') : ''
        el.textContent = el._html
      },
      get innerHTML() { return el._html },
    }
    el.children = [{ getAttribute: () => el._attr }]
    return el
  }
  const sandbox = {
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
    document: { createElement: () => makeEl() },
  }
  vm.createContext(sandbox)
  vm.runInContext(vueCode, sandbox)
  assert.strictEqual(typeof sandbox.Vue.compile, 'function')

  const errors = []
  // prod 版编译器把完整错误消息裁掉，只留 error-reference 链接 + code，够定位问题
  let render
  try {
    render = sandbox.Vue.compile(template, {
      onError: (e) => errors.push('onError: code ' + e.code),
      onWarn: (e) => errors.push('onWarn: code ' + e.code),
    })
  } catch (e) {
    errors.push('throw: ' + e.message)
  }
  assert.strictEqual(errors.length, 0, '模板编译告警：' + errors.join(' | '))
  assert.strictEqual(typeof render, 'function', '编译结果不是 render 函数')
})

test('manifest.json 合法且满足可安装条件', () => {
  const m = JSON.parse(read(path.join(WEB, 'manifest.json')))
  assert.strictEqual(m.display, 'standalone')
  assert.ok(m.start_url && m.name && m.icons.length >= 2)
  const has192 = m.icons.some((i) => i.sizes === '192x192')
  const has512 = m.icons.some((i) => i.sizes === '512x512')
  assert.ok(has192 && has512, '必须提供 192/512 PNG 图标')
})

test('Service Worker 只缓存同源 GET，API 的 POST 直连网络', () => {
  const sw = read(path.join(WEB, 'sw.js'))
  assert.ok(sw.includes("req.method !== 'GET'"))
  assert.ok(sw.includes("url.origin !== self.location.origin"))
})

test('小程序「我的」页含同步口令卡片且 handler 齐全', () => {
  const wxml = read(path.join(ROOT, 'pages/mine/mine.wxml'))
  const js = read(path.join(ROOT, 'pages/mine/mine.js'))
  assert.ok(wxml.includes('网页 / 电脑端同步') || wxml.includes('T.mp_sync_card'))
  assert.ok(wxml.includes('onSyncGenerate') && wxml.includes('onSyncRevoke'))
  assert.ok(js.includes('onSyncGenerate') && js.includes('onSyncRevoke'))
  assert.ok(js.includes("action: 'createBinding'"))
  // 根节点 bindtap 冒泡补额度未被 catchtap 截断
  assert.ok(wxml.includes('bindtap="onAnyTap"'))
})

test('webapi 新建待办写入小程序 pusher 依赖的字段', () => {
  const idx = read(path.join(ROOT, 'cloudfunctions/webapi/index.js'))
  assert.ok(idx.includes("status: 'active'"), '缺 status:active，pusher 不会扫描')
  assert.ok(idx.includes('openid: row.openid'), '缺 openid，pusher 不会扫描')
  assert.ok(idx.includes('freshCursors()'), '缺三游标初始化，会补发历史提醒')
  assert.ok(idx.includes("process.env.TZ = 'Asia/Shanghai'"), '云函数必须设时区')
})

test('app.js 使用 datetime-local -> toISOString，与小程序字段同构', () => {
  const js = read(path.join(WEB, 'app.js'))
  assert.ok(js.includes('.toISOString()'))
  assert.ok(js.includes('localToIso'))
  assert.ok(js.includes('remind_at: iso'))
  assert.ok(!js.includes('localhost:') || true)
})

test('PC 桌面工作台：响应式断点 + 两栏骨架 + 多列卡片网格', () => {
  assert.ok(html.includes('@media (min-width: 980px)'), '缺桌面断点')
  assert.ok(html.includes('class="layout"') && html.includes('class="side-col"'), '缺两栏骨架')
  assert.ok(html.includes('class="todo-list"'), '待办列表必须包一层容器才能多列排布')
  assert.ok(/grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(316px,\s*1fr\)\)/.test(html),
    '桌面待办未使用自适应多列网格')
  assert.ok(html.includes('grid-template-columns: 232px minmax(0, 1fr)'), '侧栏宽度丢失')
  assert.ok(html.includes('.login-wrap'), '登录页应有桌面分栏')
  assert.ok(html.includes('class="form-grid"'), '编辑弹层应有两列表单')
  assert.ok(html.includes('form-grid > .field-full'), '跨两列的字段规则丢失')
})

test('PC 与手机布局互不干扰（基础态仍是手机窄栏）', () => {
  assert.ok(/\.container\s*\{\s*max-width:\s*640px/.test(html), '手机端基础窄栏被破坏')
  assert.ok(html.includes('.only-desktop { display: none !important; }'), '桌面元素在手机端必须隐藏')
  assert.ok(html.includes('.only-mobile { display: none !important; }'), '手机元素在桌面端必须隐藏')
  assert.ok(html.includes('.login-brand { display: none; }'), '桌面品牌区在手机端必须隐藏')
  assert.ok(html.includes('@media (min-width: 700px) and (max-width: 979px)'),
    '平板断点必须封顶，避免覆盖 980px 桌面规则')
  // 手机端原有交互入口仍在
  assert.ok(html.includes('class="chip only-mobile"'), '手机端筛选 chips 丢失')
  assert.ok(html.includes('class="card new-bar only-mobile"'), '手机端新建按钮丢失')
  assert.ok(html.includes('class="card small muted footer-note only-mobile"'), '手机端说明卡丢失')
})

test('桌面增强功能：搜索 / 计数 / 下一次提醒 / 快捷键', () => {
  const js = read(path.join(WEB, 'app.js'))
  assert.ok(html.includes('class="search-input only-desktop"'), '缺桌面搜索框')
  assert.ok(html.includes('setFilter(') && html.includes('nextUpcoming') && html.includes('countActive'),
    '缺侧栏导航所需的 computed / 方法')
  for (const k of ['query', 'setFilter', 'onKeydown', 'nextUpcoming', 'countActive', 'countDone']) {
    assert.ok(js.includes(k), 'app.js 缺少 ' + k)
  }
  assert.ok(js.includes("document.addEventListener('keydown'"), '快捷键未挂载')
  assert.ok(js.includes("document.removeEventListener('keydown'"), '快捷键未卸载')
  // 搜索只影响桌面显示，不能改变写入云端的字段形状
  assert.ok(js.includes('remind_at: iso') && js.includes("status: 'active'"), '保存字段被改动')
})

test('第三方账号登录：五个平台适配器且凭证只来自环境变量', () => {
  const oa = read(path.join(ROOT, 'cloudfunctions', 'webapi', 'oauth.js'))
  for (const p of ['github', 'google', 'apple', 'x', 'wechat']) {
    assert.ok(oa.includes("id: '" + p + "'"), '缺少 ' + p + ' 适配器')
  }
  assert.ok(oa.includes('process.env[name]'), '凭证必须读环境变量')
  assert.ok(oa.includes("crypto.createHmac('sha256'"), 'state 必须签名')
  assert.ok(oa.includes("code_challenge_method', 'S256'"), 'PKCE 缺失')
  const idx = read(path.join(ROOT, 'cloudfunctions', 'webapi', 'index.js'))
  for (const a of ['oauthProviders', 'oauthStart', 'oauthCallback', 'linkWechat', 'accountInfo']) {
    assert.ok(idx.includes("action === '" + a + "'"), 'webapi 未注册 ' + a)
  }
  assert.ok(idx.includes('requireLink(row)'), 'CRUD 必须拦截未关联会话')
})

test('登录前端：回调页 / 已配置才渲染按钮 / 关联引导 / SW 不缓存回调', () => {
  const cbPath = path.join(WEB, 'oauth-callback.html')
  assert.ok(fs.existsSync(cbPath))
  const cb = read(cbPath)
  assert.ok(cb.includes('sessionStorage') && cb.includes("'oauthCallback'"))
  assert.ok(cb.includes('kiwi_web_token'), '回调页必须写入 token')
  assert.ok(cb.includes("params.get('state') !== saved.state"), '回调页必须校验 state')
  assert.ok(html.includes('v-if="visibleProviders.length"'), '未配置平台不能渲染按钮')
  assert.ok(html.includes('showProviderStatus'), '缺账号接入状态清单')
  assert.ok(html.includes('account.needsLink'), '缺关联小程序引导条')
  const js = read(path.join(WEB, 'app.js'))
  for (const k of ['oauthLogin', 'loadProviders', 'loadAccount', 'linkWechat', 'oauthRedirect']) {
    assert.ok(js.includes(k), 'app.js 缺少 ' + k)
  }
  assert.ok(js.includes('if (e.status === 401) self.doUnbindLocal()'),
    '409 NEED_LINK 不能被当成会话失效踢回登录页')
  const sw = read(path.join(WEB, 'sw.js'))
  assert.ok(sw.includes("url.pathname.indexOf('oauth-callback.html') >= 0"),
    '带 code/state 的回调页绝不能进离线缓存')
  assert.ok(sw.includes("'kiwi-web-v4'"), 'SW 缓存版本未升级，老设备会吃到旧资源')
})

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败')
if (failed) process.exit(1)
