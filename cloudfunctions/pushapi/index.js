/**
 * KIWI待办 · 推送云函数（设备端接口）
 *
 * 小程序通过 wx.cloud.callFunction 调用，不走 request 域名校验。
 * openid 由云环境自动注入（getWXContext），无需 code 换取，也无需 AppSecret。
 *
 * 支持的 action：
 *   session   —— 登录：返回调用者 openid
 *   bind      —— 登记本机（openid）为推送设备
 *   status    —— 查询绑定状态与内置模板 ID
 *   subscribe —— 记录订阅授权成功（不再限制次数，所有用户不限量推送）
 *   test      —— 给本机发一条测试订阅消息
 *
 *   share.create     —— 为某条待办创建邀请（幂等，返回 inviteId + 6 位邀请码）
 *   share.detail     —— 读取邀请快照 + 成员数 + 自己是否已加入
 *   share.join       —— 接受邀请：在自己名下建一条待办副本并登记为成员
 *   share.joinByCode —— 用 6 位邀请码加入（不必依赖转发卡片）
 *   share.leave      —— 退出协作：删除自己名下的副本并标记 left
 *   share.sync       —— 创建者保存待办后，把最新内容推给所有成员
 *   share.members    —— 列出某邀请的成员列表（含成员自填称呼）
 *
 * 关于「选择微信好友」：微信没有开放好友列表接口，小程序里画不出好友选择器，
 * 只能由用户在微信自己的转发面板里选人。邀请码是兜底路径——不想转发、
 * 或要加另一个人时，把码发给对方、对方在小程序里输入即可。
 *
 * 为什么协作必须走云函数：todos 集合的安全规则是 auth.openid == doc.openid，
 * 客户端读不到别人的待办、也写不进别人的名下。云函数用 admin 权限操作数据库，
 * 不受这条规则限制，所以邀请/加入/同步都放在这里做。
 */
// 云函数运行环境默认 UTC：测试消息里的「开始时间」曾显示成 03:13（实际 11:13）。
// 必须在任何 Date 运算之前把运行环境的本地时区设成北京时间，
// 否则 reminder-core 的日期运算和订阅消息的时间字段都会偏 8 小时。
process.env.TZ = 'Asia/Shanghai'
const cloud = require('wx-server-sdk')
const core = require('./reminder-core')
// 节假日数据由小程序端登录后回灌 holidays 集合，云端按需读取；内置静态表只放在 pusher。

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// ───────────────────────── 推送配置（改完重新部署本函数生效） ─────────────────────────

// 订阅消息模板 ID（保留单值，兼容旧客户端与结构校验）
const TEMPLATE_ID = '80ZMLz3QxJ_KlrrK6uU_GqHNOlmL5xvr6247IO5PmEA'

/**
 * 多模板并行：一次授权同时给列表里每个模板各补 1 条额度。
 * 必须与 cloudfunctions/pusher/index.js 的 TEMPLATE_IDS、utils/config.js 的
 * FALLBACK_TEMPLATE_IDS 保持同一批 ID。默认只放 1 个 = 行为不变。
 * 微信上限 5 个，且模板标题不能相同（相同只保留一个）。
 */
const TEMPLATE_IDS = [
  TEMPLATE_ID,
  // '第 2 个模板 ID',
]

// 构建标记：用来一眼判断「云端跑的是不是最新的这份代码」。
// 出现过两次「未知操作：share.joinByCode」的误判，都是云函数没重新部署导致的。
// 报错信息里带上它：看不到版本号 = 云端还是旧包；看得到 = 云端是新的（那就是真 bug）。
const BUILD = '2026-11-13a'

// 模板关键词技术名（来源：公众平台「我的模板 → 详情」）：
//   日程时间 {{date4.DATA}} / 日程标题 {{thing5.DATA}} / 开始时间 {{time6.DATA}} / 备注 {{thing11.DATA}}
// 注意：date 类型只接受纯日期（yyyy-MM-dd），时间放在 time6
const TEMPLATE_FIELDS = [
  { key: 'date4', source: 'date' },
  { key: 'thing5', source: 'title' },
  { key: 'time6', source: 'time' },
  { key: 'thing11', source: 'note' },
]

// 下发状态：developer=开发调试 / trial=体验版 / formal=正式版。
// 当前处于「上传审批 / 体验版测试」阶段，没有正式发布版，必须用 trial，
// 否则体验版/开发版用户收不到订阅消息。
// ⚠️ 审核通过并正式发布后，务必改回 'formal'，否则全量用户收不到。
const MINIPROGRAM_STATE = 'trial'

