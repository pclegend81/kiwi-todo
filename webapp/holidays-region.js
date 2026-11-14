/**
 * 多地区 2027 年法定节假日种子数据（网页端多语言/多地区支持）。
 * 格式与 holidays-2027.js 完全一致：{ day: 'YYYY-MM-DD', name: '当地语言假日名', kind: 'holiday' | 'workday' }。
 * kind: holiday = 放假（跳过提醒）；workday = 调休补班（照常提醒，目前仅中国大陆有）。
 *
 * 地区键与 webapp/i18n.js 里 LANGS[].region 一一对应：
 *   cn 中国大陆 / us 美国 / gb 英国 / jp 日本 / kr 韩国
 *   de 德国 / fr 法国 / es 西班牙 / it 意大利 / br 巴西
 *
 * 说明：
 * - 中国大陆直接复用 holidays-2027.js（国务院 2026-11-05 公布的官方安排），
 *   这里不复制一份，避免两处维护。
 * - 其它地区均为 2027 年官方公布的法定假日；个别宗教/地方性假日按全国性口径收录，
 *   地方性假日（如德国各州差异、西班牙自治区差异）暂不收录，宁可少放不误放假。
 * - 撞上周末的假日照列（美国/韩国另列补休日，中国以外的国家不做周末调休补班）。
 */
// 浏览器（Web/PWA）里由 index.html 的桥接脚本先行注入 window.KIWI_HOLIDAYS；
// 小程序 / Node 里走 CommonJS require。两边都保持本文件 md5 一致。
var CN = (typeof window !== 'undefined' && window.KIWI_HOLIDAYS)
  ? window.KIWI_HOLIDAYS
  : require('./holidays-2027.js').HOLIDAYS_2027

// ── 日本 2027 国民の祝日（内閣府公表）────────────────────────────
var JP = [
  { day: '2027-01-01', name: '元日', kind: 'holiday' },
  { day: '2027-01-11', name: '成人の日', kind: 'holiday' },
  { day: '2027-02-11', name: '建国記念の日', kind: 'holiday' },
  { day: '2027-02-23', name: '天皇誕生日', kind: 'holiday' },
  { day: '2027-03-21', name: '春分の日', kind: 'holiday' },
  { day: '2027-03-22', name: '振替休日', kind: 'holiday' },
  { day: '2027-04-29', name: '昭和の日', kind: 'holiday' },
  { day: '2027-05-03', name: '憲法記念日', kind: 'holiday' },
  { day: '2027-05-04', name: 'みどりの日', kind: 'holiday' },
  { day: '2027-05-05', name: 'こどもの日', kind: 'holiday' },
  { day: '2027-07-19', name: '海の日', kind: 'holiday' },
  { day: '2027-08-11', name: '山の日', kind: 'holiday' },
  { day: '2027-09-20', name: '敬老の日', kind: 'holiday' },
  { day: '2027-09-21', name: '国民の休日', kind: 'holiday' },
  { day: '2027-09-23', name: '秋分の日', kind: 'holiday' },
  { day: '2027-10-11', name: 'スポーツの日', kind: 'holiday' },
  { day: '2027-11-03', name: '文化の日', kind: 'holiday' },
  { day: '2027-11-23', name: '勤労感謝の日', kind: 'holiday' },
]

// ── 韩国 2027 공휴일（관공서 공휴일，含 대체공휴일）──────────────
var KR = [
  { day: '2027-01-01', name: '신정', kind: 'holiday' },
  { day: '2027-02-05', name: '설날 연휴', kind: 'holiday' },
  { day: '2027-02-06', name: '설날', kind: 'holiday' },
  { day: '2027-02-07', name: '설날 연휴', kind: 'holiday' },
  { day: '2027-02-08', name: '대체공휴일', kind: 'holiday' },
  { day: '2027-03-01', name: '삼일절', kind: 'holiday' },
  { day: '2027-05-05', name: '어린이날', kind: 'holiday' },
  { day: '2027-05-13', name: '부처님 오신 날', kind: 'holiday' },
  { day: '2027-06-06', name: '현충일', kind: 'holiday' },
  { day: '2027-08-15', name: '광복절', kind: 'holiday' },
  { day: '2027-08-16', name: '대체공휴일', kind: 'holiday' },
  { day: '2027-09-14', name: '추석 연휴', kind: 'holiday' },
  { day: '2027-09-15', name: '추석', kind: 'holiday' },
  { day: '2027-09-16', name: '추석 연휴', kind: 'holiday' },
  { day: '2027-10-03', name: '개천절', kind: 'holiday' },
  { day: '2027-10-04', name: '대체공휴일', kind: 'holiday' },
  { day: '2027-10-09', name: '한글날', kind: 'holiday' },
  { day: '2027-10-11', name: '대체공휴일', kind: 'holiday' },
  { day: '2027-12-25', name: '기독탄신일', kind: 'holiday' },
]

