/**
 * 协作提醒（多人同时提醒）客户端封装。
 *
 * 全部走 pushapi 云函数的 share.* action，不在客户端直接读写别人的数据——
 * todos 集合的安全规则是 auth.openid == doc.openid，客户端跨用户读写一律被拒，
 * 云函数用 admin 权限才做得了邀请、加入、同步这几件事。
 *
 * 模型：
 *   - 创建者：待办原件在自己名下，发起邀请后拿到 inviteId；
 *   - 成员：接受邀请后，在自己名下生成一条**副本**（shared=true, owner_openid, invite_id）；
 *   - 提醒：副本与原件提醒规则相同，定时扫描的 pusher 各自命中 → 多人同时收到；
 *   - 同步：创建者改了内容/时间，保存时 share.sync 推给所有成员覆盖副本
 *           （提醒时间变了会重置成员的记录/推送游标，否则新时间会被当已提醒跳过）。
 */
const { callFunction } = require('./cloud')

/** 需要跨用户同步的字段 */
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
  // 完成方式（默认自动完成 / 勾了才手工确认）属于规则，要同步给协作成员；
  // status / done_at 是各人自己的完成状态，故意不在这里。
  'manual_done',
]

function snapshotOf(todo) {
  const out = {}
  const src = todo || {}
  SHARE_FIELDS.forEach((k) => {
    if (src[k] !== undefined) out[k] = src[k]
  })
  return out
}

/** 统一错误结构：{ data, error }，与 store.js 保持一致 */
async function request(payload) {
  try {
    const res = await callFunction('pushapi', payload)
    // 云端返回「未知操作」只可能是 pushapi 没重新部署：
    // 本地新增的 action 云端还不认识。给一句能直接照做的提示，
    // 免得每次都当成代码 bug 排查一遍。
    if (res && res.ok === false && /未知操作/.test(String(res.message || ''))) {
      return {
        data: null,
        error: new Error('云函数 pushapi 还是旧版本，请重新上传并部署后再试'),
      }
    }
    return { data: res, error: null }
  } catch (e) {
    return { data: null, error: e }
  }
}

/**
 * 为一条已保存的待办创建（或复用）邀请。
 * @param {object} todo 待办内容
 * @param {string} todoId 待办在云端的 _id
 * @returns {Promise<{data:{inviteId:string}|null, error:Error|null}>}
 */
function create(todo, todoId) {
  return request({
    action: 'share.create',
    todo: snapshotOf(todo),
    todo_id: String(todoId || ''),
  })
}

/**
 * 读取邀请详情（好友点开分享卡片时展示用）。
 * @param {string} inviteId
 */
function detail(inviteId) {
  return request({ action: 'share.detail', invite_id: String(inviteId || '') })
}

/**
 * 接受邀请：在自己名下建副本并登记为成员。
 * @param {string} inviteId
 * @param {string} [nickname] 成员自己填的称呼，最多 12 字，可留空
 */
function join(inviteId, nickname) {
  return request({
    action: 'share.join',
    invite_id: String(inviteId || ''),
    nickname: String(nickname || ''),
  })
}

/**
 * 用邀请码加入：不用等对方转发卡片，手输 6 位码即可。
 * @param {string} code
 * @param {string} [nickname]
 */
function joinByCode(code, nickname) {
  return request({
    action: 'share.joinByCode',
    code: String(code || '').trim().toUpperCase(),
    nickname: String(nickname || ''),
  })
}

/**
 * 退出协作：删除自己名下的副本。
 * @param {string} inviteId
 */
function leave(inviteId) {
  return request({ action: 'share.leave', invite_id: String(inviteId || '') })
}

/**
 * 创建者保存后把最新内容推给所有成员。
 * @param {string} inviteId
 * @param {object} todo 最新待办内容
 */
function sync(inviteId, todo) {
  return request({
    action: 'share.sync',
    invite_id: String(inviteId || ''),
    todo: snapshotOf(todo),
  })
}

/**
 * 列出某邀请的成员。
 * @param {string} inviteId
 */
function members(inviteId) {
  return request({ action: 'share.members', invite_id: String(inviteId || '') })
}

module.exports = {
  snapshotOf: snapshotOf,
  create: create,
  detail: detail,
  join: join,
  joinByCode: joinByCode,
  leave: leave,
  sync: sync,
  members: members,
}
