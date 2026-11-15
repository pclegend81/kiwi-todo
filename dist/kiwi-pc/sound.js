/**
 * KIWI待办 Web/PWA · 到点提示音（「系统默认铃声」）
 *
 * 平台事实：浏览器沙箱读不到操作系统的铃声文件，不能像原生 App 那样直接播放系统铃声。
 * 因此「用系统默认铃声」落地为两层，全程不需要用户提供任何自定义铃声文件：
 *   ① 系统通知音：app.js checkDue() 弹出的 Notification，由操作系统按用户当前铃声设置播放；
 *   ② 内置默认提示音：本文件用 Web Audio 合成的一段通用双音，页面在前台时保证可听
 *      （很多浏览器 / 系统的通知本身是静音的），零资源、离线可用、不依赖网络。
 *
 * AudioContext 只允许在用户手势链里创建 / 恢复，所以首次点击时要调用 unlock()。
 * 文件是 CommonJS 风格，与项目其余共享模块一样由 index.html 的桥接脚本挂到 window。
 */
;(function () {
  'use strict'

  var LS_KEY = 'kiwi_web_sound'
  var ctx = null

  function glob() {
    if (typeof window !== 'undefined') return window
    if (typeof global !== 'undefined') return global
    return {}
  }

  function storage() {
    try {
      var g = glob()
      if (g.localStorage) return g.localStorage
      return (typeof localStorage !== 'undefined') ? localStorage : null
    } catch (e) { return null }
  }

  function AC() {
    var g = glob()
    return g.AudioContext || g.webkitAudioContext || null
  }

  /** 默认开启；localStorage 不可用或读失败时按开启处理 */
  function enabled() {
    var s = storage()
    if (!s) return true
    try { return s.getItem(LS_KEY) !== '0' } catch (e) { return true }
  }

  function setEnabled(on) {
    var s = storage()
    if (!s) return
    try { s.setItem(LS_KEY, on ? '1' : '0') } catch (e) {}
  }

  function supported() { return !!AC() }

  /** 首次用户交互时调用：浏览器只允许在手势链里创建 / 恢复 AudioContext */
  function unlock() {
    if (!supported()) return false
    try {
      if (!ctx) ctx = new (AC())()
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume()
      return true
    } catch (e) { return false }
  }

  /** 单个正弦音，带淡入淡出包络，避免起停爆音 */
  function tone(c, freq, at, dur) {
    var osc = c.createOscillator()
    var gain = c.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq, at)
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.linearRampToValueAtTime(0.18, at + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    osc.connect(gain)
    gain.connect(c.destination)
    osc.start(at)
    osc.stop(at + dur + 0.02)
  }

  /** 播放内置默认提示音；返回是否成功发声（不支持 / 已关闭时静默返回 false） */
  function play() {
    if (!enabled()) return false
    if (!supported()) return false
    try {
      if (!ctx) ctx = new (AC())()
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume()
      var now = ctx.currentTime || 0
      tone(ctx, 880, now + 0.01, 0.16)
      tone(ctx, 1174.66, now + 0.21, 0.20)
      return true
    } catch (e) { return false }
  }

  function _reset() { ctx = null }

  var api = {
    LS_KEY: LS_KEY,
    enabled: enabled,
    setEnabled: setEnabled,
    supported: supported,
    unlock: unlock,
    play: play,
    _reset: _reset,
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else glob().KIWI_SOUND = api
})()
