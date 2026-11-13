/**
 * webapi 云函数冒烟测试（内存 mock 云数据库，无需真实云环境）
 *
 * 覆盖：小程序端生成口令 -> 网页端 bind 换 token -> 待办增删改查 ->
 *       字段白名单 / 游标重置 / 幂等 / 归属校验 / 作废绑定。
 * 运行：node tests/webapi.js
 */
const Module = require('module')
const assert = require('assert')
const path = require('path')

/* ── 极简云数据库 mock ─────────────────────────────────────────────── */
const store = Object.create(null)
let autoId = 0

const _ = {
  neq: (v) => ({ __op: 'neq', v: v }),
  gt: (v) => ({ __op: 'gt', v: v }),
  lt: (v) => ({ __op: 'lt', v: v }),
  in: (v) => ({ __op: 'in', v: v }),
}

function rows(name) {
  if (!store[name]) store[name] = []
  return store[name]
}

function match(row, q) {
  if (!q) return true
  for (const k of Object.keys(q)) {
    const c = q[k]
    if (c && typeof c === 'object' && c.__op) {
      if (c.__op === 'neq' && !(row[k] !== c.v)) return false
      if (c.__op === 'gt' && !(row[k] > c.v)) return false
      if (c.__op === 'lt' && !(row[k] < c.v)) return false
      if (c.__op === 'in' && c.v.indexOf(row[k]) < 0) return false
    } else if (row[k] !== c) {
      return false
    }
  }
  return true
}

function pick(list, q, limit) {
  const hit = list.filter((r) => match(r, q))
  return hit.slice(0, limit || 100).map((r) => Object.assign({}, r))
}

const db = {
  command: _,
  RegExp: () => ({}),
  collection(name) {
    const list = rows(name)
    let q = null
    let lim = 100
    const chain = {
      where(cond) { q = cond; return chain },
      orderBy() { return chain },
      limit(n) { lim = n; return chain },
      skip() { return chain },
      async get() { return { data: pick(list, q, lim) } },
      async count() { return { total: list.filter((r) => match(r, q)).length } },
      async add({ data }) {
        const arr = Array.isArray(data) ? data : [data]
        const ids = []
        for (const d of arr) {
          const id = 'doc' + (++autoId)
          list.push(Object.assign({ _id: id }, JSON.parse(JSON.stringify(d))))
          ids.push(id)
        }
        return { _id: ids[0], ids: ids }
      },
      async remove() {
        let n = 0
        for (let i = list.length - 1; i >= 0; i--) {
          if (match(list[i], q)) { list.splice(i, 1); n++ }
        }
        return { stats: { removed: n } }
      },
      doc(id) {
        return {
          async update({ data }) {
            const row = list.find((r) => String(r._id) === String(id))
            if (!row) throw new Error('doc not found: ' + id)
            Object.assign(row, JSON.parse(JSON.stringify(data)))
            return { stats: { updated: 1 } }
          },
          async remove() {
            const idx = list.findIndex((r) => String(r._id) === String(id))
            if (idx < 0) throw new Error('doc not found')
            list.splice(idx, 1)
            return { stats: { removed: 1 } }
          },
        }
      },
    }
    return chain
  },
}

let CURRENT_OPENID = 'wx-test-openid-001'
const cloudMock = {
  DYNAMIC_CURRENT_ENV: 'dyn',
  init() {},
  database: () => db,
  getWXContext: () => ({ OPENID: CURRENT_OPENID }),
}

// 拦截 wx-server-sdk，其余 require 走真实模块
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return cloudMock
  return origLoad.apply(this, arguments)
}
let api
try {
  api = require(path.join(__dirname, '..', 'cloudfunctions', 'webapi', 'index.js'))
} finally {
  Module._load = origLoad
}

/* ── 测试框架 ──────────────────────────────────────────────────────── */
let passed = 0
let failed = 0
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  ✓ ' + name) })
    .catch((e) => { failed++; console.log('  ✗ ' + name + '\n    ' + e.message) })
}

function bodyOf(res) { return JSON.parse(res.body) }
function newTodo(over) {
  return Object.assign({
    title: '网页端测试待办',
    note: '来自 PC',
    remind_at: new Date(Date.now() + 3600000).toISOString(),
    repeat_type: 'daily',
    repeat_interval: 1,
    skip_holiday: true,
    holiday_action: 'skip',
    priority: 'medium',
    manual_done: false,
  }, over || {})
}

