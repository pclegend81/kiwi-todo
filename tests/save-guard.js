/**
 * 新建保存防重回归测试（纯 Node，mock 掉 wx 与云开发数据库）：
 *   node tests/save-guard.js
 *
 * 复现的真实问题：新增「送舒明」时点保存卡住，按钮毫无反馈，连点几下生成 3 条同名待办。
 * 覆盖：
 *   1. 同一 client_token 并发连点 3 次只 add 一次，三次拿到同一个 id；
 *   2. 上次写库其实成功、客户端没收到响应（超时重试），按 token 命中后复用并覆盖最新内容；
 *   3. 不带 token 的写入（登录补示例待办）保持原行为；
 *   4. withTimeout 超时抛 SAVE_TIMEOUT，底层迟到的成功结果不再翻转判定；
 *   5. 编辑页结构断言：saving 锁 / 成功才返回 / 协作移出 await 链 / 保存中按钮态；
 *   6. 跳转节流：连点「新建」不会压入多个编辑页实例。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const Module = require('module')

const ROOT = path.join(__dirname, '..')
const OPENID = 'openid-test'
let problems = 0

function ok(msg) { console.log('  ✓ ' + msg) }
function bad(msg) { problems++; console.log('  ✗ ' + msg) }
function check(name, fn) {
  try { fn(); ok(name) } catch (e) { bad(name + '：' + e.message) }
}

/* ── 假云数据库：只实现 insertTodo 用到的链式调用 ── */
let rows = []
let addCalls = 0
let updateCalls = 0
let getCalls = 0
let getFails = false

const fakeDb = {
  collection(name) {
    assert.strictEqual(name, 'todos')
    return {
      where(q) {
        return {
          limit() {
            return {
              async get() {
                getCalls++
                if (getFails) throw new Error('模拟查询失败')
                return {
                  data: rows.filter((r) => r.openid === q.openid && r.client_token === q.client_token),
                }
              },
            }
          },
        }
      },
      doc(id) {
        return {
          async update(opt) {
            updateCalls++
            const row = rows.filter((r) => String(r._id) === String(id))[0]
            if (row) Object.assign(row, opt.data)
            return { stats: { updated: 1 } }
          },
        }
      },
      async add(opt) {
        addCalls++
        const id = 'todo_' + addCalls
        rows.push(Object.assign({ _id: id }, opt.data))
        return { _id: id }
      },
    }
  },
}

global.wx = {
  getStorageSync(k) { return k === 'kiwi_openid' ? OPENID : '' },
  setStorageSync() {},
  removeStorageSync() {},
}

const originalLoad = Module._load
Module._load = function (request, parent) {
  if (request === './cloud' && parent && /utils[\\/]store\.js$/.test(parent.filename)) {
    return { db: fakeDb, cloud: {}, callFunction: async () => ({}) }
  }
  return originalLoad.apply(this, arguments)
}
const store = require('../utils/store')
const guard = require('../utils/save-guard')
const navGuard = require('../utils/nav-guard')
Module._load = originalLoad

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

