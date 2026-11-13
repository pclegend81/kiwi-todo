/**
 * 2027 年中国大陆法定节假日与调休补班日
 * （国务院办公厅 2026-11-05 公布，国办发明电〔2026〕10号）。
 * kind: holiday = 放假（跳过提醒）；workday = 周末调休上班（照常提醒）。
 * 与数据库 holidays 表的种子数据一致；新增年份时同步补到这里，
 * 小程序启动时会把缺失的日期回灌到云端，保证两端一致。
 */
var HOLIDAYS_2027 = [
  // 元旦：1月1日（周五）至3日（周日）放假，共 3 天
  { day: '2027-01-01', name: '元旦', kind: 'holiday' },
  { day: '2027-01-02', name: '元旦', kind: 'holiday' },
  { day: '2027-01-03', name: '元旦', kind: 'holiday' },
  // 春节：2月5日（除夕、周五）至13日（周六）放假调休，共 9 天；1月31日（周日）、2月14日（周日）上班
  { day: '2027-01-31', name: '春节调休补班', kind: 'workday' },
  { day: '2027-02-05', name: '春节', kind: 'holiday' },
  { day: '2027-02-06', name: '春节', kind: 'holiday' },
  { day: '2027-02-07', name: '春节', kind: 'holiday' },
  { day: '2027-02-08', name: '春节', kind: 'holiday' },
  { day: '2027-02-09', name: '春节', kind: 'holiday' },
  { day: '2027-02-10', name: '春节', kind: 'holiday' },
  { day: '2027-02-11', name: '春节', kind: 'holiday' },
  { day: '2027-02-12', name: '春节', kind: 'holiday' },
  { day: '2027-02-13', name: '春节', kind: 'holiday' },
  { day: '2027-02-14', name: '春节调休补班', kind: 'workday' },
  // 清明节：4月3日（周六）至5日（周一）放假，共 3 天
  { day: '2027-04-03', name: '清明节', kind: 'holiday' },
  { day: '2027-04-04', name: '清明节', kind: 'holiday' },
  { day: '2027-04-05', name: '清明节', kind: 'holiday' },
  // 劳动节：5月1日（周六）至5日（周三）放假调休，共 5 天；5月8日（周六）上班
  { day: '2027-05-01', name: '劳动节', kind: 'holiday' },
  { day: '2027-05-02', name: '劳动节', kind: 'holiday' },
  { day: '2027-05-03', name: '劳动节', kind: 'holiday' },
  { day: '2027-05-04', name: '劳动节', kind: 'holiday' },
  { day: '2027-05-05', name: '劳动节', kind: 'holiday' },
  { day: '2027-05-08', name: '劳动节调休补班', kind: 'workday' },
  // 端午节：6月9日（周三）放假，共 1 天
  { day: '2027-06-09', name: '端午节', kind: 'holiday' },
  // 中秋节：9月15日（周三）放假，共 1 天
  { day: '2027-09-15', name: '中秋节', kind: 'holiday' },
  // 国庆节：10月1日（周五）至7日（周四）放假调休，共 7 天；9月26日（周日）、10月9日（周六）上班
  { day: '2027-09-26', name: '国庆节调休补班', kind: 'workday' },
  { day: '2027-10-01', name: '国庆节', kind: 'holiday' },
  { day: '2027-10-02', name: '国庆节', kind: 'holiday' },
  { day: '2027-10-03', name: '国庆节', kind: 'holiday' },
  { day: '2027-10-04', name: '国庆节', kind: 'holiday' },
  { day: '2027-10-05', name: '国庆节', kind: 'holiday' },
  { day: '2027-10-06', name: '国庆节', kind: 'holiday' },
  { day: '2027-10-07', name: '国庆节', kind: 'holiday' },
  { day: '2027-10-09', name: '国庆节调休补班', kind: 'workday' },
]

module.exports = { HOLIDAYS_2027: HOLIDAYS_2027 }
