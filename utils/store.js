const { db, cloud, callFunction } = require('./cloud')
const { HOLIDAYS_2027 } = require('./holidays-2027')
const holidaysActive = require('./holidays-active')

/** 内置节假日种子数据：新增年份在这里 concat（云端只补缺失的日期）。
 * 2026 已结束，不再内置；如需恢复，重新 require('./holidays-2026') 并 concat 即可。
 * 重要：这里有哪些年份，就只显示/参算哪些年份（见 MIN_HOLIDAY_YEAR）。 */
const SEED_HOLIDAYS = HOLIDAYS_2027

/** 有效年份下界：早于它的一律视为已结束的旧数据，不显示、不参算、自动清理 */
const MIN_HOLIDAY_YEAR = holidaysActive.minSeedYear(SEED_HOLIDAYS) || String(new Date().getFullYear())

/**
 * 数据访问层（微信云开发版）。
 *
 * - 用户身份 = 微信 openid（登录时通过云函数获取并存本地）。
 * - 每条数据都带 openid 字段，配合数据库「自定义安全规则」做用户隔离：
 *     todos / remind_logs : 读写都要求 auth.openid == doc.openid
 *     holidays            : 所有人可读，登录用户可维护
 * - 客户端查询始终显式带 openid 条件，规则与查询双重保险。
 * - 返回结构保持与旧版一致：{ data: [...], error }，data 为空数组表示未登录/无权限。
 */

const OPENID_KEY = 'kiwi_openid'
const HOLIDAY_CACHE_KEY = 'kiwi_holiday_cache'
/** 用户显式删掉的内置日期（本地记录，防止自动回灌把它们补回来） */
const HOLIDAY_EXCLUDED_KEY = 'kiwi_holiday_excluded'

function myOpenid() {
  return String(wx.getStorageSync(OPENID_KEY) || '')
}

/**
 * 静默取 openid：App 启动不会自动登录，而节假日写入（回灌/编辑/删除）都要求身份。
 * 只拿会话、不插入任何待办，避免调用 wechatLogin 时顺带 seedLegacyData 的副作用。
 */
async function ensureOpenid() {
  if (myOpenid()) return true
  try {
    const res = await callFunction('pushapi', { action: 'session' })
    const openid = String((res && res.openid) || '')
    if (!openid) return false
    wx.setStorageSync(OPENID_KEY, openid)
    return true
  } catch (e) {
    return false
  }
}

function readExcludedDays() {
  try {
    const raw = wx.getStorageSync(HOLIDAY_EXCLUDED_KEY)
    return Array.isArray(raw) ? raw.map((d) => String(d).slice(0, 10)) : []
  } catch (e) {
    return []
  }
}

function writeExcludedDays(days) {
  try {
    wx.setStorageSync(HOLIDAY_EXCLUDED_KEY, days)
  } catch (e) { /* 忽略 */ }
}

function excludeHolidayDay(day) {
  const key = String(day || '').slice(0, 10)
  if (!key) return
  const days = readExcludedDays()
  if (days.indexOf(key) < 0) {
    days.push(key)
    writeExcludedDays(days)
  }
}

function restoreHolidayDay(day) {
  const key = String(day || '').slice(0, 10)
  writeExcludedDays(readExcludedDays().filter((d) => d !== key))
}

function clearExcludedDays() {
  writeExcludedDays([])
}

/** 页面统一入口：内置种子兜底 + 云端覆盖 + 排除集过滤，保证有效年份完整可见 */
function mergeActiveHolidays(dbRows) {
  return holidaysActive.mergeWithSeed(
    SEED_HOLIDAYS,
    holidaysActive.filterFrom(dbRows || [], MIN_HOLIDAY_YEAR),
    readExcludedDays()
  )
}

/* ── 节假日本地缓存：避免每次进 App 都拉上千行 ─────────────────────────── */

function readHolidayCache() {
  try {
    const raw = wx.getStorageSync(HOLIDAY_CACHE_KEY)
    if (!raw || !raw.rows || !raw.rows.length) return null
    return raw
  } catch (e) {
    return null
  }
}

