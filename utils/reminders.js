const core = require('./reminder-core')
const store = require('./store')

/**
 * 提醒同步：把「已到期但还没记录」的提醒补写进 remind_logs，
 * 并刷新每条待办的下次提醒时间。小程序每次进入前台都会跑一次，
 * 所以历史提醒记录不依赖推送服务也能完整。
 *
 * @param {Array} todos 云端待办（status = active）
 * @param {Object} holidayMap {'2026-01-01': 'holiday'}
 * @returns {{created:number, fresh:Array, updated:Array}}
 */
/** 单次同步里，同一条待办最多补写的记录数（防止分钟级重复产生海量记录） */
const MAX_LOGS_PER_TODO = 20
/** 只补记最近 2 小时内到期的项；更早的视为历史，仍推进游标但不写记录 */
const LOGGABLE_WINDOW_MS = 2 * 60 * 60 * 1000

async function syncDueReminders(todos, holidayMap) {
  const now = Date.now()
  const logRows = []
  const updates = []

  for (let i = 0; i < todos.length; i++) {
    const todo = todos[i]
    if (todo.status !== 'active') continue
    if (!todo.remind_at) continue

    const baseMs = new Date(todo.remind_at).getTime()
    if (isNaN(baseMs)) continue

    // 记录游标与推送游标必须分开：曾共用 last_reminded_at 时，
    // 小程序端先补记就把到期事件「消费」掉了，pusher 再也发不出微信消息；
    // 反过来 pusher 先跑，小程序端就少一条提醒记录。
    // 只读自己的 last_logged_at：绝不能回退读旧字段，否则老数据会把
    // 补记游标和推送游标重新串起来。旧数据没有新游标时靠下面的时间窗口兜底。
    const oldest = now - LOGGABLE_WINDOW_MS
    let startMs = baseMs
    const loggedAt = todo.last_logged_at || ''
    if (loggedAt) {
      const lastMs = new Date(loggedAt).getTime()
      if (!isNaN(lastMs) && lastMs + 1 > startMs) startMs = lastMs + 1
    }
    // 游标太旧（或首次运行）时把起点钳到窗口内：否则分钟级重复会一次
    // 枚举满 50 个早期事件就撞上限，游标永远追不上「现在」
    if (startMs < oldest) startMs = oldest

    // 上限要盖得住窗口内最高频的情况（每分钟一次 × 2 小时 = 120），
    // 否则枚举截断后 maxAt 停在半途，游标每次都追不上现在
    const events = core.collectOccurrences(todo, startMs, now, holidayMap, 200)
    let maxAt = 0
    // 只保留最近的若干条（分钟级重复时避免记录爆炸），游标仍推进到最晚时刻
    const rows = []
    for (let j = 0; j < events.length; j++) {
      const ev = events[j]
      if (ev.at > now) continue
      // 太老的历史只推进游标、不写记录：否则新建待办若没初始化游标，
      // 首页「有 N 条提醒已到期」会莫名冒出一串。
      if (ev.at < oldest) {
        if (ev.at > maxAt) maxAt = ev.at
        continue
      }
      rows.push({
        todo_id: todo.id,
        todo_title: todo.title,
        todo_priority: todo.priority || 'medium',
        scheduled_at: new Date(ev.at).toISOString(),
        status: ev.status,
        remark: ev.reason || '',
        channel: 'app',
      })
      if (ev.at > maxAt) maxAt = ev.at
    }
    for (let k = Math.max(0, rows.length - MAX_LOGS_PER_TODO); k < rows.length; k++) {
      logRows.push(rows[k])
    }

    const next = core.nextOccurrence(todo, maxAt > 0 ? maxAt + 1 : now, holidayMap)
    const nextIso = next ? new Date(next.at).toISOString() : null
    const patch = {}
    if (maxAt > 0) {
      // 只写自己的游标。写 last_reminded_at 会让新版 pusher 的旧字段回退误判成「已推送」。
      patch.last_logged_at = new Date(maxAt).toISOString()
    }
    const prevNext = todo.next_remind_at ? new Date(todo.next_remind_at).getTime() : 0
    if ((next ? next.at : 0) !== prevNext) patch.next_remind_at = nextIso
    if (Object.keys(patch).length > 0) {
      updates.push({ id: todo.id, patch: patch, nextText: next ? next.atText : '' })
    }
  }

  let created = 0
  if (logRows.length > 0) {
    const res = await store.insertLogs(logRows)
    if (res.error) {
      return { created: 0, fresh: [], updated: updates, error: res.error }
    }
    created = (res.data || []).length
  }

  // 一次性批量写回（走云函数 dataapi，失败时端上并发单条兜底）
  if (updates.length > 0) {
    await store.batchUpdateTodos(updates.map((u) => ({ id: u.id, patch: u.patch })))
  }

  return { created: created, fresh: logRows, updated: updates, error: null }
}

/**
 * 为列表展示补充派生字段：下次提醒文案、完成状态、节假日标记。
 *
 * 「完成」有两种模式，由每条待办自己的 manual_done 决定（新增页开关，**默认关闭**）：
 *   - 默认（false / 字段缺失）：提醒发完 / 单次到点 / 指定日期过完 / 超出生效范围，
 *     就自动完成并归档到「提醒记录」。这是最省事的用法，适合「提醒一下就行」的待办。
 *   - 打开（true）：只认云端 status === 'done'。到点仍留在待办页标「待确认完成」并置顶，
 *     必须用户手工点「确认做完了」，适合真的要跟踪有没有干完的事。
 *
 * 云端从不自动改 status；这里只是展示层判定。老数据没有 manual_done 字段，
 * 一律按默认的「自动完成」处理，不会突然冒出一堆「待确认完成」。
 */
function decorate(todo, holidayMap, nowMs) {
  const now = nowMs || Date.now()
  const next = core.nextOccurrence(todo, now, holidayMap)
  const item = Object.assign({}, todo)
  item.priority = todo.priority || 'medium'
  item.priorityText = core.priorityText(item.priority)
  item.repeatText = core.describeRepeat(todo)
  item.nextText = next ? next.atText : ''
  item.nextAt = next ? next.at : 0
  const manual = todo.manual_done === true
  item.manualDone = manual
  item.finished = todo.status === 'done' || (!manual && !next)
  // 只有开了「需要手工确认完成」的，提醒发完才留下来催一下
  item.needDone = manual && !next && !item.finished
  if (todo.repeat_type === 'restday') {
    item.skipHolidayText = '仅休息日提醒'
  } else {
    item.skipHolidayText = todo.skip_holiday
      ? (todo.holiday_action === 'postpone' ? '节假日顺延' : '节假日跳过')
      : '节假日照常提醒'
  }
  const first = new Date(todo.remind_at)
  item.remindText = isNaN(first.getTime()) ? '' : core.minuteKey(first) + ' ' + core.weekdayName(first)
  // 附件备注：列表里只露一个「附件」标记，详情在编辑页看
  item.images = Array.isArray(todo.images) ? todo.images : []
  item.imageCount = item.images.length
  item.location = todo.location || null
  item.hasAttach = item.imageCount > 0 || !!item.location
  return item
}

module.exports = {
  syncDueReminders: syncDueReminders,
  decorate: decorate,
}
