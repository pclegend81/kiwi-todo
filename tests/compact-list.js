/**
 * 首页待办列表「紧凑布局」回归测试（纯 Node）：
 *   node tests/compact-list.js
 *
 * 需求：待办卡片之间太松散，一屏至少放得下 3 条。
 *
 * 原布局估算（750rpx 设计宽）：
 *   .card padding 32rpx×2 + margin-bottom 24rpx；卡片内 7 行（标题 / 标签 / 备注 /
 *   节假日标签 / divider / 下次提醒 / 操作按钮），典型高度约 500rpx。
 *   加上头部 + 筛选卡约 320rpx，一屏（约 1320rpx 可视）只能看到 2 条。
 *
 * 新布局：两行标签并成一行（可折行）、内边距与按钮变矮、分隔线留白减半。
 * 本测试从 WXSS 里读出真实数值，按行盒模型算出典型卡片高度，
 * 断言「单卡 ≤ 330rpx」且「3 卡 + 页头 ≤ 1320rpx」，防止以后改样式又撑回去。
 *
 * 高度模型假设（写清楚，避免被当成玄学）：
 *   - 每行高度 = 该行最大字号 × line-height；胶囊另加上下 padding；
 *   - 默认待办无备注、标签一行放得下（最常见情况）；
 *   - 带备注或标签折行时单卡约 310~350rpx，大屏手机仍可放 3 条。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
let problems = 0
function ok(msg) { console.log('  ✓ ' + msg) }
function bad(msg) { problems++; console.log('  ✗ ' + msg) }
function check(name, fn) {
  try { fn(); ok(name) } catch (e) { bad(name + '：' + e.message) }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8') }

/** 取某个选择器的规则体 */
function block(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 允许「选择器 A, 选择器 B { ... }」这种合并写法
  // 锚定到行首，避免 .done-btn 误匹配到 .todo-card .done-btn 的后半段
  const m = new RegExp('(?:^|\\n)\\s*' + esc + '\\s*(?:,[^{]*)?\\{([^}]*)\\}').exec(css)
  assert.ok(m, '找不到样式规则 ' + selector)
  return m[1]
}
/** 读取 rpx 数值（padding 这种多值取第一个） */
function rpx(css, selector, prop) {
  const m = new RegExp(prop + '\\s*:\\s*([\\d.]+)rpx').exec(block(css, selector))
  assert.ok(m, selector + ' 里找不到 ' + prop)
  return Number(m[1])
}
/** 读取无单位数值（line-height） */
function unitless(css, selector, prop) {
  const m = new RegExp(prop + '\\s*:\\s*([\\d.]+)\\s*;').exec(block(css, selector))
  assert.ok(m, selector + ' 里找不到 ' + prop)
  return Number(m[1])
}

