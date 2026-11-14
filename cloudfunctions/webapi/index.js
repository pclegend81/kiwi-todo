/**
 * KIWI待办 · 网页/桌面端 HTTP 接口云函数
 *
 * 供 Web/PWA（PC 浏览器、安卓/iOS 浏览器添加到主屏）通过 HTTP 访问服务调用，
 * 与微信小程序共用同一个云开发数据库，实现多端互相同步。
 *
 * 身份模型（两条路最终都汇聚到微信 openid，因此 pusher 一行都不用改）：
 *   A. 同步口令：小程序「我的」生成 8 位口令 + token 写入 web_bindings；
 *      网页端 bind 换 token，记录里直接带 openid，随即可读写 todos。
 *   B. 第三方登录：Google / Apple / GitHub / X / 微信网页应用 OAuth 回来后，
 *      以「平台 + 平台内唯一 ID」查 identities -> kiwi_uid（users 表）-> 签发 token。
 *      此时 openid 为空、会话处于 NEED_LINK 状态；用户填一次小程序里的 8 位口令
 *      （linkWechat）把 openid 合并进 kiwi_uid，之后与 A 完全等价。
 *      多个第三方账号合并到同一个微信时，会收敛到同一个 kiwi_uid、同一份 todos。
 *
 * 支持的 action（HTTP event 体 JSON 字段）：
 *   bind           —— { code }                    -> { ok, token, openid }
 *   unbind         —— { token }                   -> { ok }  作废绑定
 *   listTodos      —— { token }                   -> { ok, todos }
 *   insertTodo     —— { token, todo }             -> { ok, id }
 *   updateTodo     —— { token, id, patch }        -> { ok }
 *   removeTodo     —— { token, id }               -> { ok }
 *   stats          —— { token }                   -> { ok, counts }
 *   oauthProviders —— {}                          -> { ok, providers, all } 仅返回已启用平台
 *   oauthStart     —— { provider, redirectUri }   -> { ok, url, state, verifier }
 *   oauthCallback  —— { provider, code, state, verifier, redirectUri } -> { ok, token, linked }
 *   linkWechat     —— { token, code }             -> { ok, linked }  合并小程序 openid
 *   accountInfo    —— { token }                   -> { ok, linked, provider, identities }
 *
 * 安全：
 *   - token 为 64 位随机 hex，按 token 查库且校验 revoked / 过期；
 *   - OAuth 凭证只在云函数环境变量里，state 用 HMAC 签名绑定平台与回调地址（见 oauth.js）；
 *   - identities / users / web_bindings 必须设为「仅管理端可读写」，否则 token 可被冒用；
 *   - 写操作只接受白名单字段，杜绝网页端写入任意字段污染数据；
 *   - bind / linkWechat 失败 5 次后按口令锁定 10 分钟（内存级，重启清零，够防扫描）。
 */
const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

process.env.TZ = 'Asia/Shanghai'

const BUILD = '2026-11-13c'
const core = require('./reminder-core')
const oauth = require('./oauth')
const { HOLIDAYS_2027 } = require('./holidays-2027')

/** 网页端可写入的待办字段白名单（与小程序 edit.js 保存的字段一致） */
const TODO_FIELDS = [
  'title', 'note', 'images', 'location',
  'remind_at', 'repeat_type', 'repeat_interval', 'repeat_dates',
  'repeat_start', 'repeat_end',
  'skip_holiday', 'holiday_action', 'priority', 'manual_done',
  'status', 'done_at', 'next_remind_at', 'client_token',
  // 三个游标由服务端统一置「此刻」，不接受网页端传入（防止网页端把游标改坏导致补发）
]

/** 服务端新建时统一写入的游标：与 edit.js onSave 的 resetCursor 行为一致 */
function freshCursors() {
  const nowIso = new Date().toISOString()
  return {
    last_logged_at: nowIso,
    last_pushed_at: nowIso,
    last_reminded_at: nowIso, // 兼容部署过渡期仍读旧字段的旧云函数包
  }
}

