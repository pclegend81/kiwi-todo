/**
 * 第三方账号登录全链路测试（内存 mock 云数据库 + mock 平台 HTTP 响应）
 *
 * 覆盖：八个平台凭证探测 / 授权 URL / HMAC state 防串号防过期 / X+Google PKCE /
 *       八个平台回调取唯一 subject（含 LINE/Kakao/Naver 当地社交登录）/
 *       users+identities 账号建立与复用 /
 *       未关联小程序时 CRUD 拦截 409 NEED_LINK / 口令合并 openid /
 *       多个第三方账号收敛到同一微信 / 隐私与越权 / 老口令路径不受影响。
 * 运行：node tests/oauth.js
 */
const Module = require('module')
const assert = require('assert')
const path = require('path')
const crypto = require('crypto')

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
    } else if (row[k] !== c) return false
  }
  return true
}
function pick(list, q, limit) {
  return list.filter((r) => match(r, q)).slice(0, limit || 100)
    .map((r) => Object.assign({}, r))
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

const WX_OPENID = 'wx-miniprogram-openid-001'
const cloudMock = {
  DYNAMIC_CURRENT_ENV: 'dyn',
  init() {},
  database: () => db,
  getWXContext: () => ({ OPENID: WX_OPENID }),
}

/* ── mock 平台 HTTP 响应 ────────────────────────────────────────────── */
const httpCalls = []
let platformError = null // 设为 { urlPart, status, body } 模拟平台报错

function jsonRes(obj, status) {
  const s = status || 200
  return Promise.resolve({
    ok: s >= 200 && s < 300,
    status: s,
    text: () => Promise.resolve(JSON.stringify(obj)),
  })
}
function jwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return enc({ alg: 'none' }) + '.' + enc(payload) + '.sig'
}

global.fetch = function (url, opts) {
  const u = String(url)
  httpCalls.push({ url: u, opts: opts || {} })
  if (platformError && u.indexOf(platformError.urlPart) >= 0) {
    return jsonRes(platformError.body, platformError.status || 400)
  }
  if (u.indexOf('github.com/login/oauth/access_token') >= 0) {
    return jsonRes({ access_token: 'gh-token' })
  }
  if (u.indexOf('api.github.com/user') >= 0) {
    return jsonRes({ id: 12345, login: 'kiwi-gh', email: 'kiwi@gh.example' })
  }
  if (u.indexOf('oauth2.googleapis.com/token') >= 0) {
    return jsonRes({ access_token: 'g-token', id_token: jwt({ sub: 'ignored' }) })
  }
  if (u.indexOf('openidconnect.googleapis.com/v1/userinfo') >= 0) {
    return jsonRes({ sub: 'google-sub-001', name: 'Kiwi', email: 'kiwi@gmail.example' })
  }
  if (u.indexOf('appleid.apple.com/auth/token') >= 0) {
    return jsonRes({ access_token: 'ap-token', id_token: jwt({ sub: 'apple-sub-001', email: 'a@privaterelay.appleid.com' }) })
  }
  if (u.indexOf('api.x.com/2/oauth2/token') >= 0) {
    return jsonRes({ access_token: 'x-token' })
  }
  if (u.indexOf('api.x.com/2/users/me') >= 0) {
    return jsonRes({ data: { id: '991122', username: 'kiwix' } })
  }
  if (u.indexOf('api.weixin.qq.com/sns/oauth2/access_token') >= 0) {
    return jsonRes({ access_token: 'wx-web-token', openid: 'wx-web-openid', unionid: 'wx-union-001' })
  }
  if (u.indexOf('api.weixin.qq.com/sns/userinfo') >= 0) {
    return jsonRes({ nickname: '微信用户' })
  }
  if (u.indexOf('api.line.me/oauth2/v2.1/token') >= 0) {
    return jsonRes({ access_token: 'line-token', id_token: jwt({ sub: 'line-sub-001' }) })
  }
  if (u.indexOf('api.line.me/oauth2/v2.1/userinfo') >= 0) {
    return jsonRes({ userId: 'U-line-001', displayName: 'Kiwi LINE' })
  }
  if (u.indexOf('kauth.kakao.com/oauth/token') >= 0) {
    return jsonRes({ access_token: 'kakao-token' })
  }
  if (u.indexOf('kapi.kakao.com/v2/user/me') >= 0) {
    return jsonRes({ id: 987654321, kakao_account: { email: 'k@kakao.example', profile: { nickname: '키위' } } })
  }
  if (u.indexOf('nid.naver.com/oauth2.0/token') >= 0) {
    return jsonRes({ access_token: 'naver-token' })
  }
  if (u.indexOf('openapi.naver.com/v1/nid/me') >= 0) {
    return jsonRes({ resultcode: '00', message: 'success', response: { id: 'naver-id-001', nickname: 'Kiwi', email: 'n@naver.example' } })
  }
  return jsonRes({ error: 'unknown_endpoint' }, 404)
}

