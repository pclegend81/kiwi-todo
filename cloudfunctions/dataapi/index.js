/**
 * KIWI待办 · 批量读写云函数
 *
 * 关键点：小程序端的 db.collection().add() 只能插单条，传数组会直接失败
 * （这就是「提醒同步失败」弹窗的根因）。云函数端支持数组批量插入，
 * 且与数据库同在内网，几十条记录一次写完，比端上循环快一个量级。
 *
 * 支持的 action：
 *   batchInsert  —— 批量新增：{ collection, rows }
 *   batchUpdate  —— 批量更新待办：{ items: [{ id, patch }] }
 *   batchDelete  —— 批量删除待办：{ ids: [...] }（先校验 openid 归属再删）
 *   pruneHolidays—— 清理早于某年的节假日：{ beforeYear: '2027' }
 *   removeHoliday—— 删除一条节假日：{ id, day }（公共表按管理员权限删）
 *
 * 权限：云函数以管理员身份访问数据库，不受集合安全规则限制；
 * 数据归属仍靠写入的 openid 字段保证，与端上写入保持一致。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
/** 构建标记：云端测试返回该值即可确认部署了新版（支持 batchDelete / pruneHolidays / removeHoliday） */
const BUILD = '2026-11-12d'

// 允许操作的集合（防止被当通用网关滥用）
const ALLOWED = {
  todos: true,
  remind_logs: true,
  holidays: true,
  push_devices: true,
}

// 单次批量上限（云开发单批 100 条，留些余量）
const MAX_BATCH = 100

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function batchInsert(collection, rows, openid) {
  const name = String(collection || '')
  if (!ALLOWED[name]) return { ok: false, message: '不允许操作集合：' + name }
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) return { ok: true, inserted: 0 }

  let inserted = 0
  const batches = chunk(list, MAX_BATCH)
  for (let i = 0; i < batches.length; i++) {
    const docs = batches[i].map((r) => Object.assign({}, r, { openid: openid }))
    try {
      // 云函数端支持数组批量插入
      await db.collection(name).add({ data: docs })
      inserted += docs.length
    } catch (e) {
      // 个别环境不支持数组插入时，退化为逐条写，保证功能可用
      for (let j = 0; j < docs.length; j++) {
        await db.collection(name).add({ data: docs[j] })
        inserted += 1
      }
    }
  }
  return { ok: true, inserted: inserted }
}

async function batchUpdate(items, openid) {
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return { ok: true, updated: 0 }
  const jobs = list.map((it) => {
    const data = Object.assign({}, it && it.patch, {
      openid: openid,
      updated_at: new Date().toISOString(),
    })
    return db.collection('todos').doc(String(it && it.id)).update({ data: data })
  })
  // 并发更新；单条失败不影响其他条
  const settled = await Promise.all(
    jobs.map((p) => p.then(() => 1).catch(() => 0))
  )
  return { ok: true, updated: settled.reduce((a, b) => a + b, 0) }
}

/**
 * 批量删除待办。云函数以管理员权限绕过集合安全规则，必须自己校验归属：
 * 先按 id + openid 查回真正属于调用者的记录，再逐条删，避免被当通用删除网关滥用。
 */
async function batchDelete(ids, openid) {
  const list = (Array.isArray(ids) ? ids : [])
    .map(String)
    .filter(Boolean)
    .slice(0, MAX_BATCH * 2)
  if (list.length === 0) return { ok: true, removed: 0 }
  let own = []
  try {
    const found = await db.collection('todos')
      .where({ _id: _.in(list), openid: openid })
      .limit(MAX_BATCH * 2)
      .get()
    own = (found.data || []).map((r) => String(r._id))
  } catch (e) {
    return { ok: false, message: '批量删除查询失败：' + (e.errMsg || e.message) }
  }
  if (own.length === 0) return { ok: true, removed: 0, build: BUILD }
  // 并发删；单条失败不影响其他条，返回真实成功数让端上提示「X 条失败请重试」
  const settled = await Promise.all(
    own.map((id) => db.collection('todos').doc(id).remove().then(() => 1).catch(() => 0))
  )
  return { ok: true, removed: settled.reduce((a, b) => a + b, 0), build: BUILD }
}

/**
 * 清理早于 beforeYear 的节假日（如删掉全部 2026）。
 * 节假日是公共表，客户端逐条删会受创建者权限限制；云函数管理员权限可一次删干净。
 * day 形如 'YYYY-MM-DD'，字符串前缀比较即可精确按年份切分。
 */
async function pruneHolidays(beforeYear) {
  const y = String(beforeYear || '')
  if (!/^\d{4}$/.test(y)) return { ok: false, message: '年份不合法：' + y }
  const threshold = y + '-01-01'
  let removed = 0
  // where().remove() 单次上限 1000；循环直到删空，防止残留
  for (let i = 0; i < 10; i++) {
    const res = await db.collection('holidays').where({ day: _.lt(threshold) }).remove()
    const n = (res && res.stats && res.stats.removed) || 0
    removed += n
    if (n === 0) break
  }
  return { ok: true, removed: removed, build: BUILD }
}

/**
 * 删除一条节假日。优先按 id 删；id 为空（内置兜底行）时按 day 删。
 * 公共表里的记录可能由其他用户创建，只有管理员权限能删干净。
 */
async function removeHoliday(id, day) {
  if (id) {
    try {
      await db.collection('holidays').doc(String(id)).remove()
      return { ok: true, removed: 1, build: BUILD }
    } catch (e) { /* id 无效时继续按 day 兜底 */ }
  }
  const key = String(day || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return { ok: false, message: '缺少有效的 id 或 day' }
  const res = await db.collection('holidays').where({ day: key }).remove()
  return { ok: true, removed: (res && res.stats && res.stats.removed) || 0, build: BUILD }
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID || wxContext.FROM_OPENID
  if (!openid) return { ok: false, message: '无法识别用户身份' }

  const action = String(event.action || '')
  try {
    if (action === 'batchInsert') {
      return await batchInsert(event.collection, event.rows, openid)
    }
    if (action === 'batchUpdate') {
      return await batchUpdate(event.items, openid)
    }
    if (action === 'batchDelete') {
      return await batchDelete(event.ids, openid)
    }
    if (action === 'pruneHolidays') {
      return await pruneHolidays(event.beforeYear)
    }
    if (action === 'removeHoliday') {
      return await removeHoliday(event.id, event.day)
    }
    return { ok: false, message: '未知操作：' + action + '｜dataapi 版本 ' + BUILD }
  } catch (e) {
    console.error('[dataapi] 处理失败：', e)
    return { ok: false, message: e.errMsg || e.message || '云函数内部错误' }
  }
}