const REPEAT_TYPES = ['none', 'daily', 'weekly', 'monthly', 'yearly', 'workday', 'restday', 'hourly', 'minutely', 'dates']
const PRIORITIES = ['high', 'medium', 'low']

/** 同步口令字符集：剔 0/O/1/I/L，与小程序邀请码同一套习惯 */
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const CODE_LEN = 8
/** 绑定有效期：30 天，网页端会自动续期 */
const BIND_TTL_MS = 30 * 86400000

/* ── bind 防扫描（内存级）────────────────────────────────────────────── */
const bindFails = Object.create(null) // code -> { n, until }
const MAX_FAILS = 5
const LOCK_MS = 10 * 60000

function bindLocked(code) {
  const rec = bindFails[code]
  return rec && rec.until > Date.now()
}
function noteBindFail(code) {
  const rec = bindFails[code] || { n: 0, until: 0 }
  rec.n += 1
  if (rec.n >= MAX_FAILS) {
    rec.n = 0
    rec.until = Date.now() + LOCK_MS
  }
  bindFails[code] = rec
}
function clearBindFails(code) {
  delete bindFails[code]
}

function randomHex(n) {
  return crypto.randomBytes(n).toString('hex')
}

function makeCode() {
  let s = ''
  for (let i = 0; i < CODE_LEN; i++) {
    s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]
  }
  return s
}

/** HTTP 集成响应包装 */
function httpJson(statusCode, obj) {
  return {
    statusCode: statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Kiwi-Token',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
    },
    body: JSON.stringify(obj),
  }
}

function fail(message, status) {
  return httpJson(status || 400, { ok: false, message: message || '请求不合法' })
}

/* ── 节假日映射：webapi 内置表兜底 + 云端表覆盖（与 pusher 同构）──────── */
let holidayMapCache = { map: null, at: 0 }
function holidayMap() {
  const now = Date.now()
  if (holidayMapCache.map && now - holidayMapCache.at < 600000) return holidayMapCache.map
  const map = {}
  for (let i = 0; i < HOLIDAYS_2027.length; i++) {
    map[HOLIDAYS_2027[i].day] = HOLIDAYS_2027[i].kind === 'workday' ? 'workday' : 'holiday'
  }
  holidayMapCache = { map: map, at: now }
  return map
}

/** 按绑定取身份：token -> { binding }，无效返回 null */
async function authByToken(token) {
  const t = String(token || '')
  if (!/^[0-9a-f]{32,128}$/.test(t)) return null
  try {
    const res = await db.collection('web_bindings')
      .where({ token: t, revoked: _.neq(true) })
      .limit(1)
      .get()
    const row = res.data && res.data[0]
    if (!row) return null
    // 过期校验（过期后网页端需重新输入口令绑定）
    if (row.expire_at && new Date(row.expire_at).getTime() < Date.now()) return null
    return row
  } catch (e) {
    return null
  }
}

/* ── 统一用户身份（第三方登录）────────────────────────────────────────── */

function needLinkResponse() {
  return httpJson(409, {
    ok: false,
    code: 'NEED_LINK',
    message: '当前账号尚未关联微信小程序，请输入小程序「我的 → 网页 / 电脑端同步」里的 8 位口令完成关联',
  })
}

/**
 * 把 web_bindings 记录解析成「可写 todos 的 openid」。
 *  - 老口令绑定：记录里本来就有 openid，原样放行（零改动）；
 *  - OAuth 绑定：openid 为空，按 kiwi_uid 从 users 表补出来并**回填到 row 对象**，
 *    这样下面所有 action 里既有的 row.openid 写法完全不用改，pusher 相关字段形状不变；
 *  - 仍未关联：返回 409 NEED_LINK，网页端弹出绑定口令输入框。
 * @returns {null|object} null 表示放行；否则是应直接返回的 HTTP 响应
 */
async function requireLink(row) {
  if (row.openid) return null
  const uid = String(row.kiwi_uid || '')
  if (!uid) return needLinkResponse()
  try {
    const res = await db.collection('users').where({ kiwi_uid: uid }).limit(1).get()
    const user = res.data && res.data[0]
    if (!user || !user.openid) return needLinkResponse()
    row.openid = user.openid
    return null
  } catch (e) {
    return needLinkResponse()
  }
}