/* ── 凭证：先全部清空，之后按需注入 ──────────────────────────────────── */
const ENV_KEYS = [
  'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
  'APPLE_CLIENT_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY',
  'X_CLIENT_ID', 'X_CLIENT_SECRET',
  'WECHAT_WEB_APPID', 'WECHAT_WEB_SECRET',
  'LINE_CLIENT_ID', 'LINE_CLIENT_SECRET',
  'KAKAO_CLIENT_ID', 'KAKAO_CLIENT_SECRET',
  'NAVER_CLIENT_ID', 'NAVER_CLIENT_SECRET',
  'OAUTH_STATE_SECRET',
]
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const APPLE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const CREDS = {
  GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret',
  GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret',
  APPLE_CLIENT_ID: 'com.kiwi.web', APPLE_TEAM_ID: 'TEAM123', APPLE_KEY_ID: 'KEY123',
  APPLE_PRIVATE_KEY: APPLE_PEM.replace(/\n/g, '\\n'),
  X_CLIENT_ID: 'x-id', X_CLIENT_SECRET: 'x-secret',
  WECHAT_WEB_APPID: 'wx-web-appid', WECHAT_WEB_SECRET: 'wx-web-secret',
  LINE_CLIENT_ID: 'line-id', LINE_CLIENT_SECRET: 'line-secret',
  KAKAO_CLIENT_ID: 'kakao-id', KAKAO_CLIENT_SECRET: 'kakao-secret',
  NAVER_CLIENT_ID: 'naver-id', NAVER_CLIENT_SECRET: 'naver-secret',
  OAUTH_STATE_SECRET: 'test-state-secret',
}
function clearCreds() { for (const k of ENV_KEYS) delete process.env[k] }
function setCreds() { for (const k of Object.keys(CREDS)) process.env[k] = CREDS[k] }
clearCreds()

// 拦截 wx-server-sdk，其余 require 走真实模块
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return cloudMock
  return origLoad.apply(this, arguments)
}
let api, oauth
try {
  api = require(path.join(__dirname, '..', 'cloudfunctions', 'webapi', 'index.js'))
  oauth = require(path.join(__dirname, '..', 'cloudfunctions', 'webapi', 'oauth.js'))
} finally {
  Module._load = origLoad
}

/* ── 测试框架 ──────────────────────────────────────────────────────── */
let passed = 0
let failed = 0
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed++; console.log('  ✓ ' + name) })
    .catch((e) => { failed++; console.log('  ✗ ' + name + '\n    ' + e.message) })
}
const bodyOf = (res) => JSON.parse(res.body)
const REDIRECT = 'https://kiwi.example.com/oauth-callback.html'
const newTodo = (over) => Object.assign({
  title: '第三方登录创建的待办',
  note: '',
  remind_at: new Date(Date.now() + 3600000).toISOString(),
  repeat_type: 'none',
  repeat_interval: 1,
  skip_holiday: true,
  holiday_action: 'skip',
  priority: 'medium',
  manual_done: false,
}, over || {})

