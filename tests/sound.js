/**
 * 到点铃声提醒 回归测试
 *   node tests/sound.js
 *
 * 「用系统默认铃声」= 系统通知音（Notification / 微信订阅消息，由 OS 播放）
 *   + 内置默认提示音（Web Audio 合成，零铃声文件）。
 * 重点锁住：
 *  1. Web / 小程序两个音频模块真的会合成双音、包络正确、开关能关掉、异常不崩；
 *  2. 低版本小程序没有 WebAudio 时回退系统振动；
 *  3. 铃声与通知权限解耦，且已接进两端触发点、缓存版本与共享字典。
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

const web = require('../webapp/sound.js')
const mp = require('../utils/sound.js')

function mockLS() {
  const m = {}
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v) },
  }
}

/** 最小可用的 AudioContext 替身，记录所有振荡器与包络调用 */
function mockAC(log, opts) {
  opts = opts || {}
  return function AudioContext() {
    if (opts.throwOnCreate) throw new Error('blocked by browser')
    this.state = 'suspended'
    this.currentTime = 1.25
    this.destination = { name: 'destination' }
    this.resume = () => { this.state = 'running'; log.resume++ }
    this.close = () => { log.close++ }
    this.createOscillator = () => {
      const o = {
        type: '', freq: null, freqAt: null, start: null, stop: null, connected: null,
        frequency: { setValueAtTime: (v, t) => { o.freq = v; o.freqAt = t } },
        start: (t) => { o.start = t; log.starts++ },
        stop: (t) => { o.stop = t; log.stops++ },
        connect: (n) => { o.connected = n },
      }
      log.osc.push(o)
      return o
    }
    this.createGain = () => {
      const g = {
        connected: null,
        gain: {
          set: [], lin: [], exp: [],
          setValueAtTime: (v, t) => { g.gain.set.push([v, t]) },
          linearRampToValueAtTime: (v, t) => { g.gain.lin.push([v, t]) },
          exponentialRampToValueAtTime: (v, t) => { g.gain.exp.push([v, t]) },
        },
        connect: (n) => { g.connected = n },
      }
      log.gain.push(g)
      return g
    }
    log.instance = this
  }
}

function newLog() { return { osc: [], gain: [], starts: 0, stops: 0, resume: 0, close: 0, instance: null } }

function withWebEnv(fn, opts) {
  const saved = { ls: global.localStorage, ac: global.AudioContext, wac: global.webkitAudioContext }
  global.localStorage = mockLS()
  if (opts && opts.noAudio) { delete global.AudioContext; delete global.webkitAudioContext }
  else global.AudioContext = mockAC(opts.log || newLog(), opts)
  web._reset()
  try { return fn() }
  finally {
    if (saved.ls === undefined) delete global.localStorage; else global.localStorage = saved.ls
    if (saved.ac === undefined) delete global.AudioContext; else global.AudioContext = saved.ac
    if (saved.wac === undefined) delete global.webkitAudioContext; else global.webkitAudioContext = saved.wac
    web._reset()
  }
}

function mockWx(log, opts) {
  opts = opts || {}
  const db = {}
  const wx = {
    getStorageSync: (k) => (Object.prototype.hasOwnProperty.call(db, k) ? db[k] : ''),
    setStorageSync: (k, v) => { db[k] = v },
  }
  if (!opts.noWebAudio) wx.createWebAudioContext = function () {
    if (opts.throwOnCreate) throw new Error('unsupported')
    const Ctor = mockAC(log)
    return new Ctor()
  }
  if (!opts.noVibrate) wx.vibrateShort = () => { log.vibrate++ }
  return wx
}

function withMpEnv(fn, opts) {
  opts = opts || {}
  const log = Object.assign(newLog(), { vibrate: 0 })
  const savedWx = global.wx
  const savedTimer = global.setTimeout
  global.wx = mockWx(log, opts)
  global.setTimeout = (cb) => { cb(); return 0 }   // 立即执行，验证 close 真被调用
  try { return fn(log) }
  finally {
    global.setTimeout = savedTimer
    if (savedWx === undefined) delete global.wx; else global.wx = savedWx
  }
}

console.log('到点铃声提醒测试')

// ---------- Web/PWA 模块行为 ----------

test('Web 模块默认开启，无 AudioContext 时静默返回 false 且不抛错', () => {
  withWebEnv(() => {
    assert.strictEqual(web.enabled(), true)
    assert.strictEqual(web.supported(), false)
    assert.strictEqual(web.play(), false)
    assert.strictEqual(web.unlock(), false)
  }, { noAudio: true })
})