/** 按「平台 + 平台内唯一 ID」找已有身份，没有就建 users + identities */
async function findOrCreateUser(who) {
  const provider = String(who.provider || '')
  const subject = String(who.subject || '')
  if (!provider || !subject) throw new Error('平台未返回用户标识')
  const hit = await db.collection('identities')
    .where({ provider: provider, subject: subject })
    .limit(1).get()
  const exist = hit.data && hit.data[0]
  if (exist && exist.kiwi_uid) {
    try {
      await db.collection('identities').doc(String(exist._id)).update({
        data: { last_login_at: new Date().toISOString() },
      })
    } catch (e) { /* 更新登录时间失败不影响登录 */ }
    return { kiwi_uid: String(exist.kiwi_uid), isNew: false }
  }
  const uid = crypto.randomBytes(16).toString('hex')
  const nowIso = new Date().toISOString()
  await db.collection('users').add({
    data: {
      kiwi_uid: uid,
      openid: '',
      primary_provider: provider,
      created_at: nowIso,
      updated_at: nowIso,
    },
  })
  await db.collection('identities').add({
    data: {
      provider: provider,
      subject: subject,
      kiwi_uid: uid,
      name: String(who.name || '').slice(0, 60),
      email: String(who.email || '').slice(0, 120),
      created_at: nowIso,
      last_login_at: nowIso,
    },
  })
  return { kiwi_uid: uid, isNew: true }
}

/** OAuth 登录成功后签发网页 token；openid 留空直到 linkWechat 完成关联 */
async function issueOAuthToken(uid, provider) {
  const token = randomHex(32)
  const now = new Date()
  await db.collection('web_bindings').add({
    data: {
      token: token,
      code: '',
      openid: '',
      kiwi_uid: uid,
      login: 'oauth',
      provider: provider,
      created_at: now.toISOString(),
      expire_at: new Date(now.getTime() + BIND_TTL_MS).toISOString(),
      last_used_at: null,
      revoked: false,
    },
  })
  return token
}

/**
 * 清洗待办字段：只保留白名单 + 基础类型校验。
 * 支持「部分字段 patch」——只归一带了值的字段，绝不凭空补默认值，
 * 否则更新一个 status 会把标题清空、把已完成待办重新激活。
 * @param {object} input 待写入的字段集合
 * @param {boolean} requireFull 新建时要求完整字段（title + 合法的 remind_at）
 */
function sanitizeTodo(input, requireFull) {
  const src = input && typeof input === 'object' ? input : {}
  const out = {}
  for (let i = 0; i < TODO_FIELDS.length; i++) {
    const k = TODO_FIELDS[i]
    if (src[k] === undefined) continue
    out[k] = src[k]
  }
  if (out.title !== undefined) out.title = String(out.title || '').slice(0, 60)
  if (out.note !== undefined) out.note = String(out.note || '').slice(0, 500)
  if (out.remind_at !== undefined) {
    out.remind_at = String(out.remind_at)
    if (isNaN(new Date(out.remind_at).getTime())) return null
  }
  if (out.repeat_type !== undefined && REPEAT_TYPES.indexOf(out.repeat_type) < 0) out.repeat_type = 'none'
  if (out.repeat_interval !== undefined) {
    out.repeat_interval = Math.max(1, Math.min(999, Number(out.repeat_interval) || 1))
  }
  if (out.repeat_dates !== undefined && !Array.isArray(out.repeat_dates)) out.repeat_dates = []
  if (out.repeat_start !== undefined) out.repeat_start = String(out.repeat_start || '').slice(0, 10)
  if (out.repeat_end !== undefined) out.repeat_end = String(out.repeat_end || '').slice(0, 10)
  if (out.skip_holiday !== undefined) out.skip_holiday = out.skip_holiday !== false
  if (out.holiday_action !== undefined) out.holiday_action = out.holiday_action === 'postpone' ? 'postpone' : 'skip'
  if (out.priority !== undefined && PRIORITIES.indexOf(out.priority) < 0) out.priority = 'medium'
  if (out.manual_done !== undefined) out.manual_done = out.manual_done === true
  if (out.status !== undefined) out.status = out.status === 'done' ? 'done' : 'active'
  if (requireFull) {
    if (!out.title) return null
    if (!out.remind_at) return null
    if (out.repeat_type === undefined) out.repeat_type = 'none'
    if (out.repeat_interval === undefined) out.repeat_interval = 1
    if (out.repeat_dates === undefined) out.repeat_dates = []
    if (out.skip_holiday === undefined) out.skip_holiday = true
    if (out.holiday_action === undefined) out.holiday_action = 'skip'
    if (out.priority === undefined) out.priority = 'medium'
    if (out.manual_done === undefined) out.manual_done = false
  }
  return out
}

