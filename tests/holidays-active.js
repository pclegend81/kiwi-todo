/**
 * 节假日「有效年份」过滤专项测试
 * 目标：2026 及更早的数据一律不显示、不进 holidayMap、被自动清理；
 *      2027 及以后完整保留；非法/空值不误清空。
 */
const assert = require('assert')
const { minSeedYear, filterFrom, isStale, mergeWithSeed } = require('../utils/holidays-active')
const { HOLIDAYS_2027 } = require('../utils/holidays-2027')

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

const rows = [
  { id: '1', day: '2026-01-01', name: '元旦', kind: 'holiday' },
  { id: '2', day: '2026-02-14', name: '春节调休补班', kind: 'workday' },
  { id: '3', day: '2026-12-31', name: '跨年', kind: 'holiday' },
  { id: '4', day: '2027-01-01', name: '元旦', kind: 'holiday' },
  { id: '5', day: '2027-02-14', name: '春节', kind: 'holiday' },
  { id: '6', day: '2028-05-01', name: '劳动节', kind: 'holiday' },
  { id: '7', day: '', name: '坏数据', kind: 'holiday' },
]

console.log('节假日有效年份过滤测试')

check('内置种子最小年份 = 2027', () => {
  assert.strictEqual(minSeedYear(HOLIDAYS_2027), '2027')
})

check('空种子返回空串', () => {
  assert.strictEqual(minSeedYear([]), '')
  assert.strictEqual(minSeedYear(null), '')
})

check('过滤后只剩 2027 及以后（3 条，2026 全清）', () => {
  const out = filterFrom(rows, '2027')
  assert.deepStrictEqual(out.map((r) => r.day), ['2027-01-01', '2027-02-14', '2028-05-01'])
  assert.strictEqual(out.some((r) => String(r.day).slice(0, 4) < '2027'), false)
})

check('原数组不被修改（纯函数）', () => {
  const src = rows.slice()
  filterFrom(src, '2027')
  assert.strictEqual(src.length, rows.length)
})

check('minYear 非法时原样返回（兜底防误清空）', () => {
  assert.strictEqual(filterFrom(rows, '').length, rows.length)
  assert.strictEqual(filterFrom(rows, 'abcd').length, rows.length)
  assert.strictEqual(filterFrom(rows, null).length, rows.length)
})

check('isStale：2026 全部淘汰，2027/2028 保留', () => {
  assert.strictEqual(isStale('2026-01-01', '2027'), true)
  assert.strictEqual(isStale('2025-12-31', '2027'), true)
  assert.strictEqual(isStale('2027-01-01', '2027'), false)
  assert.strictEqual(isStale('2028-01-01', '2027'), false)
})

check('isStale 对空值/非法年份不误判', () => {
  assert.strictEqual(isStale('', '2027'), false)
  assert.strictEqual(isStale(null, '2027'), false)
  assert.strictEqual(isStale('2026-01-01', ''), false)
})

check('阈值按字符串前缀切年，与 day<「2027-01-01」等价', () => {
  const threshold = '2027-01-01'
  const byFilter = filterFrom(rows, '2027').filter((r) => /^\d{4}-/.test(r.day))
  const byCompare = rows.filter(
    (r) => /^\d{4}-\d{2}-\d{2}/.test(r.day) && r.day < threshold
  )
  // 两边对 2026 数据的判定应完全一致
  assert.deepStrictEqual(
    byCompare.map((r) => r.day),
    rows.filter((r) => isStale(r.day, '2027')).map((r) => r.day)
  )
  assert.strictEqual(byFilter.some((r) => byCompare.includes(r)), false)
})

check('数据库为空时仍完整显示内置 2027（34 天）', () => {
  const out = mergeWithSeed(HOLIDAYS_2027, [], [])
  assert.strictEqual(out.length, 34)
  assert.strictEqual(out[0].day, '2027-01-01')
  assert.strictEqual(out[out.length - 1].day, '2027-10-09')
  assert.strictEqual(out.every((r) => r.source === 'seed' && r.id === ''), true)
  assert.deepStrictEqual(out.map((r) => r.day), out.map((r) => r.day).slice().sort())
})

check('云端记录覆盖同名日期并保留真实 id', () => {
  const out = mergeWithSeed(HOLIDAYS_2027, [
    { id: 'doc1', day: '2027-01-01', name: '元旦（手改）', kind: 'workday' },
  ], [])
  const one = out.filter((r) => r.day === '2027-01-01')[0]
  assert.strictEqual(one.name, '元旦（手改）')
  assert.strictEqual(one.kind, 'workday')
  assert.strictEqual(one.id, 'doc1')
  assert.strictEqual(one.source, 'cloud')
  assert.strictEqual(out.length, 34)
})

check('云端自定义日期会追加，内置日期不丢失', () => {
  const out = mergeWithSeed(HOLIDAYS_2027, [
    { id: 'doc2', day: '2027-12-25', name: '自定义', kind: 'holiday' },
  ], [])
  assert.strictEqual(out.length, 35)
  assert.strictEqual(out[out.length - 1].day, '2027-12-25')
})

check('排除集让被删日期从内置与云端同时消失', () => {
  const db = [
    { id: 'doc3', day: '2027-01-01', name: '元旦', kind: 'holiday' },
    { id: 'doc4', day: '2027-02-14', name: '春节补班', kind: 'workday' },
    { id: 'doc5', day: '2027-12-25', name: '自定义', kind: 'holiday' },
  ]
  const out = mergeWithSeed(HOLIDAYS_2027, db, ['2027-01-01', '2027-12-25'])
  assert.strictEqual(out.some((r) => r.day === '2027-01-01'), false)
  assert.strictEqual(out.some((r) => r.day === '2027-12-25'), false)
  assert.strictEqual(out.some((r) => r.day === '2027-02-14'), true)
  assert.strictEqual(out.length, 33)
})

check('非法 day 被忽略，且不修改入参', () => {
  const seed = [{ day: '2027-01-01', name: '元旦', kind: 'holiday' }]
  const db = [
    { id: '', day: '', name: '坏数据', kind: 'holiday' },
    { id: '', day: 'oops', name: '坏数据', kind: 'holiday' },
    null,
  ]
  const out = mergeWithSeed(seed, db, [])
  assert.deepStrictEqual(out.map((r) => r.day), ['2027-01-01'])
  assert.strictEqual(db.length, 3)
  assert.strictEqual(seed[0].name, '元旦')
})

check('kind 缺省/异常时回落到内置类型', () => {
  const out = mergeWithSeed(
    [{ day: '2027-01-01', name: '元旦', kind: 'holiday' }],
    [{ id: 'x', day: '2027-01-01', name: '元旦', kind: 'unknown' }],
    []
  )
  assert.strictEqual(out[0].kind, 'holiday')
})

console.log('\n全部 ' + passed + ' 项通过')
