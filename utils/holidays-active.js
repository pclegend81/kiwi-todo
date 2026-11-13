/**
 * 节假日「有效年份」统一口径（纯函数，无 wx 依赖，便于单测）。
 *
 * 以内置种子里的最早年份为下界：早于它的都视为已结束的旧数据 ——
 * 不在列表显示、不进入 holidayMap（不参与提醒计算）、并会被自动清理。
 * 目前内置种子只含 2027，因此 2026 及更早全部淘汰。
 * 明年新增年份表后，只要保留 2027 表，下界仍是 2027；要淘汰 2027 时移除该表即可。
 */

/** 从内置种子推导有效年份下界（最小年份） */
function minSeedYear(seedRows) {
  let min = ''
  for (let i = 0; i < (seedRows || []).length; i++) {
    const y = String((seedRows[i] && seedRows[i].day) || '').slice(0, 4)
    if (/^\d{4}$/.test(y) && (!min || y < min)) min = y
  }
  return min
}

/** 只保留年份 >= minYear 的行；minYear 非法时原样返回（兜底，避免误清空） */
function filterFrom(rows, minYear) {
  const y = String(minYear || '')
  if (!/^\d{4}$/.test(y)) return (rows || []).slice()
  return (rows || []).filter((r) => String((r && r.day) || '').slice(0, 4) >= y)
}

/** 某个 day 是否属于已淘汰的旧年份 */
function isStale(day, minYear) {
  const y = String(day || '').slice(0, 4)
  const m = String(minYear || '')
  return /^\d{4}$/.test(y) && /^\d{4}$/.test(m) && y < m
}

/**
 * 以内置种子为骨架合并云端数据，保证页面永远能显示有效年份的完整安排。
 *
 * - seedRows 提供全部内置日期（即使数据库为空 / 未登录 / 写入失败也能显示）；
 * - dbRows 按 day 覆盖同名日期（用户手改的名称与类型优先，并保留真实 id）；
 * - dbRows 里内置表没有的自定义日期也会追加进来；
 * - excludedDays 是用户显式删掉的日期，两端都跳过（防止自动回灌把删掉的日期复活）。
 *
 * 返回按 day 升序排列的数组，source: 'seed' 表示仅内置、无云端 id；'cloud' 表示库里有记录。
 */
function mergeWithSeed(seedRows, dbRows, excludedDays) {
  const excluded = {}
  ;(excludedDays || []).forEach((d) => { excluded[String(d).slice(0, 10)] = true })
  const byDay = {}

  ;(seedRows || []).forEach((s) => {
    const day = String((s && s.day) || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || excluded[day]) return
    byDay[day] = {
      id: '',
      day: day,
      name: (s && s.name) || '',
      kind: (s && s.kind) === 'workday' ? 'workday' : 'holiday',
      source: 'seed',
    }
  })

  ;(dbRows || []).forEach((r) => {
    const day = String((r && r.day) || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || excluded[day]) return
    const base = byDay[day] || {}
    byDay[day] = {
      id: String((r && r.id) || (r && r._id) || ''),
      day: day,
      name: (r && r.name) || base.name || '',
      kind: (r && r.kind) === 'workday' ? 'workday'
        : (r && r.kind) === 'holiday' ? 'holiday' : (base.kind || 'holiday'),
      source: 'cloud',
    }
  })

  return Object.keys(byDay).sort().map((d) => byDay[d])
}

module.exports = { minSeedYear, filterFrom, isStale, mergeWithSeed }
