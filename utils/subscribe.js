/**
 * 订阅额度静默续期。
 *
 * 微信「一次性订阅消息」的硬规则：用户每同意一次，只换来 1 次下发权限；
 * 发完就清零，再发会被微信拒绝（43101），必须重新授权。所以额度要持续补，
 * 否则用户不打开小程序点授权，到期提醒就发不出去。
 *
 * 补额度只能靠 wx.requestSubscribeMessage，而它必须发生在用户点击的
 * 同步调用链里（先 await 会被判定为非用户手势而直接失败）。因此本模块的
 * renew() 必须放在 tap 处理函数的第一行、任何 await 之前同步调用。
 *
 * 前提：用户在授权弹窗里勾选过「总是保持以上选择，不再询问」之后，
 * 后续调用不再弹窗，直接静默累加额度 —— 这是整套机制能无感运转的关键。
 * 注意：勾选只是免弹窗，并不解除「1 次授权 = 1 条」；43101 就是反证。
 *
 * 多模板并行：一次调用最多传 5 个模板 ID，每个模板各补 1 条额度。
 * 官方还要求「一次授权调用里每个 tmplId 对应的模板标题不能相同，相同只保留一个」，
 * 所以不能靠复制同款模板刷额度；追加模板见 utils/config.js 的 FALLBACK_TEMPLATE_IDS
 * 与两份云函数的 TEMPLATE_IDS（三处必须同步）。
 *
 * 微信官方对「单个用户每天能授权几次 / 能收到几条」没有公开的固定数字限制，
 * 能发几条 = 攒了多少额度。因此本模块**不对每日授权次数封顶**，
 * 只保留节流与在途守卫（防并发，不是次数上限）。
 */
const push = require('./push')

const DECLINE_KEY = 'subscribeDeclined'
/**
 * 同一点击里子节点 handler 与根节点冒泡会各调一次；也挡住极快连点被微信限频。
 * 这是防并发保护，不是次数上限 —— 每日授权次数不封顶。
 */
const MIN_INTERVAL_MS = 1000
/** wx.requestSubscribeMessage 单次最多 5 个模板 ID（官方参数上限，不是次数上限） */
const MAX_TMPL_IDS = 5
let lastRenewAt = 0
/**
 * 在途守卫：wx.requestSubscribeMessage 从发起到 complete 可能要几秒
 * （授权弹窗展示期间、真机回调慢时更久）。这期间再发起一次，
 * 微信会直接报 requestSubscribeMessage:fail last call has not ended，
 * 且新的调用会失败 —— 不但补不到额度，还把用户主动授权的入口堵死。
 */
let pending = false
/** 兜底：complete 万一不被回调（理论上不会），别把后续授权永久堵死 */
const PENDING_TIMEOUT_MS = 8000

function readStorage(key) {
  try {
    return String(wx.getStorageSync(key) || '')
  } catch (e) {
    return ''
  }
}

function writeStorage(key, value) {
  try {
    wx.setStorageSync(key, value)
  } catch (e) { /* 存储不可用时忽略，不影响主流程 */ }
}

/** 规范化模板 ID：数组优先、单值兼容，去重去空，最多 5 个 */
function normalizeIds(opt) {
  const o = opt || {}
  const raw = Array.isArray(o.tmplIds) && o.tmplIds.length ? o.tmplIds : [o.templateId]
  const seen = {}
  const out = []
  for (let i = 0; i < raw.length && out.length < MAX_TMPL_IDS; i++) {
    const id = String(raw[i] || '').trim()
    if (id && !seen[id]) {
      seen[id] = 1
      out.push(id)
    }
  }
  return out
}

/**
 * 取本次要订阅的模板 ID 列表。
 * push.currentTemplateIds() 是新版多模板入口；旧环境 / 测试桩可能只提供
 * currentTemplateId()，这里做回退，保证单模板场景完全不变。
 */
function templateIds() {
  let ids = []
  if (typeof push.currentTemplateIds === 'function') {
    ids = normalizeIds({ tmplIds: push.currentTemplateIds() })
  }
  if (!ids.length && typeof push.currentTemplateId === 'function') {
    ids = normalizeIds({ tmplIds: [push.currentTemplateId()] })
  }
  return ids
}

/**
 * 全项目唯一的授权调用入口（带在途守卫）。
 * 静默续期（renew）和用户主动授权（「我的」页按钮）都必须走这里，
 * 否则会绕开 pending 守卫，出现两路并发调用 → last call has not ended。
 *
 * opt: { templateId | tmplIds, onResult(res, info) }
 *   info = { accepted, ids, states, failed }
 *   accepted 是本次真正拿到授权的模板个数（1 个模板 = 1 条下发额度）。
 * 返回 'ok'（已发起）或 'busy'（上一次还没结束，本次未发起）。
 */
