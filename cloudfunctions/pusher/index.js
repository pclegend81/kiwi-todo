/**
 * KIWI待办 · 推送云函数（定时扫描下发）
 *
 * 每 1 分钟由定时触发器调用一次：
 *   1. 读主 todos 集合里的 active 待办（openid 字段标识归属用户）；
 *   2. 用与小程序完全相同的 reminder-core 计算到期项（含节假日跳过/顺延）；
 *   3. 用户已授权（微信侧订阅额度）即通过订阅消息下发，并推进独立的 last_pushed_at 游标。
 *      不再维护自有 push_quotas 额度，所有用户不限量推送，由微信侧授权控制。
 *
 * 推送游标（last_pushed_at）与小程序端的记录游标（last_logged_at）互相独立：
 * 曾共用 last_reminded_at 时，两个消费者抢同一条时间线，谁先跑谁吞掉到期事件，
 * 表现为「微信收不到提醒」或「首页突然多出几条提醒」。
 * 下发失败（43101 订阅额度用尽）不推进游标，用户下次授权后自动重试。
 */
// 云函数运行环境默认 UTC：不设置 TZ 的话，reminder-core 里所有按「本地时区」做的
// 日期运算都会偏 8 小时 —— 11:13 的提醒显示成 03:13，凌晨 0–8 点的待办、
// 「按日历选择」的日期和生效范围还会直接算错一天。必须在任何 Date 运算之前设置。
process.env.TZ = 'Asia/Shanghai'
const cloud = require('wx-server-sdk')
const core = require('./reminder-core')
const { HOLIDAYS_2027 } = require('./holidays-2027')
// 2026 已结束，内置兜底表不再包含（如需恢复，重新 concat('./holidays-2026')）
const SEED_HOLIDAYS = HOLIDAYS_2027
/** 有效年份下界：与小程序端 utils/store.js 口径一致，早于它的日期不参与提醒计算 */
const MIN_HOLIDAY_YEAR = SEED_HOLIDAYS.reduce((min, row) => {
  const y = String(row.day || '').slice(0, 4)
  return /^\d{4}$/.test(y) && (!min || y < min) ? y : min
}, '') || String(new Date().getFullYear())

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 与 pushapi/index.js 保持一致；0.1 已提审，切换为 formal
const TEMPLATE_ID = '80ZMLz3QxJ_KlrrK6uU_GqHNOlmL5xvr6247IO5PmEA'
/**
 * 多模板并行：一次授权会给列表里每个模板各补 1 条额度，下发时按顺序尝试，
 * 某个模板额度用尽（43101）或字段不匹配（47003）就换下一个。
 * 必须与 pushapi/index.js 的 TEMPLATE_IDS、utils/config.js 的 FALLBACK_TEMPLATE_IDS 同步。
 * 默认只放 1 个 = 行为不变；微信上限 5 个，且模板标题不能相同。
 */
const TEMPLATE_IDS = [
  TEMPLATE_ID,
  // '第 2 个模板 ID',
]
// 下发状态：developer=开发调试 / trial=体验版 / formal=正式版。
// 当前处于「上传审批 / 体验版测试」阶段，没有正式发布版，必须用 trial，
// 否则体验版/开发版用户收不到订阅消息（表现为真实提醒不响、测试却能收到）。
// ⚠️ 审核通过并正式发布后，务必改回 'formal'，否则全量用户收不到。
const MINIPROGRAM_STATE = 'trial'
/** 下发失败最多回溯 15 分钟；再早的到期项直接放弃，避免用户一授权就被历史消息轰炸 */
const PUSH_RETRY_WINDOW_MS = 15 * 60 * 1000
/** 云端测试时看返回值里的 build，可判断是否部署了新版 */
const PUSHER_BUILD = '2026-11-13a'
// 模板关键词：日程时间 date4(纯日期) / 日程标题 thing5 / 开始时间 time6 / 备注 thing11
const TEMPLATE_FIELDS = [
  { key: 'date4', source: 'date' },
  { key: 'thing5', source: 'title' },
  { key: 'time6', source: 'time' },
  { key: 'thing11', source: 'note' },
]
/**
 * 追加模板时，若它的关键词编号和默认模板不同，在这里按模板 ID 配一份字段映射，
 * 否则下发会报 47003（模板参数格式不符）。没配的模板沿用 TEMPLATE_FIELDS。
 */
