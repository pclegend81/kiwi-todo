/**
 * 跳转节流：连点「新建待办」会压入多个编辑页实例，每个实例各有自己的 client_token，
 * 各保存一次就会生成多条同名待办。所以入口层也要拦一道（纯 JS，不依赖 wx）。
 * 与编辑页的 saving 锁、store 的 client_token 幂等一起构成三层防重。
 */
const NAV_GAP_MS = 800

const lastAt = Object.create(null)

/**
 * @param {string} url 目标页面路径
 * @param {number} [now] 可传入时间戳，方便单元测试
 * @returns {boolean} true 表示这次跳转允许发生
 */
function guard(url, now) {
  const key = String(url || '')
  const at = typeof now === 'number' ? now : Date.now()
  if (lastAt[key] && at - lastAt[key] < NAV_GAP_MS) return false
  lastAt[key] = at
  return true
}

/** 仅供测试重置节流状态 */
function reset() {
  Object.keys(lastAt).forEach((k) => delete lastAt[k])
}

module.exports = {
  NAV_GAP_MS: NAV_GAP_MS,
  guard: guard,
  reset: reset,
}