test('Web 开关持久化到 localStorage，关闭后不再合成任何音', () => {
  const log = newLog()
  withWebEnv(() => {
    web.setEnabled(false)
    assert.strictEqual(web.enabled(), false)
    assert.strictEqual(web.play(), false)
    assert.strictEqual(log.osc.length, 0)
    web.setEnabled(true)
    assert.strictEqual(web.enabled(), true)
    assert.strictEqual(web.play(), true)
    assert.strictEqual(log.osc.length, 2)
  }, { log })
})

test('Web 播放合成标准双音（880 / 1174.66Hz）并带完整增益包络', () => {
  const log = newLog()
  withWebEnv(() => {
    assert.strictEqual(web.play(), true)
    assert.strictEqual(log.osc.length, 2)
    assert.strictEqual(log.gain.length, 2)
    assert.strictEqual(log.starts, 2)
    assert.strictEqual(log.stops, 2)
    assert.deepStrictEqual(log.osc.map((o) => o.freq), [880, 1174.66])
    log.osc.forEach((o) => {
      assert.strictEqual(o.type, 'sine')
      assert.ok(o.start > 1.25 && o.start < 1.5)
      assert.ok(o.stop > o.start)
    })
    log.gain.forEach((g) => {
      assert.strictEqual(g.gain.set.length, 1)   // 淡入起点
      assert.strictEqual(g.gain.lin.length, 1)   // 线性升到峰值
      assert.strictEqual(g.gain.exp.length, 1)   // 指数衰减到静音
      assert.strictEqual(g.connected, log.instance.destination)
    })
  }, { log })
})

test('Web unlock() 在 suspended 时 resume，且播放复用同一个 AudioContext', () => {
  const log = newLog()
  withWebEnv(() => {
    assert.strictEqual(web.unlock(), true)
    assert.strictEqual(log.resume, 1)
    const ctx = log.instance
    web.play()
    assert.strictEqual(log.instance, ctx, '重复创建了 AudioContext')
    assert.strictEqual(log.resume, 1, 'running 状态不该再次 resume')
  }, { log })
})

test('Web AudioContext 构造抛错时 play 返回 false 不冒泡异常', () => {
  withWebEnv(() => {
    assert.strictEqual(web.play(), false)
  }, { log: newLog(), throwOnCreate: true })
})

// ---------- 小程序模块行为 ----------

test('小程序模块默认开启，无 wx 环境时安全返回 false', () => {
  const saved = global.wx
  delete global.wx
  try {
    assert.strictEqual(mp.enabled(), true)
    assert.strictEqual(mp.play(), false)
  } finally {
    if (saved !== undefined) global.wx = saved
  }
})

test('小程序用 createWebAudioContext 合成双音，并在播放后 close 释放', () => {
  withMpEnv((log) => {
    assert.strictEqual(mp.play(), true)
    assert.strictEqual(log.osc.length, 2)
    assert.deepStrictEqual(log.osc.map((o) => o.freq), [880, 1174.66])
    assert.strictEqual(log.close, 1, 'WebAudioContext 未释放')
    assert.strictEqual(log.vibrate, 0)
  })
})

test('小程序关闭铃声后不发声，重新开启后恢复', () => {
  withMpEnv((log) => {
    mp.setEnabled(false)
    assert.strictEqual(mp.enabled(), false)
    assert.strictEqual(mp.play(), false)
    assert.strictEqual(log.osc.length, 0)
    mp.setEnabled(true)
    assert.strictEqual(mp.play(), true)
    assert.strictEqual(log.osc.length, 2)
  })
})

test('低版本基础库无 WebAudio 时回退系统振动，不会静默失败', () => {
  withMpEnv((log) => {
    assert.strictEqual(mp.play(), true)
    assert.strictEqual(log.osc.length, 0)
    assert.strictEqual(log.vibrate, 1)
  }, { noWebAudio: true })
})

test('createWebAudioContext 抛错时也回退振动；连振动都没有则返回 false', () => {
  withMpEnv((log) => {
    assert.strictEqual(mp.play(), true)
    assert.strictEqual(log.vibrate, 1)
  }, { throwOnCreate: true })
  withMpEnv(() => {
    assert.strictEqual(mp.play(), false)
  }, { noWebAudio: true, noVibrate: true })
})

// ---------- 接入点 / 资源 / 字典 ----------

