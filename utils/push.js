/**
 * 推送相关操作 —— 走微信云开发（云函数 pushapi）。
 * 无需填写服务器地址：wx.cloud.callFunction 不经过 request 域名校验。
 */
const { callFunction } = require('./cloud')
const config = require('./config')

/**
 * 同步取模板 ID。
 * 关键：申请订阅授权必须在用户点击的同步调用链里发起，所以这里不能走 await。
 * 取值顺序：内存 → 本地缓存 → 配置里的兜底值。
 */
function currentTemplateId() {
  const app = typeof getApp === 'function' ? getApp() : null
  const fromMemory = app && app.globalData ? String(app.globalData.templateId || '').trim() : ''
  if (fromMemory) return fromMemory
  try {
    const fromStorage = String(wx.getStorageSync('templateId') || '').trim()
    if (fromStorage) {
      if (app && app.globalData) app.globalData.templateId = fromStorage
      return fromStorage
    }
  } catch (e) { /* 忽略 */ }
  return String(config.FALLBACK_TEMPLATE_ID || '').trim()
}

/** wx.requestSubscribeMessage 单次最多 5 个模板 ID（官方参数上限） */
const MAX_TEMPLATE_IDS = 5

/** 去重去空，最多留 5 个 */
function cleanTemplateIds(rows) {
  const seen = {}
  const out = []
  const list = Array.isArray(rows) ? rows : []
  for (let i = 0; i < list.length && out.length < MAX_TEMPLATE_IDS; i++) {
    const id = String(list[i] || '').trim()
    if (id && !seen[id]) {
      seen[id] = 1
      out.push(id)
    }
  }
  return out
}

/**
 * 同步取「本次要订阅的全部模板 ID」。
 * 同样不能走 await：授权必须在点击的同步调用链里发起。
 * 取值顺序：内存 → 本地缓存 → 内置兜底数组 → 单个兜底 ID。
 * 云端 status 接口会回传 templateIds，平时以它为准。
 */
function currentTemplateIds() {
  const app = typeof getApp === 'function' ? getApp() : null
  if (app && app.globalData && Array.isArray(app.globalData.templateIds)) {
    const ids = cleanTemplateIds(app.globalData.templateIds)
    if (ids.length) return ids
  }
  try {
    const cached = wx.getStorageSync('templateIds')
    if (Array.isArray(cached)) {
      const ids = cleanTemplateIds(cached)
      if (ids.length) {
        if (app && app.globalData) app.globalData.templateIds = ids
        return ids
      }
    }
  } catch (e) { /* 忽略 */ }
  const fallback = cleanTemplateIds(config.FALLBACK_TEMPLATE_IDS)
  if (fallback.length) return fallback
  const one = currentTemplateId()
  return one ? [one] : []
}

/** 把授权失败的信息翻译成人能看懂的原因 */
function explainSubscribeError(errMsg) {
  const msg = String(errMsg || '')
  if (!msg) return '授权失败，请重试'
  if (/invalid template id|模板\s*id|templateId/i.test(msg)) {
    return '模板 ID 无效或不属于当前小程序：请到微信公众平台「订阅消息 → 我的模板」确认该模板已添加，且 ID 与 cloudfunctions/pushapi/index.js 里的 TEMPLATE_ID 一致'
  }
  if (/user tap gesture|gesture|用户.*手势|必须由用户/i.test(msg)) {
    return '必须由点击直接触发：请直接点按钮，不要先做异步请求'
  }
  if (/privacy|隐私/i.test(msg)) {
    return '未通过隐私授权：请在公众平台「设置 → 隐私保护指引」里勾选「订阅消息」并重新发布'
  }
  if (/ban|封禁/i.test(msg)) return '该模板已被微信封禁，请更换模板'
  if (/filter|屏蔽/i.test(msg)) return '该模板被系统屏蔽，通常与小程序类目不匹配'
  if (/-80001|基础库|version/i.test(msg)) return '微信版本过低，请升级微信后重试'
  return '授权失败：' + msg
}

/** 授权结果状态说明（res[templateId] 的各种取值） */
function explainSubscribeState(state) {
  switch (String(state || '')) {
    case 'accept':
      return null
    case 'acceptWithSubscribe':
      return null
    case 'reject':
      return '你拒绝了这次授权。若之前勾选过「总是保持以上选择」，微信将不再弹窗，需到「小程序设置 → 通知管理」里重新打开订阅消息'
    case 'ban':
      return '该模板因违规被封禁，请到公众平台更换模板'
    case 'filter':
      return '该模板被系统屏蔽（常见于模板与小程序类目不匹配），请在公众平台重新选用模板'
    default:
      return '未获得授权（' + String(state || '未知状态') + '）'
  }
}

/** 登记本机（openid）为推送设备 */
function bindDevice() {
  return callFunction('pushapi', { action: 'bind' })
}

/** 查询绑定状态、剩余订阅额度，以及云端内置的模板 ID */
function pushStatus() {
  return callFunction('pushapi', { action: 'status' })
}

/** 订阅授权成功后给本机加额度 */
function reportSubscribe(accepted) {
  return callFunction('pushapi', { action: 'subscribe', accepted: !!accepted })
}

/** 给本机发一条测试提醒 */
function sendTest() {
  return callFunction('pushapi', { action: 'test' })
}

module.exports = {
  bindDevice: bindDevice,
  pushStatus: pushStatus,
  reportSubscribe: reportSubscribe,
  sendTest: sendTest,
  currentTemplateId: currentTemplateId,
  currentTemplateIds: currentTemplateIds,
  explainSubscribeError: explainSubscribeError,
  explainSubscribeState: explainSubscribeState,
}