async function main() {
  console.log('新建保存防重回归测试')

  // 1. 幂等键
  check('makeSaveToken 每次进入新建页都不同', () => {
    const a = guard.makeSaveToken()
    const b = guard.makeSaveToken()
    assert.ok(/^sv_/.test(a) && /^sv_/.test(b))
    assert.notStrictEqual(a, b)
  })

  // 2. 并发连点 3 次（复现「3 条送舒明」）
  const token = guard.makeSaveToken()
  const payload = {
    title: '送舒明',
    client_token: token,
    remind_at: '2027-01-01T09:00:00+08:00',
  }
  const results = await Promise.all([
    store.insertTodo(payload),
    store.insertTodo(payload),
    store.insertTodo(payload),
  ])
  check('同一 token 并发连点 3 次只写入 1 条，且首次不发判重查询', () => {
    assert.strictEqual(addCalls, 1)
    assert.strictEqual(getCalls, 0)
    assert.strictEqual(rows.length, 1)
    assert.ok(results.every((r) => !r.error))
    assert.ok(results.every((r) => r.data[0].id === results[0].data[0].id))
  })

  // 3. 第一次其实写成功了但客户端超时，用户再点一次保存
  const retry = await store.insertTodo(Object.assign({}, payload, { title: '送舒明（改过内容）' }))
  check('超时重试才查库，复用原记录并覆盖最新内容，不再新增', () => {
    assert.strictEqual(getCalls, 1)
    assert.strictEqual(addCalls, 1)
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(retry.data[0].id, results[0].data[0].id)
    assert.strictEqual(rows[0].title, '送舒明（改过内容）')
    assert.strictEqual(updateCalls, 1)
  })

  // 4. 换一个 token（重新进入新建页）仍可正常新建另一条
  const another = await store.insertTodo(Object.assign({}, payload, { client_token: guard.makeSaveToken() }))
  check('换页面实例生成新 token 后仍可正常新建', () => {
    assert.strictEqual(addCalls, 2)
    assert.strictEqual(rows.length, 2)
    assert.notStrictEqual(another.data[0].id, results[0].data[0].id)
  })

  // 5. 不带 token 的写入保持原行为
  await store.insertTodo({ title: '打卡' })
  check('不带 token 的调用不做判重，行为不变', () => {
    assert.strictEqual(addCalls, 3)
  })

  // 6. 重试时判重读失败也不阻断保存（构造「同 token 第二次写入」）
  const retryToken = guard.makeSaveToken()
  await store.insertTodo(Object.assign({}, payload, { client_token: retryToken }))
  getFails = true
  const fallback = await store.insertTodo(
    Object.assign({}, payload, { client_token: retryToken, title: '网络抖动后的重试' })
  )
  getFails = false
  check('重试时判重读失败也不阻断保存（回退到 add）', () => {
    assert.ok(!fallback.error)
    assert.strictEqual(addCalls, 5)
  })

  // 7. 超时保护
  const quick = await guard.withTimeout(Promise.resolve(42), 50)
  check('withTimeout 正常返回底层结果', () => assert.strictEqual(quick, 42))
  let timedOut = false
  try {
    await guard.withTimeout(new Promise(() => {}), 15)
  } catch (e) {
    timedOut = e.code === 'SAVE_TIMEOUT'
  }
  check('写库迟迟不返回时抛 SAVE_TIMEOUT', () => assert.strictEqual(timedOut, true))

  let resolveLate
  const late = new Promise((resolve) => { resolveLate = resolve })
  const race = guard.withTimeout(late, 15)
  let lateCode = ''
  try { await race } catch (e) { lateCode = e.code }
  resolveLate({ data: [{ id: 'late' }], error: null })
  await new Promise((r) => setTimeout(r, 25))
  check('超时后底层迟到的成功结果不再翻转判定', () => {
    assert.strictEqual(lateCode, 'SAVE_TIMEOUT')
  })

  // 8. 页面与样式结构断言（防以后重构把锁删掉）
  const editJs = read('pages/edit/edit.js')
  // 只取 onSave 函数体：ensureInvite() 里的 await collab.create 是编辑页懒加载，不算保存链路
  const onSaveSrc = editJs.slice(editJs.indexOf('async onSave()'), editJs.indexOf('onWriteCalendar()'))
  const editWxml = read('pages/edit/edit.wxml')
  const storeJs = read('utils/store.js')
  const appWxss = read('app.wxss')
  check('编辑页有 saving 锁 + 保存中遮罩', () => {
    assert.ok(/if \(this\.data\.saving\) return/.test(editJs))
    assert.ok(/wx\.showLoading\(\{ title: (?:'保存中…'|t\('saving'\)), mask: true \}\)/.test(editJs))
    assert.ok(/setData\(\{ saving: true \}\)/.test(editJs))
  })
  check('保存只等一次写库，且写库成功才返回', () => {
    assert.ok(/saveGuard\.withTimeout\(store\.insertTodo\(todo\)\)/.test(editJs))
    assert.ok(/saveGuard\.withTimeout\(store\.updateTodo\(/.test(editJs))
    const failIdx = editJs.indexOf('const fail = (msg)')
    const backIdx = editJs.indexOf('wx.navigateBack({', failIdx)
    assert.ok(failIdx > 0 && backIdx > failIdx)
  })
  check('协作邀请 / 同步已移出 await 链（不再拖慢保存）', () => {
    assert.ok(onSaveSrc.length > 0)
    assert.ok(!/await collab\.(create|sync)/.test(onSaveSrc))
    assert.ok(/collab\.sync\(String\(this\.data\.inviteId\), todo\)\.catch/.test(onSaveSrc))
  })
  check('新建写入带 client_token，失败会解锁重试', () => {
    assert.ok(/todo\.client_token = this\.saveToken/.test(editJs))
    assert.ok(/fail\(\(e && e\.message\) \|\| (?:'保存失败，请重试'|t\('ed_save_fail_retry'\))\)/.test(editJs))
    assert.ok(/insertInflight/.test(storeJs) && /client_token: token/.test(storeJs))
  })
  check('按钮与全局样式有保存中态', () => {
    assert.ok(/saving \? (?:'保存中…'|T\.saving) : saveText/.test(editWxml))
    assert.ok(/\.btn-saving\s*\{/.test(appWxss))
  })

  // 9. 入口跳转节流
  navGuard.reset()
  check('连点新建 800ms 内只开一个编辑页实例', () => {
    assert.strictEqual(navGuard.guard('/pages/edit/edit', 1000), true)
    assert.strictEqual(navGuard.guard('/pages/edit/edit', 1200), false)
    assert.strictEqual(navGuard.guard('/pages/edit/edit', 1800), true)
  })
  check('不同 url 的跳转互不干扰', () => {
    navGuard.reset()
    assert.strictEqual(navGuard.guard('/pages/edit/edit?id=a', 1000), true)
    assert.strictEqual(navGuard.guard('/pages/edit/edit?id=b', 1100), true)
  })
  check('首页新建入口接入跳转节流', () => {
    const indexJs = read('pages/index/index.js')
    assert.ok(/navGuard\.guard\('\/pages\/edit\/edit'\)/.test(indexJs))
  })

  console.log(problems === 0 ? '\n全部通过（17 项）' : '\n失败 ' + problems + ' 项')
  if (problems > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