async function ensureCollection(name) {
  try {
    await db.createCollection(name)
  } catch (e) {
    // 已存在时忽略
  }
}

/** 确保集合存在即可；数据由小程序端在登录后自行回灌（客户端写入才会自动带上 _openid） */
async function ensureHolidays() {
  await ensureCollection('holidays')
}

function buildMessageData(todo, atMs) {
  // 显式按 UTC+8 取时间，不依赖云函数的 TZ 设置是否生效
  const bj = core.beijingKey(atMs)
  const values = {
    // 标题带上优先级前缀，微信通知里一眼能看出轻重（模板限制 20 字）
    title: ('【' + core.priorityText(todo.priority) + '】' + String(todo.title || 'KIWI待办')).slice(0, 20),
    note: String(todo.note || '你有一条待办需要处理').slice(0, 20),
    time: bj.time,
    date: bj.date,
    datetime: bj.datetime,
    repeat: core.describeRepeat(todo),
  }
  const out = {}
  const fields = Array.isArray(TEMPLATE_FIELDS) ? TEMPLATE_FIELDS : []
  fields.forEach((field) => {
    if (!field || !field.key) return
    const raw = values[field.source] !== undefined ? values[field.source] : ''
    out[field.key] = { value: String(raw) }
  })
  return out
}

async function sendSubscribeMessage(openid, templateId, messageData) {
  return cloud.openapi.subscribeMessage.send({
    touser: openid,
    templateId: templateId,
    page: 'pages/index/index',
    miniprogramState: MINIPROGRAM_STATE,
    lang: 'zh_CN',
    data: messageData,
  })
}

/* ───────────────────────── 协作邀请（多人同时提醒）─────────────────────────
 *
 * 数据模型：
 *   invites        { openid(创建者), todo_id, todo(快照), status:'open'|'closed' }
 *   invite_members { invite_id, openid, todo_id(成员名下副本 id), status:'joined'|'left' }
 *
 * 提醒下发不需要额外逻辑：每个成员自己名下都有一条独立的 todo 副本，
 * 定时扫描的 pusher 会各自命中，因此天然是「多人同时收到提醒」。
 */

/** 邀请里需要跟着同步的字段（其余字段各自独立，不跨用户同步） */
const SHARE_FIELDS = [
  'title',
  'note',
  'images',
  'location',
  'remind_at',
  'repeat_type',
  'repeat_interval',
  'repeat_dates',
  'repeat_start',
  'repeat_end',
  'skip_holiday',
  'holiday_action',
  'priority',
  'manual_done',
]

function pickTodo(doc) {
  const out = {}
  const src = doc || {}
  SHARE_FIELDS.forEach((k) => {
    if (src[k] !== undefined) out[k] = src[k]
  })
  return out
}

function nowIso() {
  return new Date().toISOString()
}

async function findInvite(inviteId) {
  if (!inviteId) return null
  try {
    const res = await db.collection('invites').doc(String(inviteId)).get()
    return res && res.data ? res.data : null
  } catch (e) {
    return null
  }
}

async function memberDoc(inviteId, openid) {
  try {
    const res = await db
      .collection('invite_members')
      .where({ invite_id: inviteId, openid: openid })
      .limit(1)
      .get()
    return res.data && res.data.length ? res.data[0] : null
  } catch (e) {
    return null
  }
}

/**
 * 生成 6 位邀请码。
 * 去掉 0/O/1/I/L 这些易看错的字符，方便口头报码和手抄。
 */
function randomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 6; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return out
}

/** 生成一个当前未被占用的邀请码（撞码概率极低，最多重试 5 次） */
async function newInviteCode() {
  for (let i = 0; i < 5; i++) {
    const code = randomCode()
    try {
      const res = await db
        .collection('invites')
        .where({ code: code, status: 'open' })
        .limit(1)
        .get()
      if (!res.data || res.data.length === 0) return code
    } catch (e) {
      return code
    }
  }
  return randomCode()
}

/** 按邀请码找有效邀请 */
async function findInviteByCode(code) {
  const key = String(code || '').trim().toUpperCase()
  if (!key) return null
  try {
    const res = await db
      .collection('invites')
      .where({ code: key, status: 'open' })
      .limit(1)
      .get()
    return res.data && res.data.length ? res.data[0] : null
  } catch (e) {
    return null
  }
}