function clearHolidayCache() {
  try {
    wx.removeStorageSync(HOLIDAY_CACHE_KEY)
  } catch (e) { /* 忽略 */ }
}

function writeHolidayCache(rows) {
  try {
    wx.setStorageSync(HOLIDAY_CACHE_KEY, { at: Date.now(), rows: rows })
  } catch (e) { /* 忽略 */ }
}

/** 会话即 openid：有本地 openid 视为已登录 */
async function getSession() {
  const openid = myOpenid()
  return { session: openid ? { openid: openid } : null, error: null }
}

/**
 * 旧云服务里唯一的待办，登录时若账号为空则补一次（幂等；客户端写入才会带上 _openid）。
 */
const LEGACY_TODO = {
  title: '打卡',
  note: '',
  remind_at: '2026-10-19T18:01:00+08:00',
  repeat_type: 'workday',
  repeat_interval: 1,
  skip_holiday: true,
  holiday_action: 'skip',
  status: 'active',
  next_remind_at: '2026-10-19T18:01:00+08:00',
  last_reminded_at: null,
}

async function seedLegacyData() {
  try {
    const res = await listTodos()
    if (res.error || (res.data || []).length > 0) return
    await insertTodo(LEGACY_TODO)
  } catch (e) { /* 静默，不影响登录 */ }
}

/** 微信登录：调用云函数取 openid（免鉴权，云环境自动识别调用者） */
async function wechatLogin() {
  try {
    const res = await callFunction('pushapi', { action: 'session' })
    const openid = String(res.openid || '')
    if (!openid) {
      return { session: null, error: { message: '未能识别用户身份，请重试' } }
    }
    wx.setStorageSync(OPENID_KEY, openid)
    await seedLegacyData()
    return { session: { openid: openid }, error: null }
  } catch (e) {
    return { session: null, error: { message: e.message || '登录失败，请重试' } }
  }
}

/** 云开发下无独立会话，清除本地身份即可 */
async function signOut() {
  try {
    wx.removeStorageSync(OPENID_KEY)
  } catch (e) { /* 忽略 */ }
  return { error: null }
}

function wrap(fn) {
  return fn().then(
    (data) => ({ data: data, error: null }),
    (e) => ({ data: [], error: { message: (e && e.errMsg) || (e && e.message) || '云数据库操作失败' } })
  )
}

function withId(row) {
  return Object.assign({}, row, { id: row._id })
}

async function listTodos() {
  const openid = myOpenid()
  if (!openid) return { data: [], error: null }
  return wrap(async () => {
    const res = await db
      .collection('todos')
      .where({ openid: openid })
      .orderBy('remind_at', 'asc')
      .limit(200)
      .get()
    return (res.data || []).map(withId)
  })
}

/**
 * 新建待办（幂等）。
 *
 * payload.client_token 由新建页生成：同一页连点、超时重试、请求重发都带同一个 token。
 * 两层防重，缺一不可：
 *   1. insertInflight：同一 token 的并发调用复用同一个 Promise，不会并发发出两次 add；
 *   2. 仅重试时按 openid + client_token 查库：上一次其实已写成功（只是客户端没收到响应）时，
 *      直接复用那条记录并覆盖成最新内容，不再新增第二条；首次写入直接 add，不拖慢保存。
 * 不带 token 的调用（如登录时补的示例待办）保持原来的单次 add 行为。
 */
const insertInflight = Object.create(null)
/** 本次会话里已经发起过写入的 token：只有这类「重试」才需要先查库判重 */
const issuedTokens = Object.create(null)

