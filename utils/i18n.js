/**
 * KIWI待办 小程序端 · 多语言（11 种苹果实时翻译语言）
 *
 * 设计要点：
 *  1. 字典文件 i18n-data.js / i18n-extra.js / holidays-region.js 与 webapp/ 下同名文件
 *     保持 md5 一致（tests/i18n.js 会校验），网页端与小程序端翻译口径不会漂移；
 *  2. 只做展示层翻译：reminder-core.js 五份副本、pusher / pushapi 提醒链路零改动；
 *  3. 每种语言绑定一个 region，切换语言时由 store / 首页按 region 重建 holidayMap，
 *     即「选语言 = 切当地法定节假日」；
 *  4. 所选语言存本地 storage（kiwi_lang），不跨设备同步（设备显示语言本就该各管各的）；
 *  5. 缺词回退 zh-CN，再回退 key 本身，新增文案不会白屏；
 *  6. 无 wx 环境（Node 单测）也能 require，默认简体中文。
 */
const { LANGS, LOCALES, I18N } = require('./i18n-data.js')
const { EXTRA } = require('./i18n-extra.js')

const STORAGE_KEY = 'kiwi_lang'

/** 合并基础字典与补充字典，得到每种语言的完整字典 */
const FULL = {}
LANGS.forEach((l) => {
  const d = Object.assign({}, I18N[l.code] || {})
  Object.keys(EXTRA).forEach((k) => {
    d[k] = (EXTRA[k] && EXTRA[k][l.code]) || (EXTRA[k] && EXTRA[k]['zh-CN']) || k
  })
  FULL[l.code] = d
})

function storageGet(key) {
  try {
    if (typeof wx !== 'undefined' && wx.getStorageSync) return wx.getStorageSync(key) || ''
  } catch (e) { /* Node 单测或隐私场景忽略 */ }
  return ''
}

function storageSet(key, val) {
  try {
    if (typeof wx !== 'undefined' && wx.setStorageSync) wx.setStorageSync(key, val)
  } catch (e) { /* 写不进不影响本次会话 */ }
}

function valid(code) {
  return LANGS.some((l) => l.code === code)
}

/** 首次启动按微信/系统语言猜一个，猜不中回落简体中文 */
function guessLang() {
  let nav = ''
  try {
    if (typeof wx !== 'undefined') {
      const sys = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {}
      nav = String(sys.language || wx.language || '').toLowerCase()
    } else if (typeof navigator !== 'undefined') {
      nav = String(navigator.language || '').toLowerCase()
    }
  } catch (e) { /* 忽略 */ }
  nav = nav.replace(/_/g, '-')
  const map = {
    'zh-tw': 'zh-TW', 'zh-hk': 'zh-TW', 'zh-mo': 'zh-TW', 'zh-cn': 'zh-CN',
    'en-gb': 'en-GB', 'en-us': 'en-US', 'en-au': 'en-GB',
    'ja': 'ja', 'ja-jp': 'ja', 'ko': 'ko', 'ko-kr': 'ko',
    'de': 'de', 'fr': 'fr', 'es': 'es', 'it': 'it',
    'pt-br': 'pt-BR', 'pt': 'pt-BR',
  }
  if (map[nav]) return map[nav]
  if (map[nav.slice(0, 2)]) return map[nav.slice(0, 2)]
  return 'zh-CN'
}

function current() {
  const saved = String(storageGet(STORAGE_KEY) || '')
  return valid(saved) ? saved : guessLang()
}

function set(code) {
  if (!valid(code)) return false
  storageSet(STORAGE_KEY, code)
  return true
}

/** 语言 -> 地区：cn/us/gb/jp/kr/de/fr/es/it/br */
function region(code) {
  const c = code || current()
  for (let i = 0; i < LANGS.length; i++) if (LANGS[i].code === c) return LANGS[i].region
  return 'cn'
}

/** 取词，支持 {n} / {name} / {title} / {years} 等占位符 */
function t(key, vars, code) {
  const c = code || current()
  const d = FULL[c] || FULL['zh-CN'] || {}
  let s = d[key]
  if (s === undefined) s = (FULL['zh-CN'] || {})[key]
  if (s === undefined) s = key
  const v = vars || {}
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] === undefined ? m : String(v[k])))
}

/** 当前语言的完整字典（供页面 setData({ T }) 后在 WXML 里用 {{T.xxx}}） */
function dict(code) {
  return FULL[code || current()] || FULL['zh-CN'] || {}
}

/** 当前地区的本地化名称，如「日本」「Japan」「日本」 */
function regionName(code) {
  return t('region_name', {}, code)
}

/** 时间格式化用的 BCP47 locale */
function locale(code) {
  return LOCALES[code || current()] || 'zh-CN'
}

/** 页面统一注入：onLoad / onShow 里调一次，WXML 即可用 {{T.xxx}} */
function applyPage(page) {
  const code = current()
  page.setData({
    lang: code,
    T: dict(code),
    region: region(code),
    regionName: regionName(code),
  })
  return code
}

module.exports = {
  LANGS: LANGS,
  LOCALES: LOCALES,
  FULL: FULL,
  STORAGE_KEY: STORAGE_KEY,
  current: current,
  set: set,
  valid: valid,
  region: region,
  regionName: regionName,
  locale: locale,
  t: t,
  dict: dict,
  applyPage: applyPage,
}