test('Web checkDue 铃声与通知权限解耦：不再因未授权而整体跳过', () => {
  const js = read('webapp/app.js')
  assert.ok(js.includes('var canNotify = typeof Notification'), '未把通知权限降级为可选')
  assert.ok(js.includes('if (!this.bound) return'), 'checkDue 仍应保留 bound 前置')
  assert.ok(js.includes('if (SOUND) SOUND.play()'), '到点未播放铃声')
  assert.ok(js.includes('if (canNotify)'), '系统通知未做权限判断')
  assert.ok(js.includes('if (SOUND) SOUND.unlock()'), '首次手势未解锁 AudioContext')
  assert.ok(js.includes('toggleSound: function'), '缺少铃声开关')
  assert.ok(js.includes('testSound: function'), '缺少试听')
  assert.ok(js.includes('soundOn: SOUND ? SOUND.enabled() : true'))
})

test('index.html 桥接 sound.js，并提供开关与试听入口', () => {
  const html = read('webapp/index.html')
  assert.ok(html.includes('<script src="sound.js"></script>'))
  assert.ok(html.includes('window.KIWI_SOUND = module.exports'))
  assert.ok(html.includes('@click="toggleSound"'))
  assert.ok(html.includes('@change="toggleSound"'))
  assert.ok(html.includes('@click="testSound"'))
  assert.ok(html.includes("$t('snd_hint')"))
  // 桥接顺序：sound.js 必须晚于字典、早于 app.js，且 module 只 delete 一次
  assert.ok(html.indexOf('src="sound.js"') > html.indexOf('src="i18n-extra.js"'))
  assert.ok(html.indexOf('src="sound.js"') < html.indexOf('src="app.js"'))
  assert.strictEqual((html.match(/delete window\.module/g) || []).length, 1)
})

test('Service Worker 升到 v5 并缓存 sound.js（老设备不会吃到旧资源）', () => {
  const sw = read('webapp/sw.js')
  assert.ok(sw.includes("'kiwi-web-v5'"))
  assert.ok(sw.includes("'./sound.js'"))
  assert.ok(sw.indexOf("'./sound.js'") < sw.indexOf("'./manifest.json'"))
})

test('两端共享字典新增 9 个 snd_ 词条，11 语言齐全、md5 一致', () => {
  const extra = require('../webapp/i18n-extra.js')
  const keys = Object.keys(extra.ROWS).filter((k) => /^snd_/.test(k))
  assert.strictEqual(keys.length, 9)
  keys.forEach((k) => {
    const row = extra.ROWS[k]
    assert.strictEqual(row.length, 11, k + ' 语言数不对')
    assert.ok(row.every((v) => typeof v === 'string' && v.length), k + ' 有空词条')
  })
  assert.strictEqual(md5('webapp/i18n-extra.js'), md5('utils/i18n-extra.js'))
})

test('小程序首页到点补响铃，且按批次去重、跳过 skipped 记录', () => {
  const js = read('pages/index/index.js')
  assert.ok(js.includes("require('../../utils/sound')"))
  assert.ok(js.includes('r.status !== \'skipped\''), '节假日跳过的记录不该响铃')
  assert.ok(js.includes('_lastRingKey'), '缺少同一批只响一次的去重')
  assert.ok(js.includes('sound.play()'))
})

test('小程序「我的」页有开关与试听，且用 bindtap 不截断额度补量冒泡', () => {
  const js = read('pages/mine/mine.js')
  const wxml = read('pages/mine/mine.wxml')
  assert.ok(js.includes("require('../../utils/sound')"))
  assert.ok(js.includes('onSoundToggle()'))
  assert.ok(js.includes('onSoundTest()'))
  assert.ok(js.includes('soundOn: sound.enabled()'))
  assert.ok(wxml.includes('bindtap="onSoundToggle"'))
  assert.ok(wxml.includes('bindtap="onSoundTest"'))
  assert.ok(wxml.includes('T.snd_title') && wxml.includes('T.snd_test'))
  assert.ok(!/catchtap="onSound/.test(wxml), 'catchtap 会截断根节点 onAnyTap 补额度')
})

test('提醒链路零改动：reminder-core 5 份副本 md5 一致', () => {
  const files = [
    'utils/reminder-core.js',
    'webapp/reminder-core.js',
    'cloudfunctions/pusher/reminder-core.js',
    'cloudfunctions/pushapi/reminder-core.js',
    'cloudfunctions/webapi/reminder-core.js',
  ]
  const hashes = files.map(md5)
  assert.ok(hashes.every((h) => h === hashes[0]), 'reminder-core 副本不一致')
})

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败')
if (failed) process.exit(1)