async function main() {
  console.log('webapi 冒烟测试')

  let code = ''
  let token = ''
  let todoId = ''

  await test('OPTIONS 预检放行并返回 CORS 头', async () => {
    const res = await api.main({ httpMethod: 'OPTIONS' })
    assert.strictEqual(res.statusCode, 204)
    assert.strictEqual(res.headers['Access-Control-Allow-Origin'], '*')
  })

  await test('未知 action 返回 400 且带构建号', async () => {
    const res = await api.main({ action: 'nope' })
    assert.strictEqual(res.statusCode, 400)
    assert.ok(/webapi 版本/.test(bodyOf(res).message))
  })

  await test('小程序端生成 8 位同步口令', async () => {
    const res = await api.main({ action: 'createBinding' })
    assert.strictEqual(res.ok, true)
    code = res.code
    assert.ok(/^[2-9A-HJKMNP-Z]{8}$/.test(code), '口令字符集不符: ' + code)
  })

  await test('重复生成复用同一口令（不作废已登录网页端）', async () => {
    const res = await api.main({ action: 'createBinding' })
    assert.strictEqual(res.reused, true)
    assert.strictEqual(res.code, code)
    assert.strictEqual(rows('web_bindings').length, 1)
  })

  await test('getBinding 只回口令，不泄露 token', async () => {
    const res = await api.main({ action: 'getBinding' })
    assert.strictEqual(res.ok, true)
    assert.strictEqual(res.binding.code, code)
    assert.strictEqual(res.binding.token, undefined)
  })

  await test('网页端用错口令绑定失败', async () => {
    const res = await api.main({ action: 'bind', code: 'AAAAAAAA' })
    assert.strictEqual(res.statusCode, 400)
    assert.ok(/口令无效|已过期/.test(bodyOf(res).message))
  })

  await test('口令格式非法直接拒绝', async () => {
    const res = await api.main({ action: 'bind', code: 'abc' })
    assert.strictEqual(res.statusCode, 400)
  })

  await test('网页端用正确口令换到 token', async () => {
    const res = await api.main({ action: 'bind', code: code.toLowerCase() })
    assert.strictEqual(res.statusCode, 200)
    token = bodyOf(res).token
    assert.ok(/^[0-9a-f]{64}$/.test(token), 'token 应为 64 位 hex')
  })

  await test('无 token 调用 listTodos 返回 401', async () => {
    const res = await api.main({ action: 'listTodos', token: '' })
    assert.strictEqual(res.statusCode, 401)
  })

  await test('伪造 token 无法越权', async () => {
    const res = await api.main({ action: 'listTodos', token: 'f'.repeat(64) })
    assert.strictEqual(res.statusCode, 401)
  })

  await test('新建待办：写入 openid/status/三游标/next_remind_at', async () => {
    const res = await api.main({ action: 'insertTodo', token: token, todo: newTodo({ client_token: 'ct-001' }) })
    assert.strictEqual(res.statusCode, 200)
    todoId = bodyOf(res).id
    const row = rows('todos')[0]
    assert.strictEqual(row.openid, CURRENT_OPENID)
    assert.strictEqual(row.status, 'active')
    assert.ok(row.last_pushed_at && row.last_logged_at && row.last_reminded_at, '三游标缺失')
    assert.ok(row.next_remind_at, 'next_remind_at 未计算')
    assert.strictEqual(row.client_token, 'ct-001')
    assert.strictEqual(row.created_from, 'web')
  })

  await test('字段白名单：网页端传的非法字段不会落库', async () => {
    await api.main({
      action: 'insertTodo', token: token,
      todo: newTodo({ client_token: 'ct-002', evil_field: 'x', openid: 'hacker' }),
    })
    const row = rows('todos').find((r) => r.client_token === 'ct-002')
    assert.strictEqual(row.evil_field, undefined)
    assert.strictEqual(row.openid, CURRENT_OPENID, 'openid 不能被网页端伪造')
  })

  await test('同 client_token 重复提交幂等（不新增记录）', async () => {
    const before = rows('todos').length
    const res = await api.main({ action: 'insertTodo', token: token, todo: newTodo({ client_token: 'ct-001' }) })
    assert.strictEqual(bodyOf(res).duplicated, true)
    assert.strictEqual(rows('todos').length, before)
  })

  await test('非法 remind_at 被拒绝', async () => {
    const res = await api.main({ action: 'insertTodo', token: token, todo: newTodo({ remind_at: 'not-a-date' }) })
    assert.strictEqual(res.statusCode, 400)
  })

  await test('缺标题被拒绝', async () => {
    const res = await api.main({ action: 'insertTodo', token: token, todo: newTodo({ title: '' }) })
    assert.strictEqual(res.statusCode, 400)
  })

  await test('listTodos 返回带 id 的记录', async () => {
    const res = await api.main({ action: 'listTodos', token: token })
    const list = bodyOf(res).todos
    assert.ok(list.length >= 2)
    assert.ok(list.every((t) => !!t.id))
  })

  await test('标记完成：部分 patch 不覆盖标题、不动下次提醒', async () => {
    const before = rows('todos').find((r) => r._id === todoId)
    const res = await api.main({
      action: 'updateTodo', token: token, id: todoId,
      patch: { status: 'done', done_at: new Date().toISOString() },
    })
    assert.strictEqual(res.statusCode, 200)
    const after = rows('todos').find((r) => r._id === todoId)
    assert.strictEqual(after.status, 'done')
    assert.strictEqual(after.title, '网页端测试待办', '标题被清空了')
    assert.strictEqual(after.next_remind_at, before.next_remind_at, '完成动作不该重算下次提醒')
    assert.strictEqual(after.last_pushed_at, before.last_pushed_at, '完成动作不该重置游标')
  })

  await test('改首次提醒时间会重置三游标并重算下次提醒', async () => {
    const before = rows('todos').find((r) => r._id === todoId)
    // 人为放一个旧游标，避免「同一毫秒内生成的 ISO 字符串相同」干扰断言
    const OLD = '2020-01-01T00:00:00.000Z'
    before.last_pushed_at = OLD
    before.last_logged_at = OLD
    before.last_reminded_at = OLD
    const oldNext = before.next_remind_at
    const newAt = new Date(Date.now() + 7200000).toISOString()
    const res = await api.main({
      action: 'updateTodo', token: token, id: todoId,
      patch: { remind_at: newAt, title: '改了标题' },
    })
    assert.strictEqual(res.statusCode, 200)
    const after = rows('todos').find((r) => r._id === todoId)
    assert.strictEqual(after.remind_at, newAt)
    assert.strictEqual(after.title, '改了标题')
    assert.notStrictEqual(after.last_pushed_at, OLD, 'last_pushed_at 未重置')
    assert.notStrictEqual(after.last_logged_at, OLD, 'last_logged_at 未重置')
    assert.notStrictEqual(after.last_reminded_at, OLD, 'last_reminded_at 未重置')
    assert.notStrictEqual(after.next_remind_at, oldNext, '下次提醒未重算')
  })

  await test('改别人的待办 id 返回 404', async () => {
    const res = await api.main({ action: 'updateTodo', token: token, id: 'notexist999', patch: { title: 'x' } })
    assert.strictEqual(res.statusCode, 404)
  })

  await test('stats 返回总数与进行中数量', async () => {
    const res = await api.main({ action: 'stats', token: token })
    const c = bodyOf(res).counts
    assert.strictEqual(c.total, rows('todos').length)
    assert.ok(typeof c.active === 'number')
  })

  await test('删除待办成功', async () => {
    const res = await api.main({ action: 'removeTodo', token: token, id: todoId })
    assert.strictEqual(res.statusCode, 200)
    assert.ok(!rows('todos').find((r) => r._id === todoId))
  })

  await test('删除不存在的 id 返回 404', async () => {
    const res = await api.main({ action: 'removeTodo', token: token, id: 'notexist999' })
    assert.strictEqual(res.statusCode, 404)
  })

  await test('小程序端作废口令后，旧 token 立即失效', async () => {
    const res = await api.main({ action: 'revokeBinding' })
    assert.strictEqual(res.ok, true)
    const after = await api.main({ action: 'listTodos', token: token })
    assert.strictEqual(after.statusCode, 401)
  })

  await test('作废后可重新生成新口令', async () => {
    const res = await api.main({ action: 'createBinding' })
    assert.strictEqual(res.ok, true)
    assert.notStrictEqual(res.reused, true)
    const bindRes = await api.main({ action: 'bind', code: res.code })
    assert.strictEqual(bindRes.statusCode, 200)
    assert.notStrictEqual(bodyOf(bindRes).token, token)
  })

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败')
  if (failed) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
