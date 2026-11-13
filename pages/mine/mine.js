const store = require('../../utils/store')
const subscribe = require('../../utils/subscribe')
const push = require('../../utils/push')
const { onShareAppMessage } = require('../../utils/share')

const app = getApp()

Page({
  onAnyTap: subscribe.onAnyTap,
  onShareAppMessage: onShareAppMessage,
  data: {
    signedIn: false,
    // 节假日卡片副标题：由内置种子年份动态生成（避免写死「2026、2027」）
    holidayHint: '内置官方安排，可自行增删；修改后对所有待办生效。',
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
    }
    const seedYears = Array.from(
      new Set((store.SEED_HOLIDAYS || []).map((h) => String(h.day).slice(0, 4)))
    ).sort()
    if (seedYears.length) {
      this.setData({
        holidayHint: '内置 ' + seedYears.join('、') + ' 年官方安排，可自行增删；修改后对所有待办生效。',
      })
    }
    this.refreshSession()
  },

  async refreshSession() {
    const { session, error } = await store.getSession()
    this.setData({ signedIn: !error && !!session })
  },

  async onLogin() {
    const { session, error } = await store.wechatLogin()
    if (error || !session) {
      wx.showToast({ title: (error && error.message) || '登录失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '登录成功', icon: 'success' })
    this.setData({ signedIn: true })
  },

  async onSignOut() {
    await store.signOut()
    this.setData({ signedIn: false })
    wx.showToast({ title: '已退出', icon: 'none' })
  },

  goHolidays() {
    wx.navigateTo({ url: '/pages/holidays/holidays' })
  },

  /** 主动授权：先清掉「曾拒绝不再弹窗」标记，再走唯一授权入口 requestAuth */
  onAuthTap() {
    subscribe.clearDeclined()
    subscribe.requestAuth({
      tmplIds: subscribe.templateIds(),
      onResult(res, info) {
        if (info.accepted > 0) {
          wx.showToast({ title: '已开启，待办到点会提醒', icon: 'none', duration: 1600 })
        } else {
          wx.showToast({ title: '未授权：在弹窗中点「允许」', icon: 'none', duration: 1800 })
        }
      },
    })
  },

  /** 补充提醒次数：清掉拒绝标记后静默续期（带计数 toast） */
  onRenewTap() {
    subscribe.clearDeclined()
    subscribe.renewWithToast()
  },

  /** 发一条测试提醒，验证授权是否生效（需先授权，否则会报 43101） */
  async onTestTap() {
    wx.showLoading({ title: '发送中…' })
    try {
      // callFunction 仅在 result.ok 为真时 resolve，故能走到这里即发送成功
      await push.sendTest()
      wx.hideLoading()
      wx.showToast({ title: '测试提醒已发送，请查收', icon: 'none', duration: 1800 })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.message) || '发送失败，请先开启授权', icon: 'none', duration: 2000 })
    }
  },
})