function requestAuth(opt) {
  const o = opt || {}
  if (!wx.requestSubscribeMessage) return 'unsupported'
  if (pending) return 'busy'
  const ids = normalizeIds(o)
  if (!ids.length) return 'unsupported'
  pending = true
  let timer = null
  if (typeof setTimeout === 'function') {
    timer = setTimeout(function () { pending = false }, PENDING_TIMEOUT_MS)
  }
  wx.requestSubscribeMessage({
    tmplIds: ids,
    complete(res) {
      if (timer) clearTimeout(timer)
      pending = false
      const errMsg = String((res && res.errMsg) || '')
      const failed = errMsg.indexOf('fail') >= 0
      const states = []
      let accepted = 0
      let declined = false
      ids.forEach((id) => {
        const state = res ? res[id] : ''
        states.push({ id: id, state: state })
        if (state === 'accept' || state === 'acceptWithSubscribe') accepted++
        else if (state === 'reject' || state === 'ban' || state === 'filter') declined = true
      })
      if (accepted > 0) {
        // 云端只做记录，不做任何次数限制：额度由微信侧控制，本端不计数封顶
        push.reportSubscribe(true).catch(function () {})
      }
      // 接口级失败（例如非用户手势）不算用户拒绝，别误关自动续期
      if (declined && accepted === 0 && !failed) writeStorage(DECLINE_KEY, '1')
      if (o.onResult) o.onResult(res, { accepted: accepted, ids: ids, states: states, failed: failed })
    },
  })
  return 'ok'
}

/**
 * 在点击链内静默续一次订阅额度。
 * 必须在 tap 处理函数第一行同步调用；不弹 toast、不阻塞后续逻辑。
 * opt.onResult(res, info) 可选，供「一次攒够额度」这类需要真实计数的场景使用
 * —— 不能用返回值当成功：'ok' 只表示已发起，微信回调才算数。
 */
function renew(opt) {
  if (!wx.requestSubscribeMessage) return 'unsupported'
  // 上一次授权还没回调结束：再发必然报 last call has not ended，直接放弃本次
  if (pending) return 'busy'
  // 节流：一次点击里「子节点显式调用 + 根节点冒泡」只会补一次；
  // 也挡住用户极快连点，避免微信侧限频。
  const ts = Date.now()
  if (ts - lastRenewAt < MIN_INTERVAL_MS) return 'cooldown'
  // 用户明确拒绝过：不再自动弹窗打扰，由他自己回「我的」页授权
  if (readStorage(DECLINE_KEY) === '1') return 'declined'

  const ids = templateIds()
  if (!ids.length) return 'unsupported'

  // 不设每日次数上限：每次有效点击都能补，攒多少额度由微信侧结算
  lastRenewAt = ts
  return requestAuth({ tmplIds: ids, onResult: opt && opt.onResult })
}

/** 点击提醒条目：补一次额度，并按真实 accept 数给一句看得懂的反馈 */
function renewWithToast() {
  const state = renew({
    onResult(res, info) {
      if (info.accepted > 0) {
        wx.showToast({ title: '已补充 ' + info.accepted + ' 次提醒额度', icon: 'none', duration: 1500 })
      }
    },
  })
  if (state === 'ok') return state
  const text = state === 'busy' ? '上一次授权还没结束，稍等一两秒再点'
    : state === 'declined' ? '请先到「我的」开启授权'
      : state === 'unsupported' ? '当前微信版本不支持'
        : '刚刚已补充，稍后再点'
  wx.showToast({ title: text, icon: 'none', duration: 1500 })
  return state
}

/** 用户主动点了授权按钮：解除「拒绝后不再自动弹窗」的限制 */
function clearDeclined() {
  writeStorage(DECLINE_KEY, '')
}

/**
 * 页面根节点统一挂的 tap 处理函数：bindtap 会冒泡，页面内任意点击都会走到这里。
 * 冒泡仍处在同一次用户点击的同步调用链里，wx.requestSubscribeMessage 可正常发起。
 * 与子节点里的显式 renew() 由节流去重，不会重复补。
 */
function onAnyTap() {
  renew()
}

module.exports = {
  renew: renew,
  onAnyTap: onAnyTap,
  renewWithToast: renewWithToast,
  requestAuth: requestAuth,
  clearDeclined: clearDeclined,
  templateIds: templateIds,
}
