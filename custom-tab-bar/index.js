/**
 * 自定义底部标签栏（iOS 27 Liquid Glass 风格浮动胶囊条）。
 * 微信原生 tabBar 字号由系统固定（10px）不可调，改用自定义组件才能放大加粗。
 *
 * 两个关键坑：
 * 1. 每个 tab 页有独立的组件实例，selected 初值都是 0；
 *    页面 onShow 里 getTabBar() 可能还没挂载好（首次进入常见），
 *    所以这里用当前路由反查 selected，不依赖页面回写。
 * 2. 不能用 selected 做「点击去重」，否则状态一旦不同步，点击就会彻底失效。
 *
 * 多语言：文案由 utils/i18n.js 提供，切语言后 app.refreshTabBar() 与各 tab 页
 * onShow 都会调 applyLang()，避免 tabBar 停留在旧语言。
 */
const i18n = require('../utils/i18n')

function tabTexts() {
  return [
    i18n.t('mp_tab_index'),
    i18n.t('mp_tab_history_full'),
    i18n.t('mp_tab_mine'),
  ]
}

Component({
  data: {
    selected: 0,
    list: [
      { pagePath: 'pages/index/index', text: tabTexts()[0] },
      { pagePath: 'pages/history/history', text: tabTexts()[1] },
      { pagePath: 'pages/mine/mine', text: tabTexts()[2] },
    ],
  },

  lifetimes: {
    attached() {
      this.applyLang()
      this.syncFromRoute()
    },
    ready() {
      this.applyLang()
      this.syncFromRoute()
    },
  },

  methods: {
    /** 重新取当前语言的三个标签文案 */
    applyLang() {
      const texts = tabTexts()
      const list = this.data.list.map((item, i) => Object.assign({}, item, { text: texts[i] }))
      this.setData({ list: list })
    },

    /** 用当前页面路由反查选中项，避免依赖页面 onShow 的回写时机 */
    syncFromRoute() {
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
      if (!pages.length) return
      const current = pages[pages.length - 1]
      const route = String((current && current.route) || '')
      if (!route) return
      for (let i = 0; i < this.data.list.length; i++) {
        if (this.data.list[i].pagePath === route) {
          if (i !== this.data.selected) this.setData({ selected: i })
          return
        }
      }
    },

    onTab(e) {
      const index = Number(e.currentTarget.dataset.index)
      const item = this.data.list[index]
      if (!item) return

      const url = '/' + item.pagePath
      const prev = this.data.selected
      if (index !== prev) this.setData({ selected: index })

      wx.switchTab({
        url: url,
        fail: (err) => {
          if (index !== prev) this.setData({ selected: prev })
          console.error('[tabbar] switchTab 失败', url, err)
          wx.showToast({ title: i18n.t('idx2_tab_fail', { err: ((err && err.errMsg) || i18n.t('idx2_unknown')) }), icon: 'none' })
        },
      })
    },
  },
})
