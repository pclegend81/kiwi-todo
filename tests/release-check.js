/**
 * 发布 / 上架前门禁
 *   node tests/release-check.js
 *
 * ✓ / ✗  = 硬断言：微信提醒链路 + 多平台互通 + 交付一致性；任一失败退出码非 0。
 * [状态] = 不判失败、但提审 / 上架前必须人工确认的事项（例如 trial -> formal）。
 *
 * 这个脚本不替代真机验收，只保证「配置与共享副本没有悄悄回退」。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const assert = require('assert')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const exists = (p) => fs.existsSync(path.join(ROOT, p))
const md5 = (p) => crypto.createHash('md5').update(read(p)).digest('hex')

let passed = 0
let failed = 0
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + e.message) }
}

const PAGES = ['index', 'edit', 'invite', 'history', 'holidays', 'mine']
const pusher = read('cloudfunctions/pusher/index.js')
const pushapi = read('cloudfunctions/pushapi/index.js')
const webapi = read('cloudfunctions/webapi/index.js')
const webApp = read('webapp/app.js')
const sw = read('webapp/sw.js')

console.log('\n【A】微信订阅消息提醒链路')

test('pusher 定时器触发器 + subscribeMessage.send 权限都在 config.json', () => {
  const cfg = JSON.parse(read('cloudfunctions/pusher/config.json'))
  assert.ok(cfg.permissions.openapi.indexOf('subscribeMessage.send') >= 0, '缺 openapi 权限')
  const timer = (cfg.triggers || []).filter((t) => t.type === 'timer')[0]
  assert.ok(timer, '缺 timer 触发器（没单独上传 config.json 时真实提醒不触发）')
  assert.ok(/^0 \* \* \* \* \* \*$/.test(timer.config), '触发器不是每分钟：' + timer.config)
  assert.ok(JSON.parse(read('cloudfunctions/pushapi/config.json'))
    .permissions.openapi.indexOf('subscribeMessage.send') >= 0, 'pushapi 缺 openapi 权限')
})

test('模板 ID 三处（pusher / pushapi / utils/config.js）完全一致', () => {
  const a = (pusher.match(/const TEMPLATE_ID = '([^']+)'/) || [])[1]
  const b = (pushapi.match(/const TEMPLATE_ID = '([^']+)'/) || [])[1]
  const c = (read('utils/config.js').match(/var FALLBACK_TEMPLATE_ID = '([^']+)'/) || [])[1]
  assert.ok(a && a.length > 10, 'pusher 模板 ID 未配置')
  assert.strictEqual(a, b, 'pushapi 模板 ID 不一致')
  assert.strictEqual(a, c, '小程序 FALLBACK_TEMPLATE_ID 不一致')
})

test('pusher / pushapi 的 MINIPROGRAM_STATE 一致且取值合法', () => {
  const a = (pusher.match(/const MINIPROGRAM_STATE = '([^']+)'/) || [])[1]
  const b = (pushapi.match(/const MINIPROGRAM_STATE = '([^']+)'/) || [])[1]
  assert.ok(['trial', 'developer', 'formal'].indexOf(a) >= 0, 'pusher 取值非法：' + a)
  assert.strictEqual(a, b, '两处取值不一致，正式版/体验版会有一端收不到')
})

test('三个云函数都在 Date 运算前设置 Asia/Shanghai', () => {
  for (const f of ['pusher', 'pushapi', 'webapi']) {
    assert.ok(/process\.env\.TZ = 'Asia\/Shanghai'/.test(read('cloudfunctions/' + f + '/index.js')),
      f + ' 未设置时区（云端是 UTC）')
  }
})

test('推送游标只读 last_pushed_at，不回退读 last_reminded_at', () => {
  assert.ok(/todo\.last_pushed_at/.test(pusher), 'pusher 未读独立推送游标')
  assert.ok(/不回退读旧字段 last_reminded_at/.test(pusher), '缺防回退约束说明')
  assert.ok(/last_logged_at/.test(webapi) && /last_pushed_at/.test(webapi), 'webapi 新建待办没写齐游标')
})

test('43101 额度耗尽不推进游标，并把失败原因回传 pushHealth', () => {
  assert.ok(/43101/.test(pusher), 'pusher 未识别额度耗尽')
  assert.ok(/不推进游标/.test(pusher), '额度失败仍在推进游标')
  assert.ok(/last_push_error/.test(pusher) && /pushHealth/.test(pushapi), '失败原因没有回传给端上')
})

test('subscribe.js 有在途守卫与 1s 节流（并发会报 last call has not ended）', () => {
  const s = read('utils/subscribe.js')
  assert.ok(/let pending = false/.test(s), '缺在途守卫')
  assert.ok(/MIN_INTERVAL_MS = 1000/.test(s), '缺节流')
  assert.ok(/PENDING_TIMEOUT_MS/.test(s), '缺兜底超时')
})

test('6 页根节点都冒泡补额度，catchtap 入口自己同步 renew', () => {
  for (const p of PAGES) {
    assert.ok(/bindtap="onAnyTap"/.test(read('pages/' + p + '/' + p + '.wxml')),
      p + ' 根节点缺 onAnyTap')
    assert.ok(/onAnyTap: subscribe\.onAnyTap/.test(read('pages/' + p + '/' + p + '.js')),
      p + ' JS 缺 onAnyTap')
  }
  assert.ok(/catchtap="onSave"/.test(read('pages/edit/edit.wxml')), '保存按钮仍是 bindtap')
  assert.ok(/catchtap/.test(read('pages/index/index.wxml')), '首页缺 catchtap 入口')
  assert.ok(/subscribe\.renew\(\)/.test(read('pages/index/index.js')), 'catchtap 入口没自己补额度')
})

console.log('\n【B】多平台互通（小程序 / Web / PWA）')

test('webapi 走 HTTP 集成响应：CORS + OPTIONS 预检 + 12 个网页 action', () => {
  assert.ok(!exists('cloudfunctions/webapi/config.json'), 'webapi 不该有 config.json（那是 pusher 定时器的事）')
  assert.ok(/Access-Control-Allow-Origin/.test(webapi) && /httpMethod === 'OPTIONS'/.test(webapi), '缺 CORS / 预检')
  const actions = (webapi.match(/if \(action === '([A-Za-z]+)'\)/g) || [])
    .map((s) => s.match(/'([A-Za-z]+)'/)[1])
  assert.ok(actions.length >= 12, 'action 路由不足 12 个：' + actions.length)
  for (const a of ['bind', 'listTodos', 'insertTodo', 'updateTodo', 'removeTodo', 'stats']) {
    assert.ok(actions.indexOf(a) >= 0, '缺 action: ' + a)
  }
})

test('网页端只在 401 清会话，409 NEED_LINK 不踢登录', () => {
  assert.ok(/e\.status === 401/.test(webApp), '401 未清会话')
  assert.ok(/409 NEED_LINK/.test(webApp), '缺 409 说明')
  assert.ok(/NEED_LINK/.test(webapi), 'webapi 未返回 409 NEED_LINK')
})

test('webapi 新建待办写入 remind_at / status / openid / 三游标', () => {
  // 三游标由 freshCursors() 统一生成，不在 actInsertTodo 里逐字出现
  const cur = webapi.match(/function freshCursors\(\)[\s\S]*?\n}/)
  assert.ok(cur, '缺 freshCursors()')
  for (const k of ['last_logged_at', 'last_pushed_at', 'last_reminded_at']) {
    assert.ok(cur[0].indexOf(k) >= 0, '游标缺字段：' + k)
  }
  const seg = webapi.slice(webapi.indexOf('async function actInsertTodo'), webapi.indexOf('async function actUpdateTodo'))
  for (const k of ['freshCursors()', 'remind_at', 'status', 'openid', 'client_token', 'next_remind_at']) {
    assert.ok(seg.indexOf(k) >= 0, 'insertTodo 缺字段/调用：' + k)
  }
  // 游标不允许网页端传入，避免历史提醒被补发
  assert.ok(!/TODO_FIELDS[\s\S]*?last_logged_at/.test(webapi.slice(webapi.indexOf('const TODO_FIELDS'), webapi.indexOf('function freshCursors'))),
    '游标被放进了网页可写字段白名单')
})

test('协作 SHARE_FIELDS 两份（pushapi / utils/collab.js）完全一致', () => {
  const fields = (f) => {
    const m = read(f).match(/const SHARE_FIELDS = \[([\s\S]*?)\]/)
    assert.ok(m, f + ' 找不到 SHARE_FIELDS')
    return (m[1].replace(/\/\/[^\n]*/g, '').match(/'([a-z_]+)'/g) || [])
  }
  assert.deepStrictEqual(fields('cloudfunctions/pushapi/index.js'), fields('utils/collab.js'),
    '漏一份会导致协作成员拿不到新增字段')
})

