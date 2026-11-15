/**
 * KIWI待办 小程序 · 到点提示音（「系统默认铃声」）
 *
 * 平台事实：小程序沙箱同样读不到系统铃声文件，且退到后台后不能播放自定义音频。
 * 「用系统默认铃声」落地为：
 *   ① 微信订阅消息的系统通知音（由 OS 按用户铃声设置播放，后台提醒唯一可靠通道）；
 *   ② 前台打开小程序遇到刚到点的提醒时，用 wx.createWebAudioContext() 合成一段
 *      内置默认提示音（零音频资源、不占包体积）；低版本基础库不支持时回退系统振动。
 * 不提供自定义铃声，保持「用系统 / 内置默认音」。
 */

const STORAGE_KEY = 'kiwi_sound'

function enabled() {
  if (typeof wx === 'undefined' || typeof wx.getStorageSync !== 'function') return true
  try { return wx.getStorageSync(STORAGE_KEY) !== false } catch (e) { return true }
}

function setEnabled(on) {
  if (typeof wx === 'undefined' || typeof wx.setStorageSync !== 'function') return
  try { wx.setStorageSync(STORAGE_KEY, !!on) } catch (e) {}
}

function tone(ctx, freq, at, dur) {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(freq, at)
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.linearRampToValueAtTime(0.18, at + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(at)
  osc.stop(at + dur + 0.02)
}

function vibrate() {
  if (typeof wx === 'undefined') return false
  try {
    if (typeof wx.vibrateShort === 'function') { wx.vibrateShort({ type: 'medium' }); return true }
    if (typeof wx.vibrateLong === 'function') { wx.vibrateLong(); return true }
  } catch (e) {}
  return false
}

/** 播放内置默认提示音；WebAudio 不可用 / 抛错时退回系统振动。返回是否成功 */
function play() {
  if (!enabled()) return false
  if (typeof wx === 'undefined') return false
  if (typeof wx.createWebAudioContext === 'function') {
    let ctx = null
    try {
      ctx = wx.createWebAudioContext()
      const now = ctx.currentTime || 0
      tone(ctx, 880, now + 0.01, 0.16)
      tone(ctx, 1174.66, now + 0.21, 0.20)
      // 每次播放新建的 WebAudioContext 要及时释放，避免反复进首页累积
      setTimeout(() => {
        try { if (ctx && typeof ctx.close === 'function') ctx.close() } catch (e) {}
      }, 700)
      return true
    } catch (e) { /* 落到振动兜底 */ }
  }
  return vibrate()
}

module.exports = { STORAGE_KEY, enabled, setEnabled, play }