async function insertTodoOnce(payload, openid, isRetry) {
  const token = String((payload && payload.client_token) || '')
  return wrap(async () => {
    const doc = Object.assign({}, payload, { openid: openid, created_at: new Date().toISOString() })
    // 首次写入直接 add，不给保存多添一次网络往返；
    // 只有同 token 重试才查库（上次可能已经写成功，只是客户端没收到响应）。
    if (token && isRetry) {
      try {
        const hit = await db
          .collection('todos')
          .where({ openid: openid, client_token: token })
          .limit(1)
          .get()
        const row = hit && hit.data && hit.data[0]
        if (row) {
          // 重试时用户可能又改了标题/时间：覆盖成最新内容，既不新增也不丢改动
          try {
            await db.collection('todos').doc(String(row._id)).update({ data: doc })
          } catch (e) { /* 权限受限时复用原记录即可 */ }
          return [Object.assign({}, doc, { id: row._id, _id: row._id })]
        }
      } catch (e) { /* 判重读失败不阻断写入，正常走 add */ }
    }
    const res = await db.collection('todos').add({ data: doc })
    return [Object.assign({}, doc, { id: res._id, _id: res._id })]
  })
}

async function insertTodo(payload) {
  const openid = myOpenid()
  if (!openid) return { data: [], error: null }
  const token = String((payload && payload.client_token) || '')
  if (token && insertInflight[token]) return insertInflight[token]
  const isRetry = !!(token && issuedTokens[token])
  if (token) issuedTokens[token] = true
  const task = insertTodoOnce(payload, openid, isRetry)
  if (token) {
    insertInflight[token] = task
    task.then(
      () => { delete insertInflight[token] },
      () => { delete insertInflight[token] }
    )
  }
  return task
}

async function updateTodo(id, patch) {
  const openid = myOpenid()
  if (!openid || !id) return { data: [], error: null }
  return wrap(async () => {
    const data = Object.assign({}, patch, { openid: openid, updated_at: new Date().toISOString() })
    await db.collection('todos').doc(String(id)).update({ data: data })
    return [Object.assign({}, data, { id: String(id) })]
  })
}

async function removeTodo(id) {
  const openid = myOpenid()
  if (!openid || !id) return { data: [], error: null }
  return wrap(async () => {
    await db.collection('todos').doc(String(id)).remove()
    return [{ id: String(id) }]
  })
}