test('8 个 OAuth 平台 + regions 地区过滤', () => {
  const o = read('cloudfunctions/webapi/oauth.js')
  const ids = (o.match(/id: '([a-z]+)'/g) || []).map((s) => s.match(/'([a-z]+)'/)[1])
  assert.strictEqual(ids.length, 8, '平台数不是 8：' + ids.join(','))
  for (const id of ['google', 'apple', 'github', 'x', 'wechat', 'line', 'kakao', 'naver']) {
    assert.ok(ids.indexOf(id) >= 0, '缺平台：' + id)
  }
  assert.ok(/regions: \['jp'\]/.test(o) && /regions: \['kr'\]/.test(o) && /regions: \['cn'\]/.test(o),
    '当地登录地区过滤缺失')
  assert.ok(/regions: p\.regions \|\| \[\]/.test(o), 'listProviders 未下发 regions')
})

test('6 页都直接挂 onShareAppMessage（不放 Behavior），首页额外挂 onShareTimeline', () => {
  // 两种合法写法：`onShareAppMessage: onShareAppMessage`（引用导出函数）
  // 或 `onShareAppMessage() { ... }`（方法本体直接写在 Page({}) 里）
  for (const p of PAGES) {
    const js = read('pages/' + p + '/' + p + '.js')
    assert.ok(/onShareAppMessage:\s*onShareAppMessage|onShareAppMessage\(\)\s*\{/.test(js),
      p + ' 未把转发函数直接挂在 Page({}) 上，真机会变灰')
    assert.ok(!/\bbehaviors\s*:/.test(js), p + ' 把分享放进了 Behavior，真机转发会变灰')
  }
  assert.ok(/onShareTimeline:\s*onShareTimeline/.test(read('pages/index/index.js')), '首页缺朋友圈分享')
})

test('SW 排除 OAuth 回调页、缓存声音模块且不缓存 POST', () => {
  assert.ok(/oauth-callback\.html/.test(sw), '回调页可能被离线缓存（授权码泄露）')
  assert.ok(/req\.method !== 'GET'\) return/.test(sw), 'POST 未绕过缓存')
  assert.ok(/'\.\/sound\.js'/.test(sw), 'sound.js 未进预缓存')
  assert.ok(/kiwi-web-v6/.test(sw), 'SW 版本不是 v6')
})

