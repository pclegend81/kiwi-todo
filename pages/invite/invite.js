const store = require('../../utils/store')
const collab = require('../../utils/collab')
const core = require('../../utils/reminder-core')
const subscribe = require('../../utils/subscribe')
const attachments = require('../../utils/attachments')
const i18n = require('../../utils/i18n')
const fmt = require('../../utils/i18n-format')

const app = getApp()
const t = (key, vars) => i18n.t(key, vars)

/** 重复方式 + 生效日期范围，好友得看全规则再决定加不加入 */
function describeRepeatWithRange(todo) {
  const text = fmt.describeRepeat(todo)
  const range = fmt.describeRepeatRange(todo)
  return range ? text + t('fmt_range_paren', { range: range }) : text
}

/**
 * 邀请落地页。
 *
 * 好友点开分享卡片 → 走 /pages/invite/invite?invite=<inviteId> → 本页。
 * 首次打开小程序的好友在这里静默登录（wx.login 取 openid，无需授权弹窗），
 * 展示待办快照，点「接受并加入」后由云函数把副本写进他名下。
 */
Page({
  onAnyTap: subscribe.onAnyTap,
  data: {
    inviteId: '',
    loading: true,
    signedIn: false,
    errorText: '',
    joined: false,
    isOwner: false,
    priorityKey: 'medium',
    memberCount: 0,
    memberNames: [],
    code: '',
    fromNew: false,
    title: '',
    note: '',
    images: [],
    location: null,
    remindText: '',
    repeatText: '',
    holidayText: '',
    priorityText: '',
    busy: false,
  },

  onLoad(options) {
    const inviteId = String((options && (options.invite || options.i)) || '')
    this.setData({
      inviteId: inviteId,
      fromNew: String((options && options.from) || '') === 'new',
    })
  },

  onShow() {
    const lang = i18n.current()
    const changed = !!this._lastLang && this._lastLang !== lang
    this._lastLang = lang
    i18n.applyPage(this)
    if (changed) this.onLangChanged(lang)
    else this.bootstrap()
  },

  onLangChanged(code) {
    this._lastLang = code || i18n.current()
    i18n.applyPage(this)
    this.bootstrap()
  },

  async bootstrap() {
    const self = this
    const { session, error } = await store.getSession()
    let signedIn = !error && !!session
    if (!signedIn) {
      // 静默登录：wx.login 取 openid，不会弹授权框
      const res = await store.wechatLogin()
      signedIn = !res.error && !!res.session
    }
    app.globalData.signedIn = signedIn
    self.setData({ signedIn: signedIn })
    if (!signedIn) {
      self.setData({ loading: false, errorText: t('inv_login_fail') })
      return
    }
    await self.loadDetail()
  },

  async loadDetail() {
    const self = this
    self.setData({ loading: true, errorText: '' })
    const { data, error } = await collab.detail(self.data.inviteId)
    if (error || !data) {
      self.setData({
        loading: false,
        errorText: (error && error.message) || t('inv_not_found'),
      })
      return
    }
    const todo = data.todo || {}
    const first = new Date(todo.remind_at)
    const remindText = isNaN(first.getTime())
      ? '—'
      : core.dateKey(first) + ' ' + core.minuteKey(first) + ' ' + fmt.weekday(first)
    let holidayText = t('inv_holiday_normal')
    if (todo.repeat_type === 'restday') holidayText = t('inv_holiday_restday')
    else if (todo.skip_holiday) {
      holidayText = todo.holiday_action === 'postpone' ? t('inv_holiday_postpone') : t('inv_holiday_skip')
    }
    self.setData({
      loading: false,
      title: String(todo.title || ''),
      note: String(todo.note || ''),
      images: Array.isArray(todo.images) ? todo.images : [],
      location: todo.location || null,
      remindText: remindText,
      repeatText: describeRepeatWithRange(todo),
      datesText: fmt.describeRepeatDates(todo, 10),
      holidayText: holidayText,
      priorityKey: String(todo.priority || 'medium'),
      priorityText: fmt.priorityText(todo.priority || 'medium'),
      memberCount: data.memberCount || 0,
      joined: !!data.joined,
      isOwner: !!data.isOwner,
      code: String(data.code || ''),
    })
    if (data.isOwner) self.loadMembers()
  },

  /** 创建者视角：看看谁加入了（昵称是成员自己填的，拿不到微信昵称） */
  async loadMembers() {
    const self = this
    const { data, error } = await collab.members(self.data.inviteId)
    if (error || !data) return
    const rows = data.members || []
    self.setData({
      memberCount: rows.length,
      memberNames: rows.map((m) => String(m.nickname || t('inv_friend'))),
    })
  },

  /** 复制邀请码给好友（微信不让代码直接选好友，发码是唯一的「指定某人」路径） */
  onCopyCode() {
    const code = this.data.code
    if (!code) return
    wx.setClipboardData({ data: code })
  },

  /** 创建者自己打开时可以继续转发这张卡片 */
  onShareAppMessage() {
    const inviteId = this.data.inviteId
    const title = this.data.title
    if (inviteId) {
      return {
        title: t('inv_share_invite', { name: title || t('app_name') }),
        path: '/pages/invite/invite?invite=' + inviteId,
      }
    }
    return {
      title: t('inv_share_default'),
      path: '/pages/index/index',
    }
  },

  /**
   * 接受邀请：副本写进自己名下。
   * 先问一句称呼——小程序拿不到微信昵称，创建者那边只能看到成员自己填的名字。
   */
  async onAccept() {
    if (this.data.busy) return
    const self = this
    // 加入后要能真收到提醒，顺手把订阅授权补上——必须在 await 之前同步调用
    subscribe.renew()
    wx.showModal({
      title: t('inv_join_title'),
      content: t('inv_join_content'),
      editable: true,
      placeholderText: t('inv_nickname_ph'),
      maxLength: 12,
      confirmText: t('inv_join'),
      cancelText: t('cancel'),
      async success(r) {
        if (!r || !r.confirm) return
        await self.doJoin(String(r.content || '').trim())
      },
    })
  },

  async doJoin(nickname) {
    const self = this
    self.setData({ busy: true })
    const { data, error } = await collab.join(self.data.inviteId, nickname)
    self.setData({ busy: false })
    if (error || !data) {
      wx.showToast({ title: (error && error.message) || t('inv_join_fail'), icon: 'none' })
      return
    }
    self.setData({ joined: true, memberCount: (self.data.memberCount || 0) + 1 })
    wx.showModal({
      title: t('inv_joined_title'),
      content: t('inv_joined_content'),
      confirmText: t('inv_go_enable'),
      cancelText: t('idx_got_it'),
      success(r) {
        if (r && r.confirm) {
          wx.switchTab({ url: '/pages/mine/mine' })
        } else {
          wx.switchTab({ url: '/pages/index/index' })
        }
      },
    })
  },

  /** 已经是成员：直接回待办列表 */
  onPreviewImage(e) {
    attachments.previewImage(this.data.images, e.currentTarget.dataset.src)
  },

  onOpenLocation() {
    attachments.openLocation(this.data.location)
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' })
  },
})
