const store = require('../../utils/store')
const subscribe = require('../../utils/subscribe')
const push = require('../../utils/push')
const i18n = require('../../utils/i18n')
const { callFunction } = require('../../utils/cloud')
const { onShareAppMessage } = require('../../utils/share')

const app = getApp()

const t = (key, vars) => i18n.t(key, vars)

Page({
  onAnyTap: subscribe.onAnyTap,
  onShareAppMessage: onShareAppMessage,
  data: {
    signedIn: false,
    // 节假日卡片副标题：由当前地区种子年份动态生成（避免写死年份）
    holidayHint: '',
    holidayFromText: '',
    // 语言选择：11 种苹果实时翻译语言，切换会同时换当地节假日
    T: {},
    lang: 'zh-CN',
    langLabels: [],
    langIndex: 0,
    regionName: '',
    // 同步口令：网页/电脑端凭它绑定到本账号，实现多端同步
    syncCode: '',
    syncExpireText: '',
    syncLoading: false,
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
      if (typeof this.getTabBar().applyLang === 'function') this.getTabBar().applyLang()
    }
    this.applyLangTexts()
    this.refreshSession()
    this.refreshSyncBinding()
  },

  /** 注入当前语言字典 + 语言选择器 + 当前地区节假日说明 */
  applyLangTexts() {
    const lang = i18n.current()
    const seed = store.regionSeed(i18n.region(lang))
    const years = Array.from(new Set((seed || []).map((h) => String(h.day).slice(0, 4)))).sort()
    const labels = i18n.LANGS.map((l) => l.label)
    const idx = Math.max(0, i18n.LANGS.findIndex((l) => l.code === lang))
    i18n.applyPage(this)
    this.setData({
      langLabels: labels,
      langIndex: idx,
      holidayHint: years.length ? t('mp_holiday_hint', { years: years.join('、') }) : '',
      holidayFromText: t('holiday_from', { name: i18n.regionName(lang) }),
    })
  },

  /** app.setLang() 会回调当前页，保证不用切页就能看到新文案与地区 */
  onLangChanged() {
    this.applyLangTexts()
    wx.showToast({
      title: t('mp_region_toast', { name: i18n.regionName() }),
      icon: 'none',
      duration: 1800,
    })
  },

  /** 选择语言：picker 的 change 不在 tap 同步链里，先同步补一次订阅额度 */
  onLangChange(e) {
    subscribe.renew()
    const idx = Number(e.detail.value)
    const item = i18n.LANGS[idx]
    if (!item) return
    if (app.setLang(item.code)) this.onLangChanged()
  },

  async refreshSession() {
    const { session, error } = await store.getSession()
    this.setData({ signedIn: !error && !!session })
  },

  async onLogin() {
    const { session, error } = await store.wechatLogin()
    if (error || !session) {
      wx.showToast({ title: (error && error.message) || t('mp_t_login_fail'), icon: 'none' })
      return
    }
    wx.showToast({ title: t('mp_t_login_ok'), icon: 'success' })
    this.setData({ signedIn: true })
  },

  async onSignOut() {
    await store.signOut()
    this.setData({ signedIn: false })
    wx.showToast({ title: t('mp_t_logout'), icon: 'none' })
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
          wx.showToast({ title: t('mp_t_auth_ok'), icon: 'none', duration: 1600 })
        } else {
          wx.showToast({ title: t('mp_t_auth_no'), icon: 'none', duration: 1800 })
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
    wx.showLoading({ title: t('mp_t_sending') })
    try {
      // callFunction 仅在 result.ok 为真时 resolve，故能走到这里即发送成功
      await push.sendTest()
      wx.hideLoading()
      wx.showToast({ title: t('mp_t_test_ok'), icon: 'none', duration: 1800 })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.message) || t('mp_t_test_fail'), icon: 'none', duration: 2000 })
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
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + t('mp_t_expire')
  },

  /** 生成/查看口令，成功后复制到剪贴板方便直接粘贴到网页端 */
  async onSyncGenerate() {
    if (this.data.syncLoading) return
    if (!(await store.ensureOpenid())) {
      wx.showToast({ title: t('mp_t_need_login'), icon: 'none' })
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
      wx.showToast({ title: t('mp_t_copied'), icon: 'none', duration: 1600 })
      this.refreshSyncBinding()
    } catch (e) {
      wx.showToast({ title: (e && e.message) || t('mp_t_gen_fail'), icon: 'none', duration: 2000 })
    } finally {
      this.setData({ syncLoading: false })
    }
  },

  /** 作废口令：所有已绑定的网页端会话立即失效 */
  async onSyncRevoke() {
    const that = this
    wx.showModal({
      title: t('mp_t_revoke_title'),
      content: t('mp_t_revoke_desc'),
      confirmText: t('mp_t_revoke_confirm'),
      confirmColor: '#e64340',
      success(res) {
        if (!res.confirm) return
        callFunction('webapi', { action: 'revokeBinding' })
          .then(() => {
            that.setData({ syncCode: '', syncExpireText: '' })
            wx.showToast({ title: t('mp_t_revoke_ok'), icon: 'none' })
          })
          .catch((e) => {
            wx.showToast({ title: (e && e.message) || t('mp_t_revoke_fail'), icon: 'none' })
          })
      },
    })
  },
})