console.log('\n【C】交付一致性')

test('reminder-core 5 份 / 节假日表 4 份 / 字典与地区表 3 组 md5 一致', () => {
  const groups = [
    ['utils/reminder-core.js', 'cloudfunctions/pusher/reminder-core.js',
      'cloudfunctions/pushapi/reminder-core.js', 'cloudfunctions/webapi/reminder-core.js',
      'webapp/reminder-core.js'],
    ['utils/holidays-2027.js', 'cloudfunctions/pusher/holidays-2027.js',
      'cloudfunctions/webapi/holidays-2027.js', 'webapp/holidays-2027.js'],
    ['webapp/holidays-region.js', 'utils/holidays-region.js'],
    ['webapp/i18n.js', 'utils/i18n-data.js'],
    ['webapp/i18n-extra.js', 'utils/i18n-extra.js'],
  ]
  for (const g of groups) {
    assert.strictEqual(new Set(g.map(md5)).size, 1, '副本漂移：' + g.join(' / '))
  }
})

test('PWA manifest 描述与实际能力一致（不再写死中国大陆节假日）', () => {
  const m = JSON.parse(read('webapp/manifest.json'))
  assert.ok(/当地/.test(m.description) && !/中国大陆/.test(m.description),
    'manifest 描述过时：' + m.description)
  assert.ok(m.icons.length >= 2 && /standalone/.test(m.display), 'PWA 安装配置缺失')
})

