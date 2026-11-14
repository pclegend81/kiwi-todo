const { cloud } = require('./utils/cloud')
const i18n = require('./utils/i18n')

App({
  globalData: {
    // 节假日映射 {'2027-01-01': 'holiday'}，启动时从云端拉取并在各页面共享
    holidayMap: {},
    holidaysLoaded: false,
    // 当前界面语言 + 它绑定的地区；切语言会把 holidaysLoaded 置 false 强制重建 map
    lang: 'zh-CN',
    region: 'cn',
    signedIn: false,
    // 待办被增删改后置 true，待办页回来时强制刷新一次
    todosDirty: false,
    // 推送配置（云开发方案）：模板 ID 用于申请订阅授权；pushBound 表示本机已登记为推送设备
    templateId: '',
    // 多模板并行：一次授权同时给这些模板各补 1 条额度；空数组时按单模板兜底
    templateIds: [],
    pushBound: false,
    // 引导入口要展开的段落：auth / features / reach；tabBar 页不能带 query，借它传一次
    guideTab: '',
  },

  onLaunch() {
    // 清理旧版自建推送服务遗留的存储
    try {
      wx.removeStorageSync('pushBaseUrl')
      wx.removeStorageSync('pushToken')
    } catch (e) { /* 忽略 */ }
    this.globalData.templateId = wx.getStorageSync('templateId') || ''
    this.globalData.templateIds = wx.getStorageSync('templateIds') || []
    this.globalData.pushBound = !!wx.getStorageSync('pushBound')
    this.globalData.lang = i18n.current()
    this.globalData.region = i18n.region(this.globalData.lang)
  },

  /**
   * 切换界面语言：
   * ① 落 storage ② 作废 holidayMap 缓存（首页/节假日页会按新地区重建）
   * ③ 刷新自定义 tabBar 文案 ④ 通知当前页面重新注入字典。
   * 注意：pusher/pushapi 云端提醒链路完全不感知语言，保持零改动；
   * 地区节假日影响的是端上的显示与「下次提醒」预览。
   */
  setLang(code) {
    if (!i18n.set(code)) return false
    this.globalData.lang = code
    this.globalData.region = i18n.region(code)
    this.globalData.holidaysLoaded = false
    this.globalData.holidayMap = {}
    this.globalData.todosDirty = true
    this.refreshTabBar()
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    const page = pages.length ? pages[pages.length - 1] : null
    if (page && typeof page.onLangChanged === 'function') page.onLangChanged(code)
    return true
  },

  /** 让当前/所有已挂载的自定义 tabBar 实例重取文案 */
  refreshTabBar() {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    pages.forEach((p) => {
      try {
        const bar = typeof p.getTabBar === 'function' ? p.getTabBar() : null
        if (bar && typeof bar.applyLang === 'function') bar.applyLang()
      } catch (e) { /* 组件尚未挂载，页面 onShow 会再补一次 */ }
    })
  },

  setHolidayMap(map) {
    this.globalData.holidayMap = map || {}
    this.globalData.holidaysLoaded = true
  },

  savePushConfig(templateId, bound, templateIds) {
    if (typeof templateId === 'string') {
      this.globalData.templateId = templateId
      wx.setStorageSync('templateId', templateId)
    }
    // 云端 status 下发的模板 ID 列表；一次授权会同时给它们各补 1 条额度
    if (Array.isArray(templateIds)) {
      this.globalData.templateIds = templateIds
      wx.setStorageSync('templateIds', templateIds)
    }
    if (typeof bound === 'boolean') {
      this.globalData.pushBound = bound
      wx.setStorageSync('pushBound', bound)
    }
  },

  cloudClient() {
    return cloud
  },
})
