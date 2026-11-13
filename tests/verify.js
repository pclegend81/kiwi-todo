/**
 * 项目结构与配置校验：node tests/verify.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
let problems = 0

function ok(msg) {
  console.log('  ✓ ' + msg)
}

function bad(msg) {
  problems++
  console.log('  ✗ ' + msg)
}

console.log('项目结构校验')

const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
if (app.lazyCodeLoading === 'requiredComponents') ok('app.json 已启用组件懒加载')
else bad('app.json 缺少 lazyCodeLoading: requiredComponents')

;(app.pages || []).forEach((p) => {
  const wxml = path.join(ROOT, p + '.wxml')
  const js = path.join(ROOT, p + '.js')
  if (fs.existsSync(wxml) && fs.existsSync(js)) ok('页面完整 ' + p)
  else bad('页面缺失文件 ' + p)
})

const tabPages = ((app.tabBar || {}).list || []).map((t) => t.pagePath)
tabPages.forEach((p) => {
  if ((app.pages || []).indexOf(p) >= 0) ok('tabBar 页面已注册 ' + p)
  else bad('tabBar 页面不在 pages 中 ' + p)
})
;((app.tabBar || {}).list || []).forEach((t) => {
  if (t.iconPath) bad('tabBar 引用了可能不存在的图标 ' + t.iconPath)
})

// 自定义 tabBar（原生 tabBar 字号由系统固定，改大改粗必须走 custom）
if ((app.tabBar || {}).custom === true) ok('已启用自定义 tabBar（底部文字可放大加粗）')
else bad('app.json 的 tabBar 未设置 custom: true')

;['index.js', 'index.json', 'index.wxml', 'index.wxss'].forEach((f) => {
  if (fs.existsSync(path.join(ROOT, 'custom-tab-bar', f))) ok('自定义 tabBar 文件存在 ' + f)
  else bad('自定义 tabBar 缺少 custom-tab-bar/' + f)
})

;((app.tabBar || {}).list || []).forEach((t, i) => {
  const src = fs.readFileSync(path.join(ROOT, t.pagePath + '.js'), 'utf8')
  if (new RegExp("setData\\(\\{\\s*selected:\\s*" + i + "\\s*\\}").test(src)) {
    ok('页面已绑定 tabBar 选中态 ' + t.pagePath)
  } else {
    bad('页面未设置 tabBar selected=' + i + '：' + t.pagePath)
  }
})

// WXML 里引用的 usingComponents / import / include 是否存在
function scanWxml(file) {
  const src = fs.readFileSync(file, 'utf8')
  const refs = []
  const re = /(?:src|url)\s*=\s*"([^"]+)"/g
  let m
  while ((m = re.exec(src))) refs.push(m[1])
  return refs
}

const pageDirs = fs.readdirSync(path.join(ROOT, 'pages'))
pageDirs.forEach((dir) => {
  const dirPath = path.join(ROOT, 'pages', dir)
  if (!fs.statSync(dirPath).isDirectory()) return
  fs.readdirSync(dirPath)
    .filter((f) => f.endsWith('.wxml'))
    .forEach((f) => {
      scanWxml(path.join(dirPath, f)).forEach((ref) => {
        if (ref.startsWith('/')) {
          const target = path.join(ROOT, ref)
          if (fs.existsSync(target)) ok('引用存在 ' + ref)
          else bad('引用不存在 ' + ref)
        }
      })
    })
})

// 云开发配置检查
const configSrc = fs.readFileSync(path.join(ROOT, 'utils', 'config.js'), 'utf8')
const envMatch = /CLOUD_ENV\s*=\s*'([^']*)'/.exec(configSrc)
if (envMatch && envMatch[1]) ok('已配置云开发环境 ID：' + envMatch[1])
else if (envMatch) ok('未指定环境 ID，使用默认云环境')
else bad('utils/config.js 缺少 CLOUD_ENV')
const pushapiSrc = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'pushapi', 'index.js'), 'utf8')
const tplMatch = /TEMPLATE_ID\s*=\s*'([^']+)'/.exec(pushapiSrc)
if (tplMatch && tplMatch[1] && /templateId:\s*templateId/.test(pushapiSrc)) ok('模板 ID 已内置在 pushapi 并下发给客户端')
else bad('cloudfunctions/pushapi/index.js 缺少 TEMPLATE_ID 或未在 status 接口回传')
if (/DEFAULT_TEMPLATE_ID|onTemplateId|onSaveConfig/.test(configSrc)) {
  bad('客户端仍残留模板 ID 配置项（应改为云端下发）')
} else {
  ok('客户端已移除模板 ID 配置入口')
}

const projCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'))
if (projCfg.cloudfunctionRoot) ok('project.config.json 已声明云函数根目录 ' + projCfg.cloudfunctionRoot)
else bad('project.config.json 缺少 cloudfunctionRoot')

;['pushapi', 'pusher', 'dataapi'].forEach((fnName) => {
  const dir = path.join(ROOT, 'cloudfunctions', fnName)
  const okIndex = fs.existsSync(path.join(dir, 'index.js'))
  const okPkg = fs.existsSync(path.join(dir, 'package.json'))
  const okCfg = fs.existsSync(path.join(dir, 'config.json'))
  if (okIndex && okPkg && okCfg) ok('云函数完整 ' + fnName)
  else bad('云函数文件不全 ' + fnName + '（index.js/package.json/config.json）')
})

// 小程序端不支持数组批量 add，批量写入必须走云函数 dataapi
const storeSrc = fs.readFileSync(path.join(ROOT, 'utils', 'store.js'), 'utf8')
if (/\.add\(\{\s*data:\s*docs\s*\}/.test(storeSrc)) {
  bad('store.js 仍在端上用数组批量 add（小程序端不支持，会报「提醒同步失败」）')
} else if (/callFunction\('dataapi'/.test(storeSrc)) {
  ok('批量写入已走云函数 dataapi（含端上逐条兜底）')
} else {
  bad('store.js 未接入 dataapi 批量写入')
}

// 客户端不得出现 owner_id 赋值（应由数据库 DEFAULT auth.uid() 填充）
const forbidden = []
function walk(dir) {
  fs.readdirSync(dir).forEach((f) => {
    const full = path.join(dir, f)
    if (fs.statSync(full).isDirectory()) {
      if (f === 'node_modules' || f === 'server' || f === 'tests' || f === 'cloudfunctions') return
      walk(full)
      return
    }
    if (f.endsWith('.js')) {
      const src = fs.readFileSync(full, 'utf8')
      if (/owner_id\s*:/.test(src)) forbidden.push(path.relative(ROOT, full))
    }
  })
}
walk(ROOT)
if (forbidden.length === 0) ok('客户端未发送 owner_id（由 RLS 默认填充）')
else bad('客户端出现了 owner_id 赋值：' + forbidden.join(', '))

console.log(problems === 0 ? '\n结构校验全部通过' : '\n存在 ' + problems + ' 个问题')
process.exit(problems === 0 ? 0 : 1)