test('分享卡片标题跟随当前语言', () => {
  const s = read('utils/share.js')
  assert.ok(/i18n\.t\('inv_share_default'\)/.test(s), '分享标题仍写死中文')
  assert.ok(/onShareAppMessage[\s\S]{0,200}title: shareTitle\(\)/.test(s) &&
    /onShareTimeline[\s\S]{0,120}title: shareTitle\(\)/.test(s), '两个分享入口未都用动态标题')
})

test('三端分发包存在且含新版资源', () => {
  for (const p of ['dist/kiwi-pc.zip', 'dist/kiwi-android.zip', 'dist/kiwi-ios.zip']) {
    assert.ok(exists(p), '缺分发包：' + p)
    const buf = fs.readFileSync(path.join(ROOT, p))
    for (const f of ['sound.js', 'i18n-extra.js', 'holidays-region.js', 'sw.js', 'manifest.json']) {
      assert.ok(buf.includes(Buffer.from(f)), p + ' 内缺 ' + f)
    }
  }
})

/* ── 不判失败、但提审 / 上架前必须人工确认 ── */
const state = (pusher.match(/const MINIPROGRAM_STATE = '([^']+)'/) || [])[1]
const builds = {
  pusher: (pusher.match(/const PUSHER_BUILD = '([^']+)'/) || [])[1],
  pushapi: (pushapi.match(/const BUILD = '([^']+)'/) || [])[1],
  webapi: (webapi.match(/const BUILD = '([^']+)'/) || [])[1],
  dataapi: (read('cloudfunctions/dataapi/index.js').match(/const BUILD = '([^']+)'/) || [])[1],
}

console.log('\n【状态】发布前人工确认项')
console.log('  MINIPROGRAM_STATE = ' + state + '（pusher + pushapi 一致）')
if (state !== 'formal') {
  console.log('  [状态] 体验版 / 提审阶段保持 ' + state + ' 是对的；小程序审核通过并')
  console.log('         正式发布后，必须把两处改成 formal、重新部署两个云函数并更新 BUILD，')
  console.log('         否则正式版用户收不到订阅消息。')
}
console.log('  云端 BUILD：' + JSON.stringify(builds))
console.log('  [状态] pusher/config.json 必须与云函数「单独上传」，只传 index.js 不触发定时器。')
console.log('  [状态] 网页端 remind_at 按设备本地时区解释；设备不在 UTC+8 时与云端北京口径会偏移。')
console.log('  [状态] 云端 pusher 仍按中国大陆节假日表判断跳过；语言/地区只影响端上显示与预览。')

console.log('\n【状态】App Store 材料缺口（本脚本只报告，不判失败）')
const gaps = []
if (!exists('webapp/privacy.html')) gaps.push('隐私政策页（App Store Connect 必填 Privacy Policy URL）')
if (!exists('webapp/icon-1024.png')) gaps.push('1024×1024 无圆角图标（当前只有 192 / 512）')
if (!exists('ios/') && !exists('capacitor.config.json')) gaps.push('原生 iOS 工程 / .ipa（当前只有 PWA，App Store 不接受纯网页套壳 4.2）')
gaps.forEach((g) => console.log('  · 缺：' + g))
console.log('  ⚠ 微信订阅消息只能在微信内下发，原生 iOS App 收不到；上架原生包必须改由')
console.log('    APNs / 本地通知承担到点提醒，这是一条独立的提醒链路改造。')

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败')
if (failed) process.exitCode = 1
