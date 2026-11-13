/**
 * 写入手机系统日历 —— 不依赖微信订阅额度的兜底提醒通道。
 *
 * 为什么需要它：微信「一次性订阅消息」是 1 次授权 = 1 条下发额度，
 * 且授权必须由用户本人在小程序里点击产生，云端定时任务代替不了。
 * 系统日历是手机本地提醒：点一次写入，之后由系统按重复规则持续响，
 * 不消耗任何微信额度，也不需要打开小程序 —— 这才是「点一下管很多次」。
 *
 * 官方 wx.addPhoneRepeatCalendar / wx.addPhoneCalendar 的硬约束（已核实）：
 *   - 基础库 2.15.0+，需 scope.addPhoneCalendar 授权，**仅在点击行为时调用**；
 *   - startTime / endTime / repeatEndTime 都是**秒级** Unix 时间戳（不是毫秒）；
 *   - repeatInterval 只有 day / week / month / year；month 模式日期不能大于 28 日；
 *   - 不支持「每隔 N 个周期」、每工作日/每休息日、按日历选几天、按小时/分钟；
 *   - **没有删除已添加日历事件的 API** —— 改时间或删待办会留下旧日历项。
 *
 * 因此本模块只映射「仅一次」和「按天/周/月/年且间隔为 1」的规则，
 * 其余明确拒绝并给出原因；节假日智能顺延、生效日期范围无法等价表达，
 * 写入成功时会在结果里如实列出差异，不假装等价。
 */

const REPEAT_MAP = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  yearly: 'year',
}

const REPEAT_LABEL = {
  none: '单次',
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  yearly: '每年',
}

const UNSUPPORTED_LABEL = {
  hourly: '按小时',
  minutely: '按分钟',
  workday: '每工作日',
  restday: '每休息日',
  dates: '按日历选择几天',
}

/** 解析 'YYYY-MM-DD'；非法值返回 null */
function parseDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''))
  if (!m) return null
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
}

/**
 * 判断这条待办能否（近似）写进系统日历。
 * 返回 { ok, single, interval, label, reason, warnings }
 * 纯函数、不做任何 wx 调用，可在点击链里同步执行。
 */
function supportInfo(todo) {
  const t = todo || {}
  const type = String(t.repeat_type || 'none')
  const interval = Number(t.repeat_interval || 1)
  const warnings = []

  const baseMs = new Date(t.remind_at).getTime()
  if (isNaN(baseMs)) return { ok: false, reason: '提醒时间无效，无法写入日历。' }

  if (UNSUPPORTED_LABEL[type]) {
    return {
      ok: false,
      reason: '系统日历只支持「仅一次 / 按天 / 按周 / 按月 / 按年」重复，「' +
        UNSUPPORTED_LABEL[type] + '」无法等价写入。请改用微信订阅消息提醒。',
    }
  }
  if (!REPEAT_MAP[type] && type !== 'none') {
    return { ok: false, reason: '未知的重复类型，无法写入日历。' }
  }
  if (type !== 'none' && interval > 1) {
    return {
      ok: false,
      reason: '系统日历不支持「每隔 ' + interval + ' 个周期」重复，只能每天 / 每周 / 每月 / 每年。把间隔改成 1 再写入。',
    }
  }

  // 生效起始日在未来时，把日历事件的起点挪到那天（同一时刻），尽量等价表达
  let startMs = baseMs
  const startDay = parseDay(t.repeat_start)
  if (startDay) {
    const d = new Date(baseMs)
    const moved = new Date(
      startDay.y, startDay.m - 1, startDay.d,
      d.getHours(), d.getMinutes(), 0, 0
    ).getTime()
    if (moved > startMs) startMs = moved
    else warnings.push('「生效开始日期」早于首次提醒，系统日历会从首次提醒时间开始重复')
  }

  // 微信规定 month 模式日期不能大于 28 日
  if (type === 'monthly' && new Date(startMs).getDate() > 28) {
    return {
      ok: false,
      reason: '微信规定系统日历「按月重复」的日期不能大于 28 号，这条待办是 ' +
        new Date(startMs).getDate() + ' 号。请把提醒日期改到 28 号以内，或改用按天重复。',
    }
  }

  if (t.skip_holiday) {
    warnings.push('系统日历按原始周期提醒，不含节假日智能顺延 / 跳过')
  }
  if (t.repeat_end) warnings.push('已按生效结束日设置重复截止')
  warnings.push('修改或删除这条待办不会同步删除日历里的事件，需要到手机日历 App 手动删')

  return {
    ok: true,
    single: type === 'none',
    interval: REPEAT_MAP[type],
    label: REPEAT_LABEL[type] || '重复',
    startMs: startMs,
    endDay: parseDay(t.repeat_end),
    warnings: warnings,
  }
}