/** 节假日表（云端覆盖内置）供网页端存 next_remind_at 时参算 */
async function loadHolidayMap() {
  const map = Object.assign({}, holidayMap())
  try {
    const res = await db.collection('holidays').limit(1000).get()
    const rows = res.data || []
    for (let i = 0; i < rows.length; i++) {
      const key = String(rows[i].day || '').slice(0, 10)
      if (key) map[key] = rows[i].kind === 'workday' ? 'workday' : 'holiday'
    }
  } catch (e) { /* 读失败用内置表兜底 */ }
  return map
}

/** 生成口令 + 创建绑定文档 */
async function createBinding(openid) {
  // 同一用户复用未过期的绑定（口令/token 不变，重复点「生成」不会作废旧网页端会话）
  const exist = await db.collection('web_bindings')
    .where({ openid: openid, revoked: _.neq(true), expire_at: _.gt(new Date().toISOString()) })
    .limit(1)
    .get()
  if (exist.data && exist.data[0]) {
    const row = exist.data[0]
    return { ok: true, code: row.code, token: row.token, reused: true }
  }
  const token = randomHex(32)
  const code = makeCode()
  const now = new Date()
  const doc = {
    openid: openid,
    code: code,
    token: token,
    created_at: now.toISOString(),
    expire_at: new Date(now.getTime() + BIND_TTL_MS).toISOString(),
    last_used_at: null,
    revoked: false,
  }
  await db.collection('web_bindings').add({ data: doc })
  return { ok: true, code: code, token: token, reused: false }
}

/* ── action 实现 ─────────────────────────────────────────────────────── */

async function actBind(event) {
  const code = String(event.code || '').trim().toUpperCase()
  if (!/^[2-9A-HJKMNP-Z]{8}$/.test(code)) return fail('口令格式不正确')
  if (bindLocked(code)) return fail('尝试次数过多，请 10 分钟后再试', 429)

  let row = null
  try {
    const res = await db.collection('web_bindings')
      .where({ code: code, revoked: _.neq(true) })
      .limit(1)
      .get()
    row = res.data && res.data[0]
  } catch (e) {
    return fail('查询失败：' + (e.errMsg || e.message), 500)
  }
  if (!row || (row.expire_at && new Date(row.expire_at).getTime() < Date.now())) {
    noteBindFail(code)
    return fail('口令无效或已过期，请到小程序「我的」页重新生成')
  }
  clearBindFails(code)
  // bind 成功即续期 30 天
  const newExpire = new Date(Date.now() + BIND_TTL_MS).toISOString()
  try {
    await db.collection('web_bindings').doc(String(row._id)).update({
      data: { last_used_at: new Date().toISOString(), expire_at: newExpire },
    })
  } catch (e) { /* 续期失败不影响本次登录 */ }
  return httpJson(200, { ok: true, token: row.token, openid: row.openid, expire_at: newExpire, build: BUILD })
}

async function actUnbind(event) {
  const row = await authByToken(event.token)
  if (!row) return fail('token 无效或已过期', 401)
  try {
    await db.collection('web_bindings').doc(String(row._id)).update({
      data: { revoked: true, revoked_at: new Date().toISOString() },
    })
  } catch (e) {
    return fail('作废失败：' + (e.errMsg || e.message), 500)
  }
  return httpJson(200, { ok: true })
}