/** 成员名下的副本内容：快照 + 协作元信息 */
function memberTodoOf(invite, snapshot) {
  const todo = Object.assign({}, snapshot)
  todo.shared = true
  todo.owner_openid = invite.openid
  todo.invite_id = invite._id
  todo.status = 'active'
  return todo
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  // 客户端直接调用时身份在 OPENID；云函数互调场景是 FROM_OPENID，两者兜底
  const openid = wxContext.OPENID || wxContext.FROM_OPENID
  if (!openid) {
    // 云端测试面板没有用户身份，会在这一步就返回——顺手带上版本标记，
    // 让控制台「云端测试」也能自检部署新旧（真实用户调用永远带 OPENID，看不到这句）。
    return {
      ok: false,
      message: '无法识别用户身份（云端测试无用户身份，返回这句属正常）｜pushapi 版本 ' + BUILD,
    }
  }

  const action = String(event.action || '')
  const templateId = String(event.templateId || TEMPLATE_ID || '')

  try {
    if (action === 'session') {
      // 登录：返回调用者 openid，客户端存本地作为身份；顺带确保集合已创建
      await ensureCollection('todos')
      await ensureCollection('remind_logs')
      await ensureHolidays()
      return { ok: true, openid: openid }
    }

    if (action === 'bind') {
      await ensureCollection('push_devices')
      await ensureHolidays()
      const found = await db.collection('push_devices').where({ openid: openid }).count()
      if (found.total === 0) {
        await db.collection('push_devices').add({ data: { openid: openid, createdAt: Date.now() } })
      }
      return { ok: true, bound: true }
    }

    if (action === 'status') {
      await ensureCollection('push_devices')
      await ensureHolidays()
      let rows = []
      try {
        rows = (await db.collection('push_devices').where({ openid: openid }).limit(1).get()).data || []
      } catch (e) { /* 集合刚建好时可能读不到，按未绑定处理 */ }
      const dev = rows[0] || {}
      // 模板 ID 内置在云函数里，客户端不再需要任何配置。
      // pushHealth 由 pusher 写入：额度用尽 / 其他失败时把原因回传，
      // 让用户知道「为什么长时间没收到微信提醒」，而不是只看到静默失联。
      return {
        ok: true,
        bound: rows.length > 0,
        templateId: templateId,
        // 多模板并行：客户端一次授权会同时给这些模板各补 1 条额度
        templateIds: TEMPLATE_IDS,
        pushHealth: {
          error: String(dev.last_push_error || ''),
          errorAt: Number(dev.last_push_error_at || 0),
          okAt: Number(dev.last_push_ok_at || 0),
        },
      }
    }

    if (action === 'subscribe') {
      await ensureCollection('push_devices')
      if (!templateId) return { ok: false, message: '缺少模板 ID' }
      // 确保设备存在（用户可能没点过绑定就直接授权）
      const found = await db.collection('push_devices').where({ openid: openid }).count()
      if (found.total === 0) {
        await db.collection('push_devices').add({ data: { openid: openid, createdAt: Date.now() } })
      }
      // 不再维护 per-user 订阅额度，所有用户均可不限量接收推送
      return { ok: true }
    }

    if (action === 'test') {
      if (!templateId) return { ok: false, message: '缺少模板 ID' }
      const fake = {
        title: '测试提醒',
        note: '推送服务已连通',
        repeat_type: 'none',
        repeat_interval: 1,
      }
      // 测试也是一次真实下发，同步更新健康状态：成功即视为额度已恢复
      async function markTestHealth(ok, code) {
        try {
          await db.collection('push_devices').where({ openid: openid }).update({
            data: ok
              ? { last_push_ok_at: Date.now(), last_push_error: '' }
              : { last_push_error: Number(code) === 43101 ? 'quota' : 'error', last_push_error_at: Date.now() },
          })
        } catch (e) { /* 辅助状态，失败不影响测试结果 */ }
      }
      try {
        await sendSubscribeMessage(openid, templateId, buildMessageData(fake, Date.now()))
        await markTestHealth(true)
        return { ok: true }
      } catch (e) {
        const code = e.errCode || e.resultErrCode
        const msg = e.errMsg || e.message
        if (Number(code) === 43101) {
          await markTestHealth(false, code)
          return { ok: false, message: '提醒次数已用完。请点「补充提醒次数」后再试；长期不打开小程序不会产生新的授权，微信提醒会停。' }
        }
        // 带上实际发送内容，便于定位字段格式问题（真机 vConsole 可看全文）
        console.error('[pushapi][test] 下发失败：', msg, JSON.stringify(buildMessageData(fake, Date.now())))
        return { ok: false, message: '发送失败：' + msg + ' | data=' + JSON.stringify(buildMessageData(fake, Date.now())) }
      }
    }

    /* ── 协作邀请 ─────────────────────────────────────────────────────── */

    if (action === 'share.create') {
      await ensureCollection('invites')
      await ensureCollection('invite_members')
      const todoId = String(event.todo_id || '')
      if (!todoId) return { ok: false, message: '缺少待办 ID' }
      // 归属校验：只能为自己创建的待办发起邀请
      let mine = null
      try {
        const res = await db.collection('todos').doc(todoId).get()
        mine = res && res.data ? res.data : null
      } catch (e) {
        mine = null
      }
      if (!mine || mine.openid !== openid) {
        return { ok: false, message: '只能为自己创建的待办发起邀请' }
      }
      const snapshot = pickTodo(event.todo && Object.keys(event.todo).length ? event.todo : mine)
      // 幂等：同一条待办只保留一个有效邀请，重复调用只刷新快照
      let found = null
      try {
        const exist = await db
          .collection('invites')
          .where({ openid: openid, todo_id: todoId, status: 'open' })
          .limit(1)
          .get()
        found = exist.data && exist.data.length ? exist.data[0] : null
      } catch (e) {
        found = null
      }
      if (found) {
        // 幂等复用时补齐邀请码（老数据可能没有）
        const patch = { todo: snapshot, updated_at: nowIso() }
        if (!found.code) patch.code = await newInviteCode()
        await db.collection('invites').doc(found._id).update({ data: patch })
        return { ok: true, inviteId: found._id, code: found.code || patch.code, build: BUILD }
      }
      const res = await db.collection('invites').add({
        data: {
          openid: openid,
          todo_id: todoId,
          todo: snapshot,
          status: 'open',
          code: await newInviteCode(),
          created_at: nowIso(),
        },
      })
      const saved = await findInvite(res._id)
      return { ok: true, inviteId: res._id, code: saved ? saved.code : '', build: BUILD }
    }

    if (action === 'share.detail') {
      const inviteId = String(event.invite_id || '')
      const invite = await findInvite(inviteId)
      if (!invite || invite.status !== 'open') {
        return { ok: false, message: '邀请不存在或已关闭' }
      }
      const mine = await memberDoc(inviteId, openid)
      const cnt = await db
        .collection('invite_members')
        .where({ invite_id: inviteId, status: 'joined' })
        .count()
        .catch(() => ({ total: 0 }))
      return {
        ok: true,
        todo: invite.todo || {},
        memberCount: (cnt && cnt.total) || 0,
        joined: !!(mine && mine.status === 'joined'),
        isOwner: invite.openid === openid,
        // 邀请码只对创建者返回，避免拿到码的人反过来改邀请
        code: invite.openid === openid ? String(invite.code || '') : '',
        myNickname: mine && mine.nickname ? String(mine.nickname) : '',
      }
    }

    if (action === 'share.join' || action === 'share.joinByCode') {
      await ensureCollection('invites')
      await ensureCollection('invite_members')
      // 两条入口共用后续逻辑：卡片转发带 invite_id，手输码带 code
      let invite = null
      if (action === 'share.joinByCode') {
        invite = await findInviteByCode(event.code)
        if (!invite) return { ok: false, message: '邀请码无效或已失效' }
      } else {
        invite = await findInvite(String(event.invite_id || ''))
        if (!invite || invite.status !== 'open') {
          return { ok: false, message: '邀请不存在或已关闭' }
        }
      }
      if (invite.openid === openid) {
        return { ok: false, message: '这是你自己创建的待办' }
      }
      const inviteId = String(invite._id)
      const nickname = String(event.nickname || '').trim().slice(0, 12)
      const mine = await memberDoc(inviteId, openid)
      if (mine && mine.status === 'joined') {
        // 已加入：只当是补填称呼，不重复建副本
        if (nickname) {
          await db
            .collection('invite_members')
            .doc(mine._id)
            .update({ data: { nickname: nickname } })
        }
        return { ok: true, todoId: mine.todo_id || '', already: true }
      }
      const snapshot = invite.todo || {}
      const todo = memberTodoOf(invite, snapshot)
      todo.next_remind_at = snapshot.remind_at || null
      // 三个游标都记成「此刻」而不是 null：原件的 remind_at 往往在过去，
      // 若置空，定时扫描与小程序补记会把历史上所有到期项一次性补发给新成员。
      todo.last_logged_at = nowIso()
      todo.last_pushed_at = nowIso()
      todo.last_reminded_at = nowIso()
      const added = await db.collection('todos').add({
        data: Object.assign({}, todo, { openid: openid, created_at: nowIso() }),
      })
      if (mine) {
        // 曾退出后重新加入
        await db.collection('invite_members').doc(mine._id).update({
          data: { status: 'joined', todo_id: added._id, joined_at: nowIso(), nickname: nickname },
        })
      } else {
        await db.collection('invite_members').add({
          data: {
            invite_id: inviteId,
            openid: openid,
            todo_id: added._id,
            nickname: nickname,
            joined_at: nowIso(),
            status: 'joined',
          },
        })
      }
      return { ok: true, todoId: added._id, inviteId: inviteId, title: String(snapshot.title || '') }
    }

    if (action === 'share.leave') {
      const inviteId = String(event.invite_id || '')
      const mine = await memberDoc(inviteId, openid)
      if (!mine || mine.status !== 'joined') {
        return { ok: false, message: '你不在这条协作提醒里' }
      }
      if (mine.todo_id) {
        await db
          .collection('todos')
          .doc(String(mine.todo_id))
          .remove()
          .catch(() => {})
      }
      await db
        .collection('invite_members')
        .doc(mine._id)
        .update({ data: { status: 'left', left_at: nowIso() } })
      return { ok: true }
    }

    if (action === 'share.sync') {
      const inviteId = String(event.invite_id || '')
      const invite = await findInvite(inviteId)
      if (!invite) return { ok: false, message: '邀请不存在' }
      if (invite.openid !== openid) {
        return { ok: false, message: '只有创建者可以同步' }
      }
      const snapshot = pickTodo(event.todo)
      // 提醒时间变了：成员的提醒游标必须重置，否则新时间早于游标就会被当成「已提醒」跳过
      const timeChanged = String((invite.todo || {}).remind_at || '') !== String(snapshot.remind_at || '')
      await db
        .collection('invites')
        .doc(invite._id)
        .update({ data: { todo: snapshot, updated_at: nowIso() } })

      let updated = 0
      let rows = []
      try {
        const res = await db
          .collection('invite_members')
          .where({ invite_id: inviteId, status: 'joined' })
          .limit(100)
          .get()
        rows = res.data || []
      } catch (e) {
        rows = []
      }
      for (let i = 0; i < rows.length; i++) {
        const m = rows[i]
        if (!m.todo_id) continue
        const patch = Object.assign({}, snapshot, {
          shared: true,
          owner_openid: openid,
          invite_id: inviteId,
          status: 'active',
          updated_at: nowIso(),
        })
        // 同样游标推进到此刻：避免改时间后把历史到期项重发给所有成员
        if (timeChanged) {
          patch.last_logged_at = nowIso()
          patch.last_pushed_at = nowIso()
          patch.last_reminded_at = nowIso()
        }
        const ok = await db
          .collection('todos')
          .doc(String(m.todo_id))
          .update({ data: patch })
          .then(() => 1)
          .catch(() => 0)
        updated += ok
      }
      return { ok: true, updated: updated }
    }

    if (action === 'share.members') {
      const inviteId = String(event.invite_id || '')
      let rows = []
      try {
        const res = await db
          .collection('invite_members')
          .where({ invite_id: inviteId, status: 'joined' })
          .limit(100)
          .get()
        rows = res.data || []
      } catch (e) {
        rows = []
      }
      // 小程序拿不到微信好友的昵称，只能显示成员自己填的称呼；
      // 没填的按加入顺序回退成「好友 N」
      let seq = 0
      return {
        ok: true,
        members: rows.map((m) => {
          seq += 1
          const nick = String(m.nickname || '').trim()
          return {
            openid: m.openid,
            nickname: nick || '好友' + seq,
            named: !!nick,
            joined_at: m.joined_at || '',
          }
        }),
      }
    }

    return {
      ok: false,
      message: '未知操作：' + action + '｜pushapi 版本 ' + BUILD + '（看不到版本号说明云端没更新）',
      build: BUILD,
    }
  } catch (e) {
    console.error('[pushapi] 处理失败：', e)
    return { ok: false, message: e.errMsg || e.message || '云函数内部错误' }
  }
}