/** 构造 wx.addPhoneCalendar / wx.addPhoneRepeatCalendar 的参数（秒级时间戳） */
function buildOptions(todo, info) {
  const t = todo || {}
  const startSec = Math.floor(info.startMs / 1000)
  const lines = []
  if (t.note) lines.push(String(t.note).slice(0, 200))
  lines.push('由 KIWI待办 写入系统日历；修改或删除待办不会自动删除本事件。')

  let location = ''
  if (t.location) {
    if (typeof t.location === 'string') location = t.location
    else location = String(t.location.name || t.location.address || '')
  }

  const opt = {
    title: '【KIWI待办】' + String(t.title || '待办').slice(0, 40),
    startTime: startSec,
    // 给事件 30 分钟长度，alarmOffset=0 表示开始时提醒
    endTime: startSec + 30 * 60,
    allDay: false,
    alarm: true,
    alarmOffset: 0,
    description: lines.join('\n'),
  }
  if (location) opt.location = location.slice(0, 100)

  if (!info.single) {
    opt.repeatInterval = info.interval
    if (info.endDay) {
      const endSec = Math.floor(new Date(
        info.endDay.y, info.endDay.m - 1, info.endDay.d, 23, 59, 59, 0
      ).getTime() / 1000)
      if (endSec > startSec) opt.repeatEndTime = endSec
    }
  }
  return opt
}

/**
 * 在点击链里同步发起写入。调用方必须在 tap handler 里直接调，前面不能有 await。
 * 返回 Promise<{ ok, message }>，回调只做反馈，不影响「点击时调用」这个前提。
 */
function writeTodoCalendar(todo) {
  return new Promise(function (resolve) {
    const info = supportInfo(todo)
    if (!info.ok) {
      resolve({ ok: false, message: info.reason })
      return
    }
    const single = info.single
    const api = single ? wx.addPhoneCalendar : wx.addPhoneRepeatCalendar
    if (typeof api !== 'function') {
      resolve({
        ok: false,
        message: '当前微信版本过低，不支持写入系统日历（需要基础库 2.15.0 及以上）。',
      })
      return
    }
    const params = buildOptions(todo, info)
    params.success = function () {
      const head = single
        ? '已写入手机日历，到点由系统提醒一次。'
        : '已写入手机日历，之后由系统按「' + info.label + '」持续提醒，不消耗微信额度，也不用打开小程序。'
      resolve({ ok: true, message: head + '\n\n注意差异：\n· ' + info.warnings.join('\n· ') })
    }
    params.fail = function (err) {
      const msg = String((err && err.errMsg) || '')
      let hint = msg || '写入系统日历失败'
      if (/auth|deny|permission|scope|privacy|授权|隐私/i.test(msg)) {
        hint = '日历权限没开：请在弹窗里点「允许」，或到小程序右上角「…→设置」打开日历权限；同时确认公众平台「隐私保护指引」已勾选「使用你的日历（仅写入）权限」并重新发布。'
      } else if (/gesture|tap|点击/i.test(msg)) {
        hint = '微信要求必须由点击直接触发，请重新点一次「写入手机日历」。'
      }
      resolve({ ok: false, message: hint })
    }
    // 必须在点击事件同步链里发起；success/fail 是回调，不影响这一点
    api(params)
  })
}

module.exports = {
  supportInfo: supportInfo,
  buildOptions: buildOptions,
  writeTodoCalendar: writeTodoCalendar,
}