async function actListTodos(event) {
  const row = await authByToken(event.token)
  if (!row) return fail('token 无效或已过期，请重新绑定', 401)
  const blocked = await requireLink(row)
  if (blocked) return blocked
  let todos = []
  try {
    const res = await db.collection('todos')
      .where({ openid: row.openid })
      .orderBy('remind_at', 'asc')
      .limit(200)
      .get()
    todos = (res.data || []).map((r) => Object.assign({}, r, { id: String(r._id) }))
  } catch (e) {
    return fail('读取失败：' + (e.errMsg || e.message), 500)
  }
  return httpJson(200, { ok: true, todos: todos, build: BUILD })
}

async function actInsertTodo(event) {
  const row = await authByToken(event.token)
  if (!row) return fail('token 无效或已过期，请重新绑定', 401)
  const blocked = await requireLink(row)
  if (blocked) return blocked
  const todo = sanitizeTodo(event.todo, true)
  if (!todo) return fail('标题或提醒时间不合法')
  const nowIso = new Date().toISOString()
  const doc = Object.assign({}, todo, freshCursors(), {
    openid: row.openid,
    status: 'active', // 新建一律 active，不信任网页端传的 status
    client_token: String(event.todo && event.todo.client_token || randomHex(16)),
    created_at: nowIso,
    created_from: 'web',
  })
  // 幂等：同一 client_token 重复提交（网络重试/连点）直接返回已存在的那条
  try {
    const hit = await db.collection('todos')
      .where({ openid: row.openid, client_token: doc.client_token })
      .limit(1).get()
    if (hit.data && hit.data[0]) {
      return httpJson(200, { ok: true, id: String(hit.data[0]._id), duplicated: true, build: BUILD })
    }
  } catch (e) { /* 判重读失败不阻断写入 */ }
  // next_remind_at 给小程序首页展示用；pusher 实际是扫 remind_at 自行枚举，
  // 所以这里算不出也不影响真实提醒。
  try {
    const next = core.nextOccurrence(doc, Date.now(), await loadHolidayMap())
    doc.next_remind_at = next ? new Date(next.at).toISOString() : null
  } catch (e) {
    doc.next_remind_at = null
  }
  let id = ''
  try {
    const res = await db.collection('todos').add({ data: doc })
    id = String(res._id)
  } catch (e) {
    return fail('保存失败：' + (e.errMsg || e.message), 500)
  }
  return httpJson(200, { ok: true, id: id, build: BUILD })
}

async function actUpdateTodo(event) {
  const row = await authByToken(event.token)
  if (!row) return fail('token 无效或已过期，请重新绑定', 401)
  const blocked = await requireLink(row)
  if (blocked) return blocked
  const id = String(event.id || '')
  if (!/^[0-9a-zA-Z_-]{1,64}$/.test(id)) return fail('id 不合法')
  const patch = sanitizeTodo(event.patch, false)
  if (!patch) return fail('提醒时间不合法')
  if (Object.keys(patch).length === 0) return fail('没有需要更新的字段')

  let original = null
  try {
    // 先校验归属，防止越权改他人待办；同时取回原记录用于 merge 重算
    const own = await db.collection('todos').where({ _id: id, openid: row.openid }).limit(1).get()
    original = own.data && own.data[0]
  } catch (e) {
    return fail('查询失败：' + (e.errMsg || e.message), 500)
  }
  if (!original) return fail('待办不存在或不属于你', 404)

  patch.updated_at = new Date().toISOString()
  patch.updated_from = 'web'

  // 改了首次提醒时间必须重置三游标：否则新时间早于上次提醒时会被当成「已提醒」永不响，
  // 置空更糟（会从 remind_at 一路枚举补发历史消息）。与 edit.js onSave 的 resetCursor 一致。
  const timeChanged = patch.remind_at !== undefined && patch.remind_at !== original.remind_at
  if (timeChanged) Object.assign(patch, freshCursors())

  // 只有调度相关字段变了才重算下次提醒；单纯「标记完成」不动它。
  const SCHEDULE_KEYS = [
    'remind_at', 'repeat_type', 'repeat_interval', 'repeat_dates',
    'repeat_start', 'repeat_end', 'skip_holiday', 'holiday_action',
  ]
  const scheduleChanged = SCHEDULE_KEYS.some((k) => patch[k] !== undefined)
  if (scheduleChanged) {
    const merged = Object.assign({}, original, patch)
    try {
      const next = core.nextOccurrence(merged, Date.now(), await loadHolidayMap())
      patch.next_remind_at = next ? new Date(next.at).toISOString() : null
    } catch (e) {
      patch.next_remind_at = null
    }
  }

  try {
    await db.collection('todos').doc(id).update({ data: patch })
  } catch (e) {
    return fail('更新失败：' + (e.errMsg || e.message), 500)
  }
  return httpJson(200, { ok: true, build: BUILD })
}

