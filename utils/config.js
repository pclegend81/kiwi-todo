/**
 * 公共配置。
 */
/** 微信云开发环境 ID：在「云开发控制台 → 设置 → 环境设置」里查看。 */
/**
 * 微信云开发环境 ID：在「云开发控制台 → 设置 → 环境设置」里复制。
 * 留空 = 使用默认环境（只建了一个环境时留空即可）。
 */
var CLOUD_ENV = ''

// 订阅消息模板 ID 已内置在云函数 cloudfunctions/pushapi/index.js 里，
// 由 pushapi 的 status 接口下发给小程序，页面上不再提供配置入口。
//
// 这里保留一份相同的 ID 作为「离线兜底」：云函数还没部署 / 调用失败时，
// 申请订阅授权依然能用（注意：wx.requestSubscribeMessage 必须在用户点击的
// 同步调用链里触发，不能先 await 云端再调用，否则会被判定为非用户手势而失败）。
var FALLBACK_TEMPLATE_ID = '80ZMLz3QxJ_KlrrK6uU_GqHNOlmL5xvr6247IO5PmEA'

/**
 * 多模板并行：一次点击同时给这些模板各补 1 条额度，把「1 次点击 = 1 条」
 * 放大到最多 5 条。微信的两个硬约束：
 *   ① 一次 wx.requestSubscribeMessage 最多 5 个 tmplIds；
 *   ② 模板标题不能相同，相同只保留一个 —— 不能复制同款模板来刷额度。
 * 默认只放原来的 1 个，行为与旧版完全一致。追加模板时，
 * cloudfunctions/pusher/index.js 和 cloudfunctions/pushapi/index.js 的
 * TEMPLATE_IDS 必须同步加同一批 ID，并在 pusher 的 TEMPLATE_FIELDS_BY_ID 里
 * 给关键词编号不同的模板配一份字段映射（否则下发会报 47003）。
 */
var FALLBACK_TEMPLATE_IDS = [
  FALLBACK_TEMPLATE_ID,
  // '第 2 个模板 ID',
  // '第 3 个模板 ID',
]

module.exports = {
  CLOUD_ENV: CLOUD_ENV,
  FALLBACK_TEMPLATE_ID: FALLBACK_TEMPLATE_ID,
  FALLBACK_TEMPLATE_IDS: FALLBACK_TEMPLATE_IDS,
}
