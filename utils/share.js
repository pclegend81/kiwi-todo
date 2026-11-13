/**
 * 页面分享方法。
 *
 * 微信硬规则：页面**必须**定义 onShareAppMessage，右上角「···」里的
 * 「转发给朋友」才可点；必须定义 onShareTimeline，才会出现「分享到朋友圈」。
 * 缺了就是灰的或者不显示。
 *
 * 坑（真机实测）：把这两个方法放进 Behavior 再用 behaviors 挂到 Page，
 * 微信并不总能识别 —— 一旦没识别，右上角「转发给朋友」就是灰的。
 * 所以这里导出的是**函数本体**，每个页面要直接写进 Page({}) 配置对象，
 * 不经过 Behavior。框架没有「全局分享」，每个页面都得挂一次。
 */
const SHARE_TITLE = 'KIWI待办 · 重复提醒 + 节假日智能顺延'
const SHARE_PATH = '/pages/index/index'

/** 转发给朋友 / 群聊。统一指向首页——编辑页带 id 转发给别人会查不到数据 */
function onShareAppMessage() {
  return {
    title: SHARE_TITLE,
    path: SHARE_PATH,
  }
}

/**
 * 分享到朋友圈（单页模式）。
 * 单页模式下没有登录态、拿不到 openid，且不支持自定义 path，
 * 所以只给首页挂，其余页面依赖登录，挂上去别人打开就是白屏。
 */
function onShareTimeline() {
  return { title: SHARE_TITLE }
}

module.exports = {
  SHARE_TITLE: SHARE_TITLE,
  SHARE_PATH: SHARE_PATH,
  onShareAppMessage: onShareAppMessage,
  onShareTimeline: onShareTimeline,
}