async function actRemoveTodo(event) {
  const row = await authByToken(event.token)
  if (!row) return fail('token 无效或已过期，请重新绑定', 401)
  const blocked = await requireLink(row)
  if (blocked) return blocked
  const id = String(event.id || '')
  if (!/^[0-9a-zA-Z_-]{1,64}$/.test(id)) return fail('id 不合法')
  try {
    const own = await db.collection('todos').where({ _id: id, openid: row.openid }).limit(1).get()
    if (!(own.data && own.data[0])) return fail('待办不存在或不属于你', 404)
    await db.collection('todos').doc(id).remove()
  } catch (e) {
    return fail('删除失败：' + (e.errMsg || e.message), 500)
  }
  return httpJson(200, { ok: true, build: BUILD })
}

async function actStats(event) {
  const row = await authByToken(event.token)
  if (!row) return fail('token 无效或已过期，请重新绑定', 401)
  const blocked = await requireLink(row)
  if (blocked) return blocked
  try {
    const total = await db.collection('todos').where({ openid: row.openid }).count()
    const active = await db.collection('todos').where({ openid: row.openid, status: 'active' }).count()
    return httpJson(200, {
      ok: true,
      counts: { total: total.total || 0, active: active.total || 0 },
      build: BUILD,
    })
  } catch (e) {
    return fail('统计失败：' + (e.errMsg || e.message), 500)
  }
}

/* ── 第三方账号登录 action ────────────────────────────────────────────── */

/** 网页端据此渲染按钮：providers 只含已配好凭证的平台，不留假按钮；all 供「接入状态」清单展示 */
async function actOauthProviders() {
  const all = oauth.listProviders()
  const enabled = all.filter(function (p) { return p.enabled })
    .map(function (p) { return { id: p.id, name: p.name, pkce: p.pkce, regions: p.regions || [] } })
  return httpJson(200, { ok: true, providers: enabled, all: all, build: BUILD })
}

async function actOauthStart(event) {
  try {
    const r = oauth.start(event.provider, event.redirectUri)
    return httpJson(200, {
      ok: true, url: r.url, state: r.state,
      verifier: r.verifier, provider: r.provider, build: BUILD,
    })
  } catch (e) {
    return fail(e.message || '发起登录失败')
  }
}

async function actOauthCallback(event) {
  let who = null
  try {
    who = await oauth.callback(event)
  } catch (e) {
    return fail('登录失败：' + (e.message || '平台校验未通过'))
  }
  let user = null
  try {
    user = await findOrCreateUser(who)
  } catch (e) {
    return fail('账号建立失败：' + (e.errMsg || e.message), 500)
  }
  let token = ''
  try {
    token = await issueOAuthToken(user.kiwi_uid, who.provider)
  } catch (e) {
    return fail('签发会话失败：' + (e.errMsg || e.message), 500)
  }
  // 同一个 kiwi_uid 在别的设备上已经关联过微信时，本次登录直接可用
  let linked = false
  try {
    const res = await db.collection('users')
      .where({ kiwi_uid: user.kiwi_uid }).limit(1).get()
    linked = !!(res.data && res.data[0] && res.data[0].openid)
  } catch (e) { /* 查不到按未关联处理 */ }
  return httpJson(200, {
    ok: true,
    token: token,
    provider: who.provider,
    name: who.name || '',
    linked: linked,
    needsLink: !linked,
    kiwi_uid: user.kiwi_uid,
    build: BUILD,
  })
}