const TEMPLATE_FIELDS_BY_ID = {
  // '第 2 个模板 ID': [{ key: 'thing1', source: 'title' }, { key: 'time2', source: 'time' }],
}
function fieldsFor(templateId) {
  return TEMPLATE_FIELDS_BY_ID[templateId] || TEMPLATE_FIELDS
}

function buildMessageData(todo, atMs, fields) {
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
  const list = Array.isArray(fields) ? fields : TEMPLATE_FIELDS
  list.forEach((field) => {
    if (!field || !field.key) return
    const raw = values[field.source] !== undefined ? values[field.source] : ''
    out[field.key] = { value: String(raw) }
  })
  return out
}

async function loadHolidayMap() {
  // 与小程序共用 holidays 集合（公共数据）；读失败时退化为内置静态表（仅有效年份）
  const map = core.buildHolidayMap(
    SEED_HOLIDAYS.map((row) => ({ day: String(row.day).slice(0, 10), kind: row.kind }))
  )
  try {
    const rows = await db.collection('holidays').limit(1000).get()
    for (let i = 0; i < rows.data.length; i++) {
      const row = rows.data[i]
      if (!row || !row.day) continue
      // 已结束年份（如 2026）不进 holidayMap，避免旧数据参与提醒计算
      if (String(row.day).slice(0, 4) < MIN_HOLIDAY_YEAR) continue
      map[String(row.day).slice(0, 10)] = row.kind === 'workday' ? 'workday' : 'holiday'
    }
  } catch (e) {
    console.warn('[pusher] 读节假日失败，用内置表：', e.message)
  }
  return map
}

