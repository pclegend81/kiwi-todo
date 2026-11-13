/**
 * 保存防重与超时保护（纯 JS，不依赖 wx，可在 Node 下直接跑单元测试）。
 *
 * 背景：新建待办时点「保存」要等云数据库返回，网络慢/云函数冷启动期间按钮还能点，
 * 用户连点几下就会插入几条一模一样的待办（「送舒明」一次出现 3 条就是这么来的）。
 * 这里提供两样东西：
 *   - makeSaveToken()：每个新建页实例一个固定 token，同一页的所有保存/重试都带上它；
 *   - withTimeout()：给写库加超时，避免 loading 永久挂着；超时重试靠 token 幂等兜底。
 */

const SAVE_TIMEOUT_MS = 15000

/** 新建页实例级别的幂等键；重试复用同一个，重新进页面才会换新的 */
function makeSaveToken() {
  return 'sv_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10)
}

/**
 * 给 Promise 加超时。超时抛出的错误 code = 'SAVE_TIMEOUT'。
 * 底层请求超时后仍可能在后台写成功，所以重试必须配合 client_token 幂等，
 * 不能简单地「再插一条」。
 */
function withTimeout(promise, ms) {
  const wait = Number(ms) > 0 ? Number(ms) : SAVE_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      const err = new Error('保存超时，请检查网络后直接再点一次保存')
      err.code = 'SAVE_TIMEOUT'
      reject(err)
    }, wait)
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

module.exports = {
  SAVE_TIMEOUT_MS: SAVE_TIMEOUT_MS,
  makeSaveToken: makeSaveToken,
  withTimeout: withTimeout,
}