/** 当前会话的账号状态（网页端用来决定要不要显示「关联小程序」引导条） */
async function actAccountInfo(event) {
  const row = await authByToken(event.token)
  if (!row) return fail('登录已失效，请重新登录', 401)
  const uid = String(row.kiwi_uid || '')
  let linked = !!row.openid
  const identities = []
  if (uid) {
    try {
      const res = await db.collection('identities').where({ kiwi_uid: uid }).limit(20).get()
      for (let i = 0; i < (res.data || []).length; i++) {
        identities.push({ provider: res.data[i].provider, name: res.data[i].name || '' })
      }
    } catch (e) { /* 展示用，失败不阻断 */ }
    if (!linked) {
      try {
        const u = await db.collection('users').where({ kiwi_uid: uid }).limit(1).get()
        linked = !!(u.data && u.data[0] && u.data[0].openid)
      } catch (e) { /* 同上 */ }
    }
  }
  return httpJson(200, {
    ok: true,
    linked: linked,
    needsLink: !linked,
    provider: row.provider || 'code',
    identities: identities,
    build: BUILD,
  })
}

/**
 * 用小程序生成的 8 位同步口令，把 openid 合并进当前第三方账号。
 * 只读小程序那条 binding，不作废它 —— 不影响小程序端展示与其它网页设备。
 * 若这个微信已属于另一个 kiwi_uid，则把当前第三方身份收敛过去（多账号 = 同一份数据）。
 */
async function actLinkWechat(event) {
  const row = await authByToken(event.token)
  if (!row) return fail('登录已失效，请重新登录', 401)
  if (row.openid) return httpJson(200, { ok: true, linked: true, already: true, build: BUILD })

  const code = String(event.code || '').trim().toUpperCase()
  if (!/^[2-9A-HJKMNP-Z]{8}$/.test(code)) return fail('口令格式不正确')
  if (bindLocked(code)) return fail('尝试次数过多，请 10 分钟后再试', 429)

  let src = null
  try {
    const res = await db.collection('web_bindings')
      .where({ code: code, revoked: _.neq(true) })
      .limit(1).get()
    src = res.data && res.data[0]
  } catch (e) {
    return fail('查询失败：' + (e.errMsg || e.message), 500)
  }
  if (!src || (src.expire_at && new Date(src.expire_at).getTime() < Date.now())) {
    noteBindFail(code)
    return fail('口令无效或已过期，请到小程序重新生成')
  }
  if (!src.openid) {
    noteBindFail(code)
    return fail('该口令不是小程序生成的同步口令')
  }
  clearBindFails(code)

  const openid = String(src.openid)
  let targetUid = String(row.kiwi_uid || '')
  if (!targetUid) return fail('当前登录会话缺少用户标识，请重新登录', 401)
  const nowIso = new Date().toISOString()

  try {
    const hit = await db.collection('identities')
      .where({ provider: 'wechat_miniprogram', subject: openid })
      .limit(1).get()
    const exist = hit.data && hit.data[0]

    if (exist && exist.kiwi_uid && exist.kiwi_uid !== targetUid) {
      // 账号合并：把当前 uid 下的第三方身份改指向已有的 uid，旧 users 只做标记不删除
      const oldUid = targetUid
      targetUid = String(exist.kiwi_uid)
      const ids = await db.collection('identities').where({ kiwi_uid: oldUid }).get()
      for (let i = 0; i < (ids.data || []).length; i++) {
        await db.collection('identities').doc(String(ids.data[i]._id)).update({
          data: { kiwi_uid: targetUid, merged_at: nowIso },
        })
      }
      const oldUsers = await db.collection('users').where({ kiwi_uid: oldUid }).get()
      for (let i = 0; i < (oldUsers.data || []).length; i++) {
        await db.collection('users').doc(String(oldUsers.data[i]._id)).update({
          data: { merged_into: targetUid, merged_at: nowIso },
        })
      }
      await db.collection('web_bindings').doc(String(row._id)).update({
        data: { kiwi_uid: targetUid },
      })
    } else if (!exist) {
      await db.collection('identities').add({
        data: {
          provider: 'wechat_miniprogram',
          subject: openid,
          kiwi_uid: targetUid,
          created_at: nowIso,
          last_login_at: nowIso,
        },
      })
    }

    const users = await db.collection('users').where({ kiwi_uid: targetUid }).get()
    for (let i = 0; i < (users.data || []).length; i++) {
      await db.collection('users').doc(String(users.data[i]._id)).update({
        data: { openid: openid, linked_at: nowIso, updated_at: nowIso },
      })
    }
    // 回填后 requireLink 会直接放行，后续 CRUD 全部写真实的 openid
    await db.collection('web_bindings').doc(String(row._id)).update({
      data: { openid: openid },
    })
  } catch (e) {
    return fail('关联失败：' + (e.errMsg || e.message), 500)
  }
  return httpJson(200, { ok: true, linked: true, openid: openid, build: BUILD })
}