/** 走一遍 oauthStart（返回 state/verifier），再把 code 交给 oauthCallback */
async function login(provider, over) {
  const s = await api.main({ action: 'oauthStart', provider: provider, redirectUri: REDIRECT })
  assert.strictEqual(s.statusCode, 200, 'oauthStart 失败：' + s.body)
  const start = bodyOf(s)
  return api.main(Object.assign({
    action: 'oauthCallback',
    provider: provider,
    code: 'auth-code-' + provider,
    state: start.state,
    verifier: start.verifier,
    redirectUri: REDIRECT,
  }, over || {}))
}

async function main() {
  console.log('第三方账号登录（OAuth）全链路测试')

  await test('凭证未配置时八个平台全部禁用，且列出缺失的变量名', async () => {
    const res = await api.main({ action: 'oauthProviders' })
    const b = bodyOf(res)
    assert.strictEqual(b.providers.length, 0)
    assert.strictEqual(b.all.length, 8)
    assert.ok(b.all.every((p) => !p.enabled && p.missing.length > 0))
    assert.ok(b.all.some((p) => p.id === 'apple' && p.missing.includes('APPLE_PRIVATE_KEY')))
  })

  await test('oauthProviders 不泄露任何凭证值', async () => {
    setCreds()
    const res = await api.main({ action: 'oauthProviders' })
    assert.ok(!res.body.includes('gh-secret'))
    assert.ok(!res.body.includes('x-secret'))
    assert.ok(!res.body.includes('test-state-secret'))
  })

  await test('补齐凭证后八个平台全部启用，regions 字段就位', async () => {
    const b = bodyOf(await api.main({ action: 'oauthProviders' }))
    assert.strictEqual(b.providers.length, 8)
    assert.deepStrictEqual(b.providers.map((p) => p.id).sort(),
      ['apple', 'github', 'google', 'kakao', 'line', 'naver', 'wechat', 'x'])
    const byId = {}
    b.providers.forEach((p) => { byId[p.id] = p })
    assert.deepStrictEqual(byId.line.regions, ['jp'])
    assert.deepStrictEqual(byId.kakao.regions, ['kr'])
    assert.deepStrictEqual(byId.naver.regions, ['kr'])
    assert.deepStrictEqual(byId.wechat.regions, ['cn'])
    assert.deepStrictEqual(byId.github.regions, [])
  })

  await test('未配置的平台发起登录直接被拒绝（不留假按钮的兜底）', async () => {
    clearCreds()
    const res = await api.main({ action: 'oauthStart', provider: 'github', redirectUri: REDIRECT })
    assert.strictEqual(res.statusCode, 400)
    assert.ok(/尚未配置凭证/.test(bodyOf(res).message))
    setCreds()
  })

  await test('GitHub 授权 URL 正确且不带 PKCE', async () => {
    const b = bodyOf(await api.main({ action: 'oauthStart', provider: 'github', redirectUri: REDIRECT }))
    const u = new URL(b.url)
    assert.strictEqual(u.origin + u.pathname, 'https://github.com/login/oauth/authorize')
    assert.strictEqual(u.searchParams.get('client_id'), 'gh-id')
    assert.strictEqual(u.searchParams.get('redirect_uri'), REDIRECT)
    assert.strictEqual(u.searchParams.get('scope'), 'read:user user:email')
    assert.ok(u.searchParams.get('state'))
    assert.ok(!u.searchParams.get('code_challenge'))
    assert.strictEqual(b.verifier, '')
  })

  await test('X 强制 PKCE：challenge = S256(verifier)', async () => {
    const b = bodyOf(await api.main({ action: 'oauthStart', provider: 'x', redirectUri: REDIRECT }))
    const u = new URL(b.url)
    assert.strictEqual(u.origin + u.pathname, 'https://x.com/i/oauth2/authorize')
    assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256')
    assert.ok(b.verifier)
    assert.strictEqual(u.searchParams.get('code_challenge'),
      crypto.createHash('sha256').update(b.verifier).digest('base64url'))
  })

  await test('Apple 用 response_mode=query 且不请求 name/email scope', async () => {
    const u = new URL(bodyOf(await api.main({
      action: 'oauthStart', provider: 'apple', redirectUri: REDIRECT,
    })).url)
    assert.strictEqual(u.searchParams.get('response_mode'), 'query')
    assert.ok(!u.searchParams.get('scope'))
  })

  await test('微信网页登录用 appid + #wechat_redirect', async () => {
    const b = bodyOf(await api.main({ action: 'oauthStart', provider: 'wechat', redirectUri: REDIRECT }))
    assert.ok(b.url.startsWith('https://open.weixin.qq.com/connect/qrconnect?'))
    assert.ok(b.url.includes('appid=wx-web-appid'))
    assert.ok(b.url.endsWith('#wechat_redirect'))
  })

  await test('非 HTTPS 回调地址被拒绝（本地 localhost 除外）', async () => {
    const bad = await api.main({ action: 'oauthStart', provider: 'github', redirectUri: 'http://evil.example.com/cb' })
    assert.strictEqual(bad.statusCode, 400)
    assert.ok(/HTTPS/.test(bodyOf(bad).message))
    const local = await api.main({ action: 'oauthStart', provider: 'github', redirectUri: 'http://127.0.0.1:8765/oauth-callback.html' })
    assert.strictEqual(local.statusCode, 200)
  })

  await test('state 被篡改 / 过期 / 平台串号 / 回调地址不符，全部拒绝', async () => {
    const tampered = await login('github', { state: 'aaa.bbb' })
    assert.strictEqual(tampered.statusCode, 400)

    const expired = oauth._internal.signState({
      p: 'github', n: 'nonce', t: Date.now() - 11 * 60000, r: REDIRECT, c: '',
    })
    const oldRes = await api.main({
      action: 'oauthCallback', provider: 'github', code: 'x',
      state: expired, verifier: '', redirectUri: REDIRECT,
    })
    assert.strictEqual(oldRes.statusCode, 400)
    assert.ok(/超时/.test(bodyOf(oldRes).message))

    const s = bodyOf(await api.main({ action: 'oauthStart', provider: 'github', redirectUri: REDIRECT }))
    const cross = await api.main({
      action: 'oauthCallback', provider: 'x', code: 'x',
      state: s.state, verifier: 'whatever', redirectUri: REDIRECT,
    })
    assert.strictEqual(cross.statusCode, 400)
    assert.ok(/不匹配/.test(bodyOf(cross).message))

    const mismatch = await api.main({
      action: 'oauthCallback', provider: 'github', code: 'x',
      state: s.state, verifier: '', redirectUri: REDIRECT + '?x=1',
    })
    assert.strictEqual(mismatch.statusCode, 400)
    assert.ok(/回调地址/.test(bodyOf(mismatch).message))
  })

  await test('X 回调传错 PKCE verifier 被拒绝', async () => {
    const s = bodyOf(await api.main({ action: 'oauthStart', provider: 'x', redirectUri: REDIRECT }))
    const res = await api.main({
      action: 'oauthCallback', provider: 'x', code: 'x',
      state: s.state, verifier: 'wrong-verifier', redirectUri: REDIRECT,
    })
    assert.strictEqual(res.statusCode, 400)
    assert.ok(/PKCE/.test(bodyOf(res).message))
  })

  await test('平台返回错误码时登录失败且不落库', async () => {
    platformError = { urlPart: 'github.com/login/oauth/access_token', status: 400, body: { error: 'bad_verification_code' } }
    const before = rows('users').length
    const res = await login('github')
    platformError = null
    assert.strictEqual(res.statusCode, 400)
    assert.strictEqual(rows('users').length, before)
  })

  // ---------- 全平台回调 ----------
  const expectedSubjects = {
    github: '12345', google: 'google-sub-001', apple: 'apple-sub-001',
    x: '991122', wechat: 'wx-union-001',
    line: 'line-sub-001', kakao: '987654321', naver: 'naver-id-001',
  }
  const oauthTokens = {}
  for (const p of Object.keys(expectedSubjects)) {
    await test(p + ' 回调成功：建立 users / identities / web_bindings', async () => {
      const res = await login(p)
      assert.strictEqual(res.statusCode, 200, res.body)
      const b = bodyOf(res)
      assert.ok(/^[0-9a-f]{64}$/.test(b.token))
      assert.strictEqual(b.linked, false)
      assert.strictEqual(b.needsLink, true)
      assert.ok(!('email' in b), '不应把邮箱返回到浏览器')
      oauthTokens[p] = b.token
      const id = rows('identities').find((r) => r.provider === p)
      assert.ok(id, '未建立 identity')
      assert.strictEqual(id.subject, expectedSubjects[p])
      assert.strictEqual(rows('users').find((u) => u.kiwi_uid === id.kiwi_uid).openid, '')
      const binding = rows('web_bindings').find((r) => r.token === b.token)
      assert.strictEqual(binding.login, 'oauth')
      assert.strictEqual(binding.openid, '', '未关联前 openid 必须为空')
    })
  }

  await test('未关联小程序时 listTodos / insertTodo / stats 一律 409 NEED_LINK', async () => {
    const t = oauthTokens.github
    const list = await api.main({ action: 'listTodos', token: t })
    assert.strictEqual(list.statusCode, 409)
    assert.strictEqual(bodyOf(list).code, 'NEED_LINK')
    const ins = await api.main({ action: 'insertTodo', token: t, todo: newTodo() })
    assert.strictEqual(ins.statusCode, 409)
    assert.strictEqual(rows('todos').length, 0, '未关联却写入了 todos')
    const st = await api.main({ action: 'stats', token: t })
    assert.strictEqual(st.statusCode, 409)
  })

  await test('accountInfo 显示未关联与登录平台', async () => {
    const b = bodyOf(await api.main({ action: 'accountInfo', token: oauthTokens.github }))
    assert.strictEqual(b.linked, false)
    assert.strictEqual(b.provider, 'github')
    assert.ok(b.identities.some((i) => i.provider === 'github'))
  })

  await test('伪造 token 无法读取账号信息', async () => {
    const res = await api.main({ action: 'accountInfo', token: 'a'.repeat(64) })
    assert.strictEqual(res.statusCode, 401)
  })

  await test('小程序生成 8 位口令，供第三方账号关联', async () => {
    const res = await api.main({ action: 'createBinding' })
    assert.strictEqual(res.ok, true)
    global.__code = res.code
  })

  await test('linkWechat 拒绝错口令 / 非法格式，且不影响会话', async () => {
    const bad = await api.main({ action: 'linkWechat', token: oauthTokens.github, code: 'AAAAAAAA' })
    assert.strictEqual(bad.statusCode, 400)
    const malformed = await api.main({ action: 'linkWechat', token: oauthTokens.github, code: 'abc' })
    assert.strictEqual(malformed.statusCode, 400)
    const info = bodyOf(await api.main({ action: 'accountInfo', token: oauthTokens.github }))
    assert.strictEqual(info.linked, false)
  })

  await test('GitHub 账号用口令关联后拿到小程序 openid', async () => {
    const res = await api.main({ action: 'linkWechat', token: oauthTokens.github, code: global.__code })
    assert.strictEqual(res.statusCode, 200, res.body)
    assert.strictEqual(bodyOf(res).openid, WX_OPENID)
    const binding = rows('web_bindings').find((r) => r.token === oauthTokens.github)
    assert.strictEqual(binding.openid, WX_OPENID)
    assert.ok(rows('identities').some((r) => r.provider === 'wechat_miniprogram' && r.subject === WX_OPENID))
  })

  await test('关联后写待办：openid / status / 三游标与小程序完全同构', async () => {
    const res = await api.main({
      action: 'insertTodo', token: oauthTokens.github,
      todo: newTodo({ client_token: 'oauth-ct-001' }),
    })
    assert.strictEqual(res.statusCode, 200, res.body)
    const row = rows('todos').find((r) => r.client_token === 'oauth-ct-001')
    assert.strictEqual(row.openid, WX_OPENID, 'pusher 按 openid 扫描，必须写小程序 openid')
    assert.strictEqual(row.status, 'active')
    assert.ok(row.last_pushed_at && row.last_logged_at && row.last_reminded_at)
    assert.ok(row.next_remind_at)
  })

  await test('关联后 listTodos / stats 正常，且小程序口令会话看到同一份数据', async () => {
    const list = bodyOf(await api.main({ action: 'listTodos', token: oauthTokens.github }))
    assert.ok(list.todos.length >= 1)
    const bindRes = await api.main({ action: 'bind', code: global.__code })
    assert.strictEqual(bindRes.statusCode, 200)
    const viaCode = bodyOf(await api.main({ action: 'listTodos', token: bodyOf(bindRes).token }))
    assert.strictEqual(viaCode.todos.length, list.todos.length, '两条路径应看到同一份 todos')
  })

  await test('同一 GitHub 账号再次登录复用 kiwi_uid，并直接显示为已关联', async () => {
    const before = rows('identities').filter((r) => r.provider === 'github').length
    const res = await login('github')
    assert.strictEqual(res.statusCode, 200, res.body)
    assert.strictEqual(bodyOf(res).linked, true)
    assert.strictEqual(bodyOf(res).needsLink, false)
    assert.strictEqual(rows('identities').filter((r) => r.provider === 'github').length, before)
    const b = bodyOf(await api.main({ action: 'listTodos', token: bodyOf(res).token }))
    assert.ok(b.todos.length >= 1, '新会话应直接能读到数据')
  })

  await test('X 账号用同一个微信口令关联时，收敛到同一个 kiwi_uid', async () => {
    const githubUid = rows('identities').find((r) => r.provider === 'github').kiwi_uid
    const res = await api.main({ action: 'linkWechat', token: oauthTokens.x, code: global.__code })
    assert.strictEqual(res.statusCode, 200, res.body)
    const xUid = rows('identities').find((r) => r.provider === 'x').kiwi_uid
    assert.strictEqual(xUid, githubUid, '两个第三方账号应合并到同一个用户')
    assert.strictEqual(rows('web_bindings').find((r) => r.token === oauthTokens.x).kiwi_uid, githubUid)
    const viaX = bodyOf(await api.main({ action: 'listTodos', token: oauthTokens.x }))
    assert.ok(viaX.todos.length >= 1, 'X 账号应看到同一份 todos')
  })

  await test('accountInfo 合并后列出多个身份', async () => {
    const b = bodyOf(await api.main({ action: 'accountInfo', token: oauthTokens.x }))
    assert.strictEqual(b.linked, true)
    const names = b.identities.map((i) => i.provider)
    assert.ok(names.includes('x') && names.includes('wechat_miniprogram'))
  })

  await test('Apple client_secret 是可用 EC 私钥签出的三段 JWT', () => {
    const cfg = {
      clientId: 'com.kiwi.web', teamId: 'TEAM123', keyId: 'KEY123',
      privateKey: APPLE_PEM.replace(/\n/g, '\\n'),
    }
    const token = oauth._internal.appleClientSecret(cfg)
    const parts = token.split('.')
    assert.strictEqual(parts.length, 3)
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    assert.strictEqual(header.alg, 'ES256')
    assert.strictEqual(payload.iss, 'TEAM123')
    assert.strictEqual(payload.sub, 'com.kiwi.web')
    assert.ok(payload.exp > payload.iat)
  })

  await test('linkWechat 按口令锁定 5 次，且不误伤正确口令；Apple 账号随之合并', async () => {
    const t = oauthTokens.apple
    let last = null
    for (let i = 0; i < 6; i++) {
      last = await api.main({ action: 'linkWechat', token: t, code: 'BBBBBBBB' })
    }
    assert.strictEqual(last.statusCode, 429)
    const ok = await api.main({ action: 'linkWechat', token: t, code: global.__code })
    assert.strictEqual(ok.statusCode, 200, ok.body)
    const appleUid = rows('identities').find((r) => r.provider === 'apple').kiwi_uid
    const githubUid = rows('identities').find((r) => r.provider === 'github').kiwi_uid
    assert.strictEqual(appleUid, githubUid, '第三个第三方账号也应收敛到同一用户')
  })

  await test('未知登录平台被拒绝', async () => {
    const res = await api.main({ action: 'oauthStart', provider: 'evil', redirectUri: REDIRECT })
    assert.strictEqual(res.statusCode, 400)
    const cb = await api.main({ action: 'oauthCallback', provider: 'evil', redirectUri: REDIRECT })
    assert.strictEqual(cb.statusCode, 400)
  })

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败')
  if (failed) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