async function listLogs(options) {
  const openid = myOpenid()
  if (!openid) return { data: [], error: null, count: 0 }
  const opts = options || {}
  const pageSize = opts.pageSize || 30
  const from = (opts.page || 0) * pageSize

  const where = { openid: openid }
  if (opts.keyword) {
    const escaped = String(opts.keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    where.todo_title = db.RegExp({ regexp: escaped, options: 'i' })
  }

  try {
    const countRes = await db.collection('remind_logs').where(where).count()
    const dataRes = await db
      .collection('remind_logs')
      .where(where)
      .orderBy('scheduled_at', 'desc')
      .skip(from)
      .limit(pageSize)
      .get()
    return { data: (dataRes.data || []).map(withId), error: null, count: countRes.total || 0 }
  } catch (e) {
    return { data: [], error: { message: (e && e.errMsg) || (e && e.message) || '查询失败' }, count: 0 }
  }
}

/**
 * 分批拉取全部提醒记录（小程序端单次查询上限 20 条），用于本地排序/筛选。
 * 上限 MAX_LOGS 条，超出按时间倒序截断，足够日常使用。
 */
async function listLogsAll() {
  const openid = myOpenid()
  if (!openid) return { data: [], error: null }
  const MAX_LOGS = 500
  const out = []
  try {
    for (let page = 0; page < 30; page++) {
      const res = await db
        .collection('remind_logs')
        .where({ openid: openid })
        .orderBy('scheduled_at', 'desc')
        .skip(page * 20)
        .limit(20)
        .get()
      const rows = res.data || []
      if (!rows.length) break
      out.push.apply(out, rows.map(withId))
      if (rows.length < 20 || out.length >= MAX_LOGS) break
    }
    return { data: out, error: null }
  } catch (e) {
    return { data: [], error: { message: (e && e.errMsg) || (e && e.message) || '查询失败' } }
  }
}

/**
 * 端上兜底写入：小程序端 db.collection().add() 只支持单条，
 * 所以并发发单条请求（云函数 dataapi 不可用时的退路）。
 */
async function insertOneByOne(collection, rows) {
  const openid = myOpenid()
  const docs = rows.map((r) => Object.assign({}, r, { openid: openid }))
  const settled = await Promise.all(
    docs.map((doc) =>
      db
        .collection(collection)
        .add({ data: doc })
        .then((res) => ({ doc: doc, id: res && res._id }))
        .catch(() => null)
    )
  )
  const ok = settled.filter(Boolean)
  if (ok.length === 0) {
    return { data: [], error: { message: '写入失败：' + collection } }
  }
  return { data: ok.map((r) => Object.assign({}, r.doc, { id: r.id, _id: r.id })), error: null }
}

/** 批量新增：优先走云函数（一次网络往返），失败再回退到端上逐条写 */
async function batchInsert(collection, rows) {
  const openid = myOpenid()
  if (!openid || !rows || rows.length === 0) return { data: [], error: null }
  try {
    const res = await callFunction('dataapi', {
      action: 'batchInsert',
      collection: collection,
      rows: rows,
    })
    if (res && res.ok) {
      return { data: rows.map((r) => Object.assign({}, r, { openid: openid })), error: null }
    }
    if (res && res.message) console.warn('[store] batchInsert 返回异常：', res.message)
  } catch (e) {
    // 云函数未部署时静默回退
    console.warn('[store] dataapi 不可用，回退逐条写入：', (e && e.message) || e)
  }
  return insertOneByOne(collection, rows)
}

async function insertLogs(rows) {
  return batchInsert('remind_logs', rows)
}

/** 批量更新待办：一次云函数调用写完所有补丁（端上退化为并发单条） */
async function batchUpdateTodos(items) {
  const openid = myOpenid()
  if (!openid || !items || items.length === 0) return { updated: 0, error: null }
  try {
    const res = await callFunction('dataapi', { action: 'batchUpdate', items: items })
    if (res && res.ok) return { updated: res.updated || items.length, error: null }
    if (res && res.message) console.warn('[store] batchUpdate 返回异常：', res.message)
  } catch (e) {
    console.warn('[store] dataapi 不可用，回退逐条更新：', (e && e.message) || e)
  }
  const settled = await Promise.all(
    items.map((it) => updateTodo(it.id, it.patch).then(() => 1, () => 0))
  )
  return { updated: settled.reduce((a, b) => a + b, 0), error: null }
}

/**
 * 批量删除待办：优先走云函数（管理员权限，一次调用并发删），
 * 云端旧版 / 未部署时退回端上并发单条 remove —— 功能不依赖重新部署。
 * 返回值 { removed } 是真正删掉的条数，页面据此提示「X 条失败请重试」。
 */
async function batchDeleteTodos(ids) {
  const openid = myOpenid()
  const list = (ids || []).map(String).filter(Boolean)
  if (!openid || list.length === 0) return { removed: 0, error: null }
  try {
    const res = await callFunction('dataapi', { action: 'batchDelete', ids: list })
    if (res && res.ok) {
      // removed 可能为 0（例如这些 id 都不属于当前用户）。别写 `res.removed || list.length`：
      // 0 是 falsy，会把「一条都没删掉」误报成「全删成功」，页面就不提示失败、也不回源。
      const removed = typeof res.removed === 'number' ? res.removed : list.length
      return { removed: removed, error: null }
    }
    if (res && res.message) console.warn('[store] batchDelete 返回异常：', res.message)
  } catch (e) {
    console.warn('[store] dataapi 不可用，回退逐条删除：', (e && e.message) || e)
  }
  const settled = await Promise.all(
    list.map((id) => removeTodo(id).then(
      (r) => (!r.error && r.data && r.data.length ? 1 : 0),
      () => 0
    ))
  )
  return { removed: settled.reduce((a, b) => a + b, 0), error: null }
}

async function removeLog(id) {
  const openid = myOpenid()
  if (!openid || !id) return { data: [], error: null }
  return wrap(async () => {
    await db.collection('remind_logs').doc(String(id)).remove()
    return [{ id: String(id) }]
  })
}

async function listHolidays() {
  return wrap(async () => {
    // 节假日是公共数据（所有用户可读），不加 openid 条件
    const res = await db.collection('holidays').orderBy('day', 'asc').limit(1000).get()
    const all = (res.data || []).map(withId)
    // 硬过滤：早于有效年份的旧数据（如 2026）不返回给任何页面，
    // 既不显示也不进 holidayMap，删除是否成功都不影响可见结果。
    const rows = holidaysActive.filterFrom(all, MIN_HOLIDAY_YEAR)
    writeHolidayCache(rows) // 覆盖旧缓存，避免缓存里残留 2026
    return rows
  })
}

/** 云端没有（或缺）节假日数据时，用内置静态表回灌（只补缺失的日期） */
async function seedHolidays(existingDays) {
  const openid = myOpenid()
  if (!openid) return { inserted: 0, error: null }
  const known = existingDays || []
  const excluded = readExcludedDays()
  const missing = SEED_HOLIDAYS.filter(
    (h) => known.indexOf(h.day) === -1 && excluded.indexOf(h.day) === -1
  )
  if (missing.length === 0) return { inserted: 0, error: null }
  const rows = missing.map((h) => ({
    day: h.day,
    name: h.name,
    kind: h.kind,
    year: Number(String(h.day).slice(0, 4)) || Number(MIN_HOLIDAY_YEAR),
  }))
  const res = await batchInsert('holidays', rows)
  if (res.error) return { inserted: 0, error: res.error }
  return { inserted: (res.data || []).length, error: null }
}

async function upsertHoliday(row) {
  const openid = myOpenid()
  if (!openid) return { data: [], error: null }
  return wrap(async () => {
    if (row.id) {
      const data = Object.assign({}, row, { openid: openid, updated_at: new Date().toISOString() })
      await db.collection('holidays').doc(String(row.id)).update({ data: data })
      return [Object.assign({}, data, { id: String(row.id) })]
    }
    // 同一天只保留一条：先查再插/改
    const exist = await db.collection('holidays').where({ day: row.day }).limit(1).get()
    if (exist.data && exist.data.length > 0) {
      const target = exist.data[0]
      await db.collection('holidays').doc(target._id).update({ data: row })
      return [Object.assign({}, target, row, { id: target._id })]
    }
    const doc = Object.assign({}, row, { openid: openid, created_at: new Date().toISOString() })
    const res = await db.collection('holidays').add({ data: doc })
    return [Object.assign({}, doc, { id: res._id, _id: res._id })]
  })
}

/**
 * 编辑保存一条节假日（支持改日期）。
 * - 有 id：直接更新；若新日期已被另一条记录占用，删旧行再更新占用者，避免同日两条。
 * - 无 id（内置兜底行，库里还没有）：按 day 查重后更新或新增，落库后就有真实 id。
 */
async function saveHoliday(row, oldDay) {
  const openid = myOpenid()
  if (!openid) return { data: [], error: null }
  return wrap(async () => {
    const day = String((row && row.day) || '').slice(0, 10)
    const data = {
      day: day,
      name: String((row && row.name) || ''),
      kind: (row && row.kind) === 'workday' ? 'workday' : 'holiday',
      year: Number(day.slice(0, 4)) || Number(MIN_HOLIDAY_YEAR),
      openid: openid,
      updated_at: new Date().toISOString(),
    }
    const id = String((row && row.id) || '')
    if (id) {
      if (oldDay && oldDay !== day) {
        const dup = await db.collection('holidays').where({ day: day }).limit(5).get()
        const other = (dup.data || []).filter((r) => String(r._id) !== id)[0]
        if (other) {
          try { await db.collection('holidays').doc(id).remove() } catch (e) { /* 权限不足时继续 */ }
          await db.collection('holidays').doc(String(other._id)).update({ data: data })
          return [Object.assign({}, data, { id: String(other._id) })]
        }
      }
      await db.collection('holidays').doc(id).update({ data: data })
      return [Object.assign({}, data, { id: id })]
    }
    const exist = await db.collection('holidays').where({ day: day }).limit(1).get()
    if (exist.data && exist.data.length > 0) {
      const target = exist.data[0]
      await db.collection('holidays').doc(target._id).update({ data: data })
      return [Object.assign({}, data, { id: target._id })]
    }
    const doc = Object.assign({}, data, { created_at: new Date().toISOString() })
    const res = await db.collection('holidays').add({ data: doc })
    return [Object.assign({}, doc, { id: res._id })]
  })
}

/**
 * 删除节假日：优先走 dataapi 管理员权限（公共表里他人创建的记录也能删），
 * 云函数旧版 / 未部署时退回客户端按 id 删；内置兜底行（无 id）本来就不在库里。
 * 无论删库是否成功，页面都会把该 day 记入本地排除集，保证不再显示、不再回灌。
 */
async function removeHoliday(id, day) {
  const docId = String(id || '')
  const key = String(day || '').slice(0, 10)
  if (!docId && !key) return { data: [], error: null }
  try {
    const res = await callFunction('dataapi', {
      action: 'removeHoliday',
      id: docId,
      day: key,
    })
    if (res && res.ok) return { data: [{ id: docId, day: key }], error: null }
  } catch (e) { /* 云端旧版，退回客户端删 */ }
  if (!docId) return { data: [{ id: '', day: key }], error: null }
  return wrap(async () => {
    await db.collection('holidays').doc(docId).remove()
    return [{ id: docId, day: key }]
  })
}

/**
 * 删除早于某年的全部节假日（客户端兜底，用于清理已结束的旧年份）。
 * 节假日是公共表，不能加 openid 条件（早期记录 openid 各异，会漏删）；
 * 逐条删可能受「仅创建者可删」的安全规则限制，单条失败不影响其余。
 */
async function removeHolidaysBeforeYear(year) {
  const openid = myOpenid()
  if (!openid) return { data: [{ removed: 0 }], error: null }
  const minYear = String(year)
  return wrap(async () => {
    const res = await db.collection('holidays').limit(1000).get()
    const stale = (res.data || []).filter((r) => holidaysActive.isStale(r.day, minYear))
    let removed = 0
    for (let i = 0; i < stale.length; i++) {
      try {
        await db.collection('holidays').doc(stale[i]._id).remove()
        removed++
      } catch (e) { /* 无权限删他人写入的记录时跳过；显示层硬过滤已保证不可见 */ }
    }
    return [{ removed: removed }]
  })
}

/**
 * 自动清理已结束年份的节假日：一次启动只尝试一次，fire-and-forget 调用。
 * 优先走 dataapi 管理员批量删（可靠、能删他人写入的记录）；
 * 云函数未部署新版时退回客户端逐条删。两者失败都不影响显示层硬过滤的结果。
 */
let pruneTried = false
async function pruneOldHolidays() {
  if (pruneTried) return { removed: 0 }
  pruneTried = true
  try {
    const res = await callFunction('dataapi', {
      action: 'pruneHolidays',
      beforeYear: MIN_HOLIDAY_YEAR,
    })
    if (res && res.ok) {
      if (res.removed > 0) clearHolidayCache()
      return { removed: res.removed || 0 }
    }
  } catch (e) { /* 云端旧版 / 未部署，退回客户端兜底 */ }
  const fallback = await removeHolidaysBeforeYear(MIN_HOLIDAY_YEAR)
  const n = (fallback.data && fallback.data[0] && fallback.data[0].removed) || 0
  if (n > 0) clearHolidayCache()
  return { removed: n }
}

module.exports = {
  getSession,
  wechatLogin,
  ensureOpenid,
  signOut,
  listTodos,
  insertTodo,
  updateTodo,
  batchUpdateTodos,
  removeTodo,
  batchDeleteTodos,
  readHolidayCache,
  writeHolidayCache,
  clearHolidayCache,
  listLogs,
  listLogsAll,
  insertLogs,
  removeLog,
  listHolidays,
  seedHolidays,
  upsertHoliday,
  saveHoliday,
  removeHoliday,
  removeHolidaysBeforeYear,
  pruneOldHolidays,
  filterActiveHolidays: (rows) => holidaysActive.filterFrom(rows, MIN_HOLIDAY_YEAR),
  mergeActiveHolidays,
  readExcludedDays,
  excludeHolidayDay,
  restoreHolidayDay,
  clearExcludedDays,
  MIN_HOLIDAY_YEAR,
  SEED_HOLIDAYS,
}
