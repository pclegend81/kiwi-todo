/**
 * 订阅额度续期回归测试（纯 Node，mock 掉 wx 与 push 模块）。
 *
 * 覆盖「全站任意点击都补一次额度」引入的关键点：
 *   1. 同一次点击里「子节点显式 renew + 根节点冒泡 renew」只能发起一次授权；
 *   2. 节流窗口过后可再次补；
 *   3. 非用户手势调用（fail）不写拒绝标记、也不写任何每日计数；
 *   4. 明确拒绝后不再自动发起，clearDeclined 后可恢复；
 *   5. 不设每日次数上限：连续 40 次有效点击都能发起授权；
 *   6. 在途守卫：上一次 complete 还没回调时，再次调用返回 busy 而不是并发发起
 *      （并发发起会触发微信 requestSubscribeMessage:fail last call has not ended）。
 *   7. 多模板并行：一次调用最多 5 个模板，每个 accept 各算 1 条额度；
 *   8. 多模板里只要有一个 accept，就不把结果标成「用户拒绝」。
 */
const assert = require('assert')
const Module = require('module')

const store = {}
let authCalls = 0
let authState = 'accept'
let mixedStates = null
let currentIds = null
let lastTmplIds = []
let fakeNow = 1700000000000
const realDateNow = Date.now
// requestAuth 里的超时兜底用真实 setTimeout 会拖慢测试，桩掉即可
const realSetTimeout = global.setTimeout
const realClearTimeout = global.clearTimeout
global.setTimeout = function () { return 0 }
global.clearTimeout = function () {}

// 模拟微信慢回调：holdComplete = true 时 complete 挂起，等 releaseHeld() 手动放行
let holdComplete = false
let held = null

global.wx = {
  requestSubscribeMessage(opt) {
    authCalls++
    lastTmplIds = (opt.tmplIds || []).slice()
    const res = { errMsg: 'requestSubscribeMessage:ok' }
    if (authState === 'fail') {
      res.errMsg = 'requestSubscribeMessage:fail can only be invoked by user TAP gesture'
    } else {
      opt.tmplIds.forEach((id) => {
        res[id] = mixedStates && mixedStates[id] ? mixedStates[id] : authState
      })
    }
    if (holdComplete) {
      held = { opt: opt, res: res }
    } else if (opt.complete) {
      opt.complete(res)
    }
  },
  getStorageSync(k) { return store[k] },
  setStorageSync(k, v) { store[k] = v },
}

function releaseHeld() {
  if (!held) return
  const h = held
  held = null
  if (h.opt.complete) h.opt.complete(h.res)
}

// 顶替 push 模块：模板 ID 固定，上报授权结果不做真实云调用。
// currentIds 为 null 时走「只有 currentTemplateId」的旧环境回退路径。
const originalLoad = Module._load
Module._load = function (request, parent) {
  if (request === './push' && parent && /utils[\\/]subscribe\.js$/.test(parent.filename)) {
    return {
      currentTemplateId: () => 'TPL',
      currentTemplateIds: () => currentIds,
      reportSubscribe: () => Promise.resolve({}),
    }
  }
  return originalLoad.apply(this, arguments)
}
const subscribe = require('../utils/subscribe')
Module._load = originalLoad

Date.now = () => fakeNow

function tick(ms) { fakeNow += ms }

