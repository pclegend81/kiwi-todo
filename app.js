const { cloud } = require('./utils/cloud')

App({
  globalData: {
    // 节假日映射 {'2026-01-01': 'holiday'}，启动时从云端拉取并在各页面共享
    holidayMap: {},
    holidaysLoaded: false,
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