exports.main = async () => {
  if (!TEMPLATE_IDS.length) {
    console.log('[pusher] 未配置模板 ID，跳过扫描')
    return { ok: true, skipped: true, build: PUSHER_BUILD }
  }
  const now = Date.now()
  const holidayMap = await loadHolidayMap()
  const col = db.collection('todos')

  let sent = 0
  let skipped = 0
  let scanned = 0

  // 把本轮下发结果写回用户，供「我的」页显示「微信提醒已中断」告警。
  // 一次性订阅额度耗尽时用户毫无感知，只看到「到点没响」，这里把原因暴露出来。
  // 每人每轮最多写 2 次；同一用户先失败后成功时以成功为准。
  const healthState = {}
  async function markHealth(openid, ok, code) {
    if (!openid) return
    const next = ok ? 'ok' : (Number(code) === 43101 ? 'quota' : 'error')
    const prev = healthState[openid]
    if (prev === 'ok' || prev === next) return
    healthState[openid] = next
    const patch = ok
      ? { last_push_ok_at: Date.now(), last_push_error: '' }
      : { last_push_error: next, last_push_error_at: Date.now() }
    try {
      const devices = db.collection('push_devices')
      const r = await devices.where({ openid: openid }).update({ data: patch })
      // 从没点过「开启推送服务」的用户没有设备文档，补建一条，
      // 否则告警写了也读不出来
      if (!r || !r.stats || !r.stats.updated) {
        await devices.add({ data: Object.assign({ openid: openid, createdAt: Date.now() }, patch) })
      }
    } catch (e) {
      // 状态展示是辅助能力，写失败绝不能影响下发主流程
      console.warn('[pusher] 写推送状态失败：', e.message)
    }
  }

  let offset = 0
  for (let page = 0; page < 20; page++) {
    const snap = await col
      .where({ status: 'active' })
      .orderBy('_id', 'asc')
      .skip(offset)
      .limit(100)
      .get()
    if (!snap.data.length) break
    offset += snap.data.length

    for (let i = 0; i < snap.data.length; i++) {
      const todo = snap.data[i]
      if (!todo || !todo.remind_at || !todo.openid) continue
      scanned++

      const baseMs = new Date(todo.remind_at).getTime()
      if (isNaN(baseMs)) continue

      // 只读推送自己的游标，不碰小程序端补记用的 last_logged_at。
      // 不回退读旧字段 last_reminded_at：小程序端仍在写它做兼容，回退会让
      // 未推送的到期项被误判成「已推送」。老数据没有新游标时靠 15 分钟窗口兜底，
      // 既不会漏掉刚到点的，也不会把历史消息一次性补发。
      const oldest = now - PUSH_RETRY_WINDOW_MS
      let startMs = baseMs
      const pushedAt = todo.last_pushed_at || ''
      if (pushedAt) {
        const lastMs = new Date(pushedAt).getTime()
        if (!isNaN(lastMs) && lastMs + 1 > startMs) startMs = lastMs + 1
      }
      // 同上：游标太旧时钳到重试窗口，避免 20 条上限截断后游标追不上现在
      if (startMs < oldest) startMs = oldest

      const events = core.collectOccurrences(todo, startMs, now, holidayMap, 20)
      let cursor = 0

      for (let k = 0; k < events.length; k++) {
        const ev = events[k]
        if (ev.at > now) continue
        if (ev.at < oldest) {
          // 超出重试窗口：直接放弃，只推进游标。久未授权 / 刚加入协作的用户
          // 不会在授权后一次性收到过去几天的全部提醒
          cursor = ev.at
          continue
        }
        if (ev.status !== 'sent') {
          // 节假日跳过：不消耗额度，只推进游标
          cursor = ev.at
          skipped++
          continue
        }
        // 多模板并行：某个模板额度用尽（43101）或字段不匹配（47003）就换下一个模板。
        // 单模板时只循环一次，行为与旧版完全一致。
        let delivered = false
        let lastCode = null
        for (let ti = 0; ti < TEMPLATE_IDS.length; ti++) {
          const tplId = TEMPLATE_IDS[ti]
          try {
            await cloud.openapi.subscribeMessage.send({
              touser: todo.openid,
              templateId: tplId,
              page: 'pages/index/index',
              miniprogramState: MINIPROGRAM_STATE,
              lang: 'zh_CN',
              data: buildMessageData(todo, ev.at, fieldsFor(tplId)),
            })
            sent++
            cursor = ev.at
            await markHealth(todo.openid, true)
            console.log('[pusher] 已下发：', todo.title, core.beijingKey(ev.at).datetime, tplId)
            delivered = true
            break
          } catch (e) {
            lastCode = e.errCode || (e.result && e.result.errCode)
            // 其他错误（网络 / openid 无效等）换多少模板都一样，直接停
            if (Number(lastCode) !== 43101 && Number(lastCode) !== 47003) break
          }
        }
        if (!delivered) {
          if (Number(lastCode) === 43101) {
            // 一次性订阅额度用尽：不推进游标，用户下次授权后自动重试
            console.log('[pusher] 订阅额度不足，保留待重试：', todo.title)
          } else {
            console.error('[pusher] 下发失败，保留待重试：', todo.title, lastCode || '')
          }
          await markHealth(todo.openid, false, lastCode)
          // 后续事件同样发不出去，停止本轮，保证游标不越过失败点
          break
        }
      }

      if (cursor > 0) {
        await col.doc(todo._id).update({ data: { last_pushed_at: new Date(cursor).toISOString() } })
      }
    }
  }

  return { ok: true, scanned: scanned, sent: sent, skipped: skipped, build: PUSHER_BUILD }
}