// ── 美国 2027 联邦法定假日（含撞周末的补休日）──────────────────
var US = [
  { day: '2027-01-01', name: "New Year's Day", kind: 'holiday' },
  { day: '2027-01-18', name: 'Martin Luther King Jr. Day', kind: 'holiday' },
  { day: '2027-02-15', name: "Washington's Birthday", kind: 'holiday' },
  { day: '2027-05-31', name: 'Memorial Day', kind: 'holiday' },
  { day: '2027-06-18', name: 'Juneteenth (observed)', kind: 'holiday' },
  { day: '2027-06-19', name: 'Juneteenth', kind: 'holiday' },
  { day: '2027-07-04', name: 'Independence Day', kind: 'holiday' },
  { day: '2027-07-05', name: 'Independence Day (observed)', kind: 'holiday' },
  { day: '2027-09-06', name: 'Labor Day', kind: 'holiday' },
  { day: '2027-10-11', name: 'Columbus Day', kind: 'holiday' },
  { day: '2027-11-11', name: 'Veterans Day', kind: 'holiday' },
  { day: '2027-11-25', name: 'Thanksgiving Day', kind: 'holiday' },
  { day: '2027-12-24', name: 'Christmas Day (observed)', kind: 'holiday' },
  { day: '2027-12-25', name: 'Christmas Day', kind: 'holiday' },
]

// ── 英国 2027 英格兰与威尔士银行假日────────────────────────────
var GB = [
  { day: '2027-01-01', name: "New Year's Day", kind: 'holiday' },
  { day: '2027-03-26', name: 'Good Friday', kind: 'holiday' },
  { day: '2027-03-29', name: 'Easter Monday', kind: 'holiday' },
  { day: '2027-05-03', name: 'Early May Bank Holiday', kind: 'holiday' },
  { day: '2027-05-31', name: 'Spring Bank Holiday', kind: 'holiday' },
  { day: '2027-08-30', name: 'Summer Bank Holiday', kind: 'holiday' },
  { day: '2027-12-27', name: 'Christmas Day (substitute day)', kind: 'holiday' },
  { day: '2027-12-28', name: 'Boxing Day (substitute day)', kind: 'holiday' },
]

// ── 德国 2027 全国统一法定假日（各州特有假日暂不收录）──────────
var DE = [
  { day: '2027-01-01', name: 'Neujahr', kind: 'holiday' },
  { day: '2027-03-26', name: 'Karfreitag', kind: 'holiday' },
  { day: '2027-03-29', name: 'Ostermontag', kind: 'holiday' },
  { day: '2027-05-01', name: 'Tag der Arbeit', kind: 'holiday' },
  { day: '2027-05-06', name: 'Christi Himmelfahrt', kind: 'holiday' },
  { day: '2027-05-17', name: 'Pfingstmontag', kind: 'holiday' },
  { day: '2027-10-03', name: 'Tag der Deutschen Einheit', kind: 'holiday' },
  { day: '2027-12-25', name: '1. Weihnachtstag', kind: 'holiday' },
  { day: '2027-12-26', name: '2. Weihnachtstag', kind: 'holiday' },
]