async function main() {
  console.log('首页待办紧凑布局 · 回归测试')

  const wxml = read('pages/index/index.wxml')
  const wxss = read('pages/index/index.wxss')
  const appWxss = read('app.wxss')

  /* ── 结构 ─────────────────────────────────────────────────────────── */

  check('待办卡片挂了 todo-card 紧凑类，全局 .card 不变（不影响其它页面）', () => {
    assert.ok(/class="card todo-card \{\{batchMode/.test(wxml))
    assert.ok(/\.todo-card\s*\{/.test(wxss))
    assert.ok(/\.card\s*\{[^}]*padding: 32rpx/.test(appWxss))
  })

  check('原来的两行标签已并成一行，且允许折行不挤变形', () => {
    const tags = wxml.slice(wxml.indexOf('class="row todo-tags"'), wxml.indexOf('todo-divider'))
    assert.ok(/priority-\{\{item\.priority\}\}/.test(tags))
    assert.ok(/待确认完成/.test(tags))
    assert.ok(/协作/.test(tags))
    assert.ok(/附件/.test(tags))
    assert.ok(/item\.skipHolidayText/.test(tags), '节假日标签必须并进同一行')
    assert.ok(!/class="divider"/.test(wxml.slice(wxml.indexOf('wx:for="{{activeList}}"'))))
    assert.ok(/\.todo-tags\s*\{[^}]*flex-wrap:\s*wrap/.test(wxss))
  })

  check('胶囊仍不收缩不折行（CJK 文字被挤换行的老毛病不能复发）', () => {
    const tagRule = block(appWxss, '.tag')
    assert.ok(/flex-shrink:\s*0/.test(tagRule))
    assert.ok(/white-space:\s*nowrap/.test(tagRule))
    assert.ok(/align-items:\s*center/.test(tagRule))
  })

  check('完成 / 删除入口保持可用（catchtap、二次确认入口、批量时隐藏）', () => {
    assert.ok(/catchtap="onDoneTap"/.test(wxml))
    assert.ok(/catchtap="onDeleteTap"/.test(wxml))
    assert.ok(/wx:if="\{\{!batchMode\}\}" class="row todo-actions"/.test(wxml))
    assert.ok(/\.done-btn-on\s*\{/.test(wxss))
  })

  check('页头 / 筛选卡 / 到期横幅也一起收紧', () => {
    assert.ok(/class="card sort-card"/.test(wxml))
    assert.ok(/\.page-header\s*\{[^}]*padding-bottom:\s*16rpx/.test(wxss))
    assert.ok(/\.sort-card\s*\{[^}]*padding:\s*18rpx/.test(wxss))
    assert.ok(/\.banner-card\s*\{[^}]*padding:\s*20rpx/.test(wxss))
    assert.ok(/\.fresh-item\s*\{[^}]*padding:\s*10rpx/.test(wxss))
  })

  check('批量模式底部留白仍够（不遮最后一张卡 / tabBar）', () => {
    assert.ok(/\.container-batch\s*\{[^}]*padding-bottom:\s*420rpx/.test(appWxss))
    assert.ok(/bottom: calc\(148rpx \+ env\(safe-area-inset-bottom\)\)/.test(wxss))
  })

  /* ── 高度预算 ─────────────────────────────────────────────────────── */

  const padV = rpx(wxss, '.todo-card', 'padding') * 2
  const cardGap = rpx(wxss, '.todo-card', 'margin-bottom')
  const lineH = unitless(wxss, '.todo-card', 'line-height')
  const titleFs = rpx(wxss, '.todo-card .todo-title', 'font-size')
  const tagFs = rpx(appWxss, '.tag', 'font-size')
  const tagLh = unitless(appWxss, '.tag', 'line-height')
  const tagPad = rpx(wxss, '.todo-card .tag', 'padding')
  const tagsTop = 8 // WXML 里 todo-tags 的 margin-top:8rpx，与 margin-bottom:-8rpx 抵消
  const dividerH = 1 + rpx(wxss, '.todo-divider', 'margin') * 2
  const smallFs = rpx(wxss, '.todo-card .small', 'font-size')
  const btnFs = rpx(wxss, '.todo-card .done-btn', 'font-size')
  const btnPad = rpx(wxss, '.todo-card .done-btn', 'padding')
  const btnLh = unitless(wxss, '.done-btn', 'line-height')
  const actionsGap = rpx(wxss, '.todo-actions', 'margin-top')

  const rowTitle = titleFs * lineH
  const rowTags = tagFs * tagLh + tagPad * 2 + tagsTop
  const rowInfo = smallFs * lineH
  const rowActions = btnFs * btnLh + btnPad * 2 + actionsGap
  const cardH = padV + rowTitle + rowTags + dividerH + rowInfo + rowActions
  const perCard = cardH + cardGap

  check('典型待办卡片高度 ≤ 330rpx（原来约 500rpx）', () => {
    console.log('     估算：卡片 ' + cardH.toFixed(1) + 'rpx + 间距 ' + cardGap +
      'rpx = ' + perCard.toFixed(1) + 'rpx/条')
    assert.ok(perCard <= 330, '实际 ' + perCard.toFixed(1) + 'rpx')
  })

  check('一屏（约 1320rpx 可视）至少放得下 3 条完整待办', () => {
    const aboveList = 300 // container 顶部 + 页头 + 筛选卡，已按新样式收紧
    const needed = 3 * perCard + aboveList
    console.log('     估算：3 条 ' + (3 * perCard).toFixed(1) + 'rpx + 页头 ' + aboveList +
      'rpx = ' + needed.toFixed(1) + 'rpx / 预算 1320rpx')
    assert.ok(needed <= 1320, '实际需要 ' + needed.toFixed(1) + 'rpx')
  })

  console.log(problems === 0 ? '\n全部通过（8 项）' : '\n失败 ' + problems + ' 项')
  if (problems > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