/** 生成口令：小程序端通过 wx.cloud.callFunction 调用（走微信身份，无需 HTTP） */
async function actCreateBinding(event) {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID || wxContext.FROM_OPENID
  if (!openid) return { ok: false, message: '无法识别用户身份' }
  try {
    return await createBinding(openid)
  } catch (e) {
    return { ok: false, message: e.errMsg || e.message || '生成失败' }
  }
}

/** 小程序查询当前口令（用于「我的」页展示，避免重复生成覆盖旧口令的困惑） */
async function actGetBinding() {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID || wxContext.FROM_OPENID
  if (!openid) return { ok: false, message: '无法识别用户身份' }
  try {
    const res = await db.collection('web_bindings')
      .where({ openid: openid, revoked: _.neq(true), expire_at: _.gt(new Date().toISOString()) })
      .limit(1)
      .get()
    const row = res.data && res.data[0]
    if (!row) return { ok: true, binding: null }
    return { ok: true, binding: { code: row.code, expire_at: row.expire_at, created_at: row.created_at } }
  } catch (e) {
    return { ok: false, message: e.errMsg || e.message || '查询失败' }
  }
}

/** 小程序作废口令 */
async function actRevokeBinding() {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID || wxContext.FROM_OPENID
  if (!openid) return { ok: false, message: '无法识别用户身份' }
  try {
    const res = await db.collection('web_bindings')
      .where({ openid: openid, revoked: _.neq(true) })
      .remove()
    const removed = (res && res.stats && res.stats.removed) || 0
    return { ok: true, removed: removed }
  } catch (e) {
    return { ok: false, message: e.errMsg || e.message || '作废失败' }
  }
}

exports.main = async (event) => {
  // HTTP 访问服务（集成响应）：event 里是解析后的 body；OPTIONS 预检直接放行
  if (event.httpMethod === 'OPTIONS') {
    return httpJson(204, {})
  }
  const action = String((event && event.action) || '')

  // 小程序端 callFunction 走的 action（用微信 openid 鉴权，不经过 HTTP）
  if (action === 'createBinding') return actCreateBinding(event)
  if (action === 'getBinding') return actGetBinding(event)
  if (action === 'revokeBinding') return actRevokeBinding(event)

  // HTTP 端 action
  if (action === 'bind') return actBind(event)
  if (action === 'unbind') return actUnbind(event)
  if (action === 'listTodos') return actListTodos(event)
  if (action === 'insertTodo') return actInsertTodo(event)
  if (action === 'updateTodo') return actUpdateTodo(event)
  if (action === 'removeTodo') return actRemoveTodo(event)
  if (action === 'stats') return actStats(event)

  // 第三方账号登录（凭证未配置的平台在 oauthProviders 里自动隐藏）
  if (action === 'oauthProviders') return actOauthProviders(event)
  if (action === 'oauthStart') return actOauthStart(event)
  if (action === 'oauthCallback') return actOauthCallback(event)
  if (action === 'linkWechat') return actLinkWechat(event)
  if (action === 'accountInfo') return actAccountInfo(event)

  return fail('未知操作：' + action + '｜webapi 版本 ' + BUILD)
}
