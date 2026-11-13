const store = require('../../utils/store')
const subscribe = require('../../utils/subscribe')
const push = require('../../utils/push')
const { callFunction } = require('../../utils/cloud')
const { onShareAppMessage } = require('../../utils/share')

const app = getApp()

Page({
  onAnyTap: subscribe.onAnyTap,
  onShareAppMessage: onShareAppMessage,
  data: {
    signedIn: false,
    // 节假日卡片副标题：由内置种子年份动态生成（避免写死「2026、2027」）
    holidayHint: '内置官方安排，可自行增删；修改后对所有待办生效。',
    // 同步口令：网页/电脑端凭它绑定到本账号，实现多端同步
    syncCode: '',
    syncExpireText: '',
    syncLoading: false,
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
    this.refreshSyncBinding()
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

  /* ── 网页/电脑端同步口令 ─────────────────────────────────────────── */

  /** 查询现有口令（有就不重复生成，避免旧网页会话被作废的困惑） */
  async refreshSyncBinding() {
    if (!(await store.ensureOpenid())) return
    try {
      const res = await callFunction('webapi', { action: 'getBinding' })
      if (res && res.ok && res.binding) {
        this.setData({
          syncCode: res.binding.code,
          syncExpireText: this.formatExpire(res.binding.expire_at),
        })
      }
    } catch (e) { /* webapi 未部署时静默，卡片仍显示生成按钮 */ }
  },

  formatExpire(iso) {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' 前有效'
  },

  /** 生成/查看口令，成功后复制到剪贴板方便直接粘贴到网页端 */
  async onSyncGenerate() {
    if (this.data.syncLoading) return
    if (!(await store.ensureOpenid())) {
      wx.showToast({ title: '请先登录', icon: 'none' })
      return
    }
    this.setData({ syncLoading: true })
    try {
      // callFunction 仅在 result.ok 为真时 resolve；复用已有口令时返回 code 不变
      const res = await callFunction('webapi', { action: 'createBinding' })
      wx.setClipboardData({ data: String(res.code || '') })
      this.setData({
        syncCode: res.code,
        syncExpireText: '',
      })
      wx.showToast({ title: '口令已复制', icon: 'none', duration: 1600 })
      this.refreshSyncBinding()
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '生成失败，请稍后再试', icon: 'none', duration: 2000 })
    } finally {
      this.setData({ syncLoading: false })
    }
  },

  /** 作废口令：所有已绑定的网页端会话立即失效 */
  async onSyncRevoke() {
    const that = this
    wx.showModal({
      title: '作废同步口令',
      content: '已绑定的网页/电脑端将全部退出登录，需要重新输入口令才能同步。确定作废？',
      confirmText: '作废',
      confirmColor: '#e64340',
      success(res) {
        if (!res.confirm) return
        callFunction('webapi', { action: 'revokeBinding' })
          .then(() => {
            that.setData({ syncCode: '', syncExpireText: '' })
            wx.showToast({ title: '已作废', icon: 'none' })
          })
          .catch((e) => {
            wx.showToast({ title: (e && e.message) || '作废失败', icon: 'none' })
          })
      },
    })
  },
})