async function main() {
  // 1. 同一次点击里两次调用：只发起一次授权
  authCalls = 0
  authState = 'accept'
  const a = subscribe.renew()
  const b = subscribe.renew()
  assert.strictEqual(a, 'ok')
  assert.strictEqual(b, 'cooldown', '同一次点击的重复调用应被节流')
  assert.strictEqual(authCalls, 1, '只能发起一次 wx.requestSubscribeMessage')

  // 2. 节流窗口过后可再次补
  tick(1500)
  assert.strictEqual(subscribe.renew(), 'ok')
  assert.strictEqual(authCalls, 2)

  // 3. 非用户手势调用（fail）不写拒绝标记、也不写任何每日计数
  tick(1500)
  authState = 'fail'
  assert.strictEqual(subscribe.renew(), 'ok')
  assert.ok(!store.subscribeDeclined, '授权失败不应误标为「用户拒绝」')
  assert.ok(!store.subscribeRenewDay && !store.subscribeRenewCount,
    '不应再写入任何每日计数存储')

  // 4. 明确拒绝过：不再自动发起；用户主动授权后解除
  tick(1500)
  authState = 'reject'
  assert.strictEqual(subscribe.renew(), 'ok')
  assert.strictEqual(store.subscribeDeclined, '1')
  const before4 = authCalls
  tick(1500)
  assert.strictEqual(subscribe.renew(), 'declined')
  assert.strictEqual(authCalls, before4, '拒绝后不应再发起授权')
  subscribe.clearDeclined()
  authState = 'accept'
  tick(1500)
  assert.strictEqual(subscribe.renew(), 'ok', 'clearDeclined 后应恢复自动续期')
  assert.strictEqual(authCalls, before4 + 1)

  // 5. 不设每日次数上限：连续 40 次有效点击都能发起授权
  Object.keys(store).forEach((k) => delete store[k])
  authState = 'accept'
  const before5 = authCalls
  for (let i = 0; i < 40; i++) {
    tick(1500)
    assert.strictEqual(subscribe.renew(), 'ok', '第 ' + (i + 1) + ' 次不应被次数封顶')
  }
  assert.strictEqual(authCalls, before5 + 40, '40 次点击应发起 40 次授权')
  assert.ok(!store.subscribeRenewCount, '不应存在每日计数封顶')

  // 6. 在途守卫：上一次 complete 还没回调（微信慢 / 弹窗未关闭）时，
  //    节流窗口已过也不能再发起 —— 否则微信报 last call has not ended
  Object.keys(store).forEach((k) => delete store[k])
  holdComplete = true
  tick(1500)
  assert.strictEqual(subscribe.renew(), 'ok')
  const callsBefore = authCalls
  tick(1500) // 已过节流窗口，但调用仍在途
  assert.strictEqual(subscribe.renew(), 'busy', '在途时应返回 busy 而不是并发发起')
  assert.strictEqual(authCalls, callsBefore, '在途时不应再次调用 wx.requestSubscribeMessage')
  releaseHeld() // 模拟微信终于回调 complete
  tick(1500)
  holdComplete = false
  assert.strictEqual(subscribe.renew(), 'ok', '回调结束后应恢复可发起')
  assert.strictEqual(authCalls, callsBefore + 1)

  // 7. 多模板并行：一次调用最多 5 个模板 ID，每个 accept 各 +1 条额度
  Object.keys(store).forEach((k) => delete store[k])
  authState = 'accept'
  currentIds = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']
  let info7 = null
  tick(1500)
  assert.strictEqual(subscribe.renew({ onResult(res, info) { info7 = info } }), 'ok')
  assert.strictEqual(lastTmplIds.length, 5, '传给微信的模板 ID 不能超过 5 个')
  assert.strictEqual(info7.ids.length, 5)
  assert.strictEqual(info7.accepted, 5, '5 个模板各 accept 一次 = 补 5 条额度')

  // 8. 多模板里有一个 accept 就不能标记「用户拒绝」
  Object.keys(store).forEach((k) => delete store[k])
  mixedStates = { T1: 'reject', T2: 'accept' }
  currentIds = ['T1', 'T2']
  let info8 = null
  tick(1500)
  assert.strictEqual(subscribe.renew({ onResult(res, info) { info8 = info } }), 'ok')
  assert.strictEqual(info8.accepted, 1)
  assert.ok(!store.subscribeDeclined, '部分成功不应关闭全站自动续期')

  currentIds = null
  mixedStates = null
  Date.now = realDateNow
  global.setTimeout = realSetTimeout
  global.clearTimeout = realClearTimeout
  console.log('订阅额度续期测试 8 项通过')
}

main().catch((e) => {
  Date.now = realDateNow
  global.setTimeout = realSetTimeout
  global.clearTimeout = realClearTimeout
  console.error(e)
  process.exit(1)
})
