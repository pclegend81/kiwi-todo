/**
 * 2026 年中国大陆法定节假日与调休补班日（国务院办公厅 2025-11-04 公布）。
 * kind: holiday = 放假（跳过提醒）；workday = 周末调休上班（照常提醒）。
 * 与数据库 holidays 表的种子数据一致；新增年份时同步补到这里，
 * 小程序首次启动会把缺失的日期回灌到云端，保证两端一致。
 */
var HOLIDAYS_2026 = [
  { day: '2026-01-01', name: '元旦', kind: 'holiday' },
  { day: '2026-01-02', name: '元旦', kind: 'holiday' },
  { day: '2026-01-03', name: '元旦', kind: 'holiday' },
  { day: '2026-01-04', name: '元旦调休补班', kind: 'workday' },
  { day: '2026-02-14', name: '春节调休补班', kind: 'workday' },
  { day: '2026-02-15', name: '春节', kind: 'holiday' },
  { day: '2026-02-16', name: '春节', kind: 'holiday' },
  { day: '2026-02-17', name: '春节', kind: 'holiday' },
  { day: '2026-02-18', name: '春节', kind: 'holiday' },
  { day: '2026-02-19', name: '春节', kind: 'holiday' },
  { day: '2026-02-20', name: '春节', kind: 'holiday' },
  { day: '2026-02-21', name: '春节', kind: 'holiday' },
  { day: '2026-02-22', name: '春节', kind: 'holiday' },
  { day: '2026-02-23', name: '春节', kind: 'holiday' },
  { day: '2026-02-28', name: '春节调休补班', kind: 'workday' },
  { day: '2026-04-04', name: '清明节', kind: 'holiday' },
  { day: '2026-04-05', name: '清明节', kind: 'holiday' },
  { day: '2026-04-06', name: '清明节', kind: 'holiday' },
  { day: '2026-05-01', name: '劳动节', kind: 'holiday' },
  { day: '2026-05-02', name: '劳动节', kind: 'holiday' },
  { day: '2026-05-03', name: '劳动节', kind: 'holiday' },
  { day: '2026-05-04', name: '劳动节', kind: 'holiday' },
  { day: '2026-05-05', name: '劳动节', kind: 'holiday' },
  { day: '2026-05-09', name: '劳动节调休补班', kind: 'workday' },
  { day: '2026-06-19', name: '端午节', kind: 'holiday' },
  { day: '2026-06-20', name: '端午节', kind: 'holiday' },
  { day: '2026-06-21', name: '端午节', kind: 'holiday' },
  { day: '2026-09-20', name: '国庆节调休补班', kind: 'workday' },
  { day: '2026-09-25', name: '中秋节', kind: 'holiday' },
  { day: '2026-09-26', name: '中秋节', kind: 'holiday' },
  { day: '2026-09-27', name: '中秋节', kind: 'holiday' },
  { day: '2026-10-01', name: '国庆节', kind: 'holiday' },
  { day: '2026-10-02', name: '国庆节', kind: 'holiday' },
  { day: '2026-10-03', name: '国庆节', kind: 'holiday' },
  { day: '2026-10-04', name: '国庆节', kind: 'holiday' },
  { day: '2026-10-05', name: '国庆节', kind: 'holiday' },
  { day: '2026-10-06', name: '国庆节', kind: 'holiday' },
  { day: '2026-10-07', name: '国庆节', kind: 'holiday' },
  { day: '2026-10-10', name: '国庆节调休补班', kind: 'workday' },
]

module.exports = { HOLIDAYS_2026: HOLIDAYS_2026 }
