/**
 * 微信云开发入口。整个小程序的数据与推送都跑在微信云开发上，
 * 不再依赖任何外部网关（wx.cloud.callFunction 也不经过域名校验）。
 */
const config = require('./config')

let inited = false

function ensureInit() {
  if (inited) return
  if (!wx.cloud) {
    throw new Error('当前微信版本不支持云开发，请升级微信')
  }
  const opt = { traceUser: true }
  if (config.CLOUD_ENV) opt.env = config.CLOUD_ENV
  wx.cloud.init(opt)
  inited = true
}

ensureInit()

const cloud = wx.cloud
const db = cloud.database()

/**
 * 调用云函数并统一错误结构。
 * @returns {Promise<object>} 云函数返回的 result（约定含 ok 字段）
 */
function callFunction(name, data) {
  ensureInit()
  return new Promise((resolve, reject) => {
    cloud.callFunction({
      name: name,
      data: data || {},
      success(res) {
        const r = res && res.result
        if (r && r.ok) {
          resolve(r)
          return
        }
        reject(new Error((r && r.message) || '云函数返回异常'))
      },
      fail(err) {
        reject(new Error((err && err.errMsg) || '云函数调用失败，请确认已在开发者工具部署 ' + name))
      },
    })
  })
}

module.exports = {
  cloud: cloud,
  db: db,
  callFunction: callFunction,
}