// ── 法国 2027 法定假日（métropole）─────────────────────────────
var FR = [
  { day: '2027-01-01', name: "Jour de l'an", kind: 'holiday' },
  { day: '2027-03-29', name: 'Lundi de Pâques', kind: 'holiday' },
  { day: '2027-05-01', name: 'Fête du Travail', kind: 'holiday' },
  { day: '2027-05-08', name: 'Victoire 1945', kind: 'holiday' },
  { day: '2027-05-06', name: 'Ascension', kind: 'holiday' },
  { day: '2027-05-17', name: 'Lundi de Pentecôte', kind: 'holiday' },
  { day: '2027-07-14', name: 'Fête Nationale', kind: 'holiday' },
  { day: '2027-08-15', name: 'Assomption', kind: 'holiday' },
  { day: '2027-11-01', name: 'Toussaint', kind: 'holiday' },
  { day: '2027-11-11', name: 'Armistice', kind: 'holiday' },
  { day: '2027-12-25', name: 'Noël', kind: 'holiday' },
]

// ── 西班牙 2027 全国法定假日（AEST，自治区特有假日暂不收录）────
var ES = [
  { day: '2027-01-01', name: 'Año Nuevo', kind: 'holiday' },
  { day: '2027-01-06', name: 'Epifanía del Señor', kind: 'holiday' },
  { day: '2027-03-26', name: 'Viernes Santo', kind: 'holiday' },
  { day: '2027-05-01', name: 'Fiesta del Trabajo', kind: 'holiday' },
  { day: '2027-08-15', name: 'Asunción de la Virgen', kind: 'holiday' },
  { day: '2027-10-12', name: 'Fiesta Nacional', kind: 'holiday' },
  { day: '2027-11-01', name: 'Todos los Santos', kind: 'holiday' },
  { day: '2027-12-06', name: 'Constitución Española', kind: 'holiday' },
  { day: '2027-12-08', name: 'Inmaculada Concepción', kind: 'holiday' },
  { day: '2027-12-25', name: 'Navidad', kind: 'holiday' },
]

// ── 意大利 2027 全国法定假日────────────────────────────────────
var IT = [
  { day: '2027-01-01', name: 'Capodanno', kind: 'holiday' },
  { day: '2027-01-06', name: 'Epifania', kind: 'holiday' },
  { day: '2027-03-29', name: 'Lunedì dell\'Angelo (Pasquetta)', kind: 'holiday' },
  { day: '2027-04-25', name: 'Festa della Liberazione', kind: 'holiday' },
  { day: '2027-05-01', name: 'Festa del Lavoro', kind: 'holiday' },
  { day: '2027-06-02', name: 'Festa della Repubblica', kind: 'holiday' },
  { day: '2027-08-15', name: 'Assunzione (Ferragosto)', kind: 'holiday' },
  { day: '2027-11-01', name: 'Ognissanti', kind: 'holiday' },
  { day: '2027-12-08', name: 'Immacolata Concezione', kind: 'holiday' },
  { day: '2027-12-25', name: 'Natale', kind: 'holiday' },
  { day: '2027-12-26', name: 'Santo Stefano', kind: 'holiday' },
]

// ── 巴西 2027 全国法定假日──────────────────────────────────────
var BR = [
  { day: '2027-01-01', name: 'Confraternização Universal', kind: 'holiday' },
  { day: '2027-02-08', name: 'Carnaval', kind: 'holiday' },
  { day: '2027-02-09', name: 'Carnaval', kind: 'holiday' },
  { day: '2027-03-26', name: 'Sexta-feira da Paixão de Cristo', kind: 'holiday' },
  { day: '2027-04-21', name: 'Tiradentes', kind: 'holiday' },
  { day: '2027-05-01', name: 'Dia do Trabalho', kind: 'holiday' },
  { day: '2027-05-27', name: 'Corpus Christi', kind: 'holiday' },
  { day: '2027-09-07', name: 'Independência do Brasil', kind: 'holiday' },
  { day: '2027-10-12', name: 'Nossa Senhora Aparecida', kind: 'holiday' },
  { day: '2027-11-02', name: 'Finados', kind: 'holiday' },
  { day: '2027-11-15', name: 'Proclamação da República', kind: 'holiday' },
  { day: '2027-12-25', name: 'Natal', kind: 'holiday' },
]

var HOLIDAYS_REGION = {
  cn: CN,
  us: US,
  gb: GB,
  jp: JP,
  kr: KR,
  de: DE,
  fr: FR,
  es: ES,
  it: IT,
  br: BR,
}

module.exports = { HOLIDAYS_REGION: HOLIDAYS_REGION }
