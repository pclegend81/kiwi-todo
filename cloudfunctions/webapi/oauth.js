/**
 * KIWI待办 · 第三方账号登录适配器（webapi 云函数侧）
 *
 * 设计要点：
 *  1. 五个平台（GitHub / Google / Apple / X / 微信开放平台网页应用）各自只暴露
 *     「拼授权 URL」「换 token」「取平台唯一用户 ID」三件事，彼此互不影响；
 *  2. **凭证全部来自云函数环境变量**，一个都没配的平台自动 disabled，
 *     网页端拿到的 providers 列表里就不会出现它 —— 不留点了没反应的假按钮；
 *  3. state 用 HMAC-SHA256 签名并绑定 provider + 回调地址 + 时间戳（10 分钟），
 *     防 CSRF / 回调串号；X、Google 强制 PKCE，verifier 由服务端生成、回调时校验；
 *  4. Apple 的 client_secret 是本地用 p8 私钥签的 ES256 JWT，不引入第三方库；
 *  5. 平台若变更 endpoint，只需改下面 PROVIDERS 表里的常量。
 *
 * 注意：这里的「微信」指微信开放平台「网站应用」网页扫码登录，拿的是开放平台
 * openid / unionid；与小程序 wx.login 的 openid 不是同一个值，所以仍需通过
 * 「同步口令」把网页身份与小程序数据合并（见 index.js 的 linkWechat）。
 */
const crypto = require('crypto')

/** 各平台的端点与所需环境变量。env 里的名字只用于展示「还缺什么」，不含任何值 */
const PROVIDERS = [
  {
    id: 'github', name: 'GitHub',
    env: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
    authorize: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    profileUrl: 'https://api.github.com/user',
    scope: 'read:user user:email',
    pkce: false,
  },
  {
    id: 'google', name: 'Google',
    env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    profileUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    pkce: true,
  },
  {
    id: 'apple', name: 'Apple',
    env: ['APPLE_CLIENT_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY'],
    authorize: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    profileUrl: '', // Apple 的用户标识直接在 id_token 里，无需额外请求
    scope: '',      // 不带 scope 才能用 response_mode=query 回落到静态回调页
    pkce: false,
  },
  {
    id: 'x', name: 'X',
    env: ['X_CLIENT_ID', 'X_CLIENT_SECRET'],
    authorize: 'https://x.com/i/oauth2/authorize',
    tokenUrl: 'https://api.x.com/2/oauth2/token',
    profileUrl: 'https://api.x.com/2/users/me',
    scope: 'tweet.read users.read offline.access',
    pkce: true,     // X 强制 PKCE（S256），不接受 plain
  },
  {
    id: 'wechat', name: '微信',
    env: ['WECHAT_WEB_APPID', 'WECHAT_WEB_SECRET'],
    authorize: 'https://open.weixin.qq.com/connect/qrconnect',
    tokenUrl: 'https://api.weixin.qq.com/sns/oauth2/access_token',
    profileUrl: 'https://api.weixin.qq.com/sns/userinfo',
    scope: 'snsapi_login',
    pkce: false,
  },
]

const STATE_TTL_MS = 10 * 60000

function findProvider(id) {
  const key = String(id || '').toLowerCase()
  for (let i = 0; i < PROVIDERS.length; i++) {
    if (PROVIDERS[i].id === key) return PROVIDERS[i]
  }
  return null
}

/** 读平台凭证；缺任意一个返回 null（该平台即视为未接入） */
function configFor(p) {
  const v = Object.create(null)
  const missing = []
  for (let i = 0; i < p.env.length; i++) {
    const name = p.env[i]
    const val = process.env[name]
    if (!val) missing.push(name)
    v[name] = val || ''
  }
  if (missing.length) return { missing: missing, cfg: null }
  const cfg = {
    clientId: v[p.env[0]],
    clientSecret: v[p.env[1]] || '',
    teamId: v.APPLE_TEAM_ID || '',
    keyId: v.APPLE_KEY_ID || '',
    privateKey: v.APPLE_PRIVATE_KEY || '',
  }
  return { missing: [], cfg: cfg }
}

/** 网页端据此渲染按钮：未配置的平台不出现，但折叠清单里能看到「还缺哪些变量」 */
function listProviders() {
  return PROVIDERS.map(function (p) {
    const r = configFor(p)
    return {
      id: p.id,
      name: p.name,
      enabled: !!r.cfg,
      pkce: p.pkce,
      missing: r.missing,
    }
  })
}

/**
 * state 签名密钥：正式部署建议单独配 OAUTH_STATE_SECRET。
 * 未配置时从云环境自带变量派生一个稳定值，保证多实例校验一致（框架阶段开箱可用）。
 */
function stateSecret() {
  if (process.env.OAUTH_STATE_SECRET) return process.env.OAUTH_STATE_SECRET
  const seed = 'kiwi|oauth|state|' + (process.env.WX_APPID || process.env.TCB_ENV || 'kiwi-local')
  return crypto.createHash('sha256').update(seed).digest('hex')
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url')
}

function signState(payload) {
  const body = b64url(JSON.stringify(payload))
  const sig = crypto.createHmac('sha256', stateSecret()).update(body).digest('base64url')
  return body + '.' + sig
}

/** 校验 state：签名、provider、回调地址、时效。失败抛 Error */
function verifyState(raw, provider, redirectUri) {
  const s = String(raw || '')
  const parts = s.split('.')
  if (parts.length !== 2) throw new Error('登录状态无效，请重新发起登录')
  const expected = crypto.createHmac('sha256', stateSecret()).update(parts[0]).digest()
  let actual
  try { actual = Buffer.from(parts[1], 'base64url') } catch (e) {
    throw new Error('登录状态无效，请重新发起登录')
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error('登录状态校验失败，请重新发起登录')
  }
  let payload
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) } catch (e) {
    throw new Error('登录状态已损坏，请重新发起登录')
  }
  if (payload.p !== provider) throw new Error('登录平台与状态不匹配')
  if (payload.r !== redirectUri) throw new Error('回调地址与登录时不一致')
  if (!payload.n) throw new Error('登录状态缺少随机数')
  const age = Date.now() - Number(payload.t || 0)
  if (!Number.isFinite(age) || age > STATE_TTL_MS || age < -60000) {
    throw new Error('登录已超时（10 分钟），请重新发起')
  }
  return payload
}

function makeVerifier() {
  return crypto.randomBytes(32).toString('base64url')
}
function challengeOf(verifier) {
  return crypto.createHash('sha256').update(String(verifier)).digest('base64url')
}

function assertRedirect(redirectUri) {
  const u = String(redirectUri || '')
  let parsed
  try { parsed = new URL(u) } catch (e) { throw new Error('回调地址不合法') }
  const local = parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  if (parsed.protocol !== 'https:' && !local) throw new Error('回调地址必须是 HTTPS')
  return u
}

/**
 * 生成授权跳转 URL。
 * @returns { url, state, verifier, provider } —— state / verifier 由网页端暂存，
 *          回调页再原样传回 oauthCallback；服务端不落库，天然无状态。
 */
function start(providerId, redirectUri) {
  const p = findProvider(providerId)
  if (!p) throw new Error('不支持的登录平台')
  const r = configFor(p)
  if (!r.cfg) throw new Error(p.name + ' 尚未配置凭证（缺 ' + r.missing.join(', ') + '）')
  const redirect = assertRedirect(redirectUri)
  const verifier = p.pkce ? makeVerifier() : ''
  const challenge = verifier ? challengeOf(verifier) : ''
  const state = signState({
    p: p.id,
    n: crypto.randomBytes(16).toString('hex'),
    t: Date.now(),
    r: redirect,
    c: challenge,
  })

  const q = new URLSearchParams()
  q.set('response_type', 'code')
  q.set(p.id === 'wechat' ? 'appid' : 'client_id', r.cfg.clientId)
  q.set('redirect_uri', redirect)
  q.set('state', state)
  if (p.scope) q.set('scope', p.scope)
  if (p.id === 'apple') q.set('response_mode', 'query')
  if (p.id === 'google') {
    q.set('access_type', 'online')
    q.set('include_granted_scopes', 'true')
  }
  if (challenge) {
    q.set('code_challenge', challenge)
    q.set('code_challenge_method', 'S256')
  }
  let url = p.authorize + '?' + q.toString()
  // 微信 qrconnect 要求 URL 末尾带 #wechat_redirect
  if (p.id === 'wechat') url += '#wechat_redirect'
  return { url: url, state: state, verifier: verifier, provider: p.id }
}

/* ── HTTP 小工具：云函数 Node 18+ 内置 fetch；测试里可整体替换 globalThis.fetch ── */

function parseBody(text) {
  try { return JSON.parse(text) } catch (e) { /* 继续按表单解析 */ }
  const out = Object.create(null)
  try {
    new URLSearchParams(String(text)).forEach(function (v, k) { out[k] = v })
  } catch (e) { /* 忽略 */ }
  return out
}

async function postForm(url, form, headers) {
  const res = await globalThis.fetch(url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, headers || {}),
    body: new URLSearchParams(form).toString(),
  })
  const text = await res.text()
  const data = parseBody(text)
  if (!res.ok) throw new Error('平台返回 HTTP ' + res.status + '：' + String(text).slice(0, 120))
  if (data.error || data.errcode) {
    throw new Error('平台拒绝授权：' + (data.error_description || data.errmsg || data.error || data.errcode))
  }
  return data
}

async function getJson(url, headers) {
  const res = await globalThis.fetch(url, { method: 'GET', headers: headers || {} })
  const text = await res.text()
  const data = parseBody(text)
  if (!res.ok) throw new Error('平台返回 HTTP ' + res.status + '：' + String(text).slice(0, 120))
  if (data.errcode) throw new Error('平台拒绝：' + (data.errmsg || data.errcode))
  return data
}

/** Apple 的 client_secret：用 p8 私钥现签一个 1 小时有效的 ES256 JWT */
function appleClientSecret(cfg) {
  const now = Math.floor(Date.now() / 1000)
  const enc = function (o) { return b64url(JSON.stringify(o)) }
  const input = enc({ alg: 'ES256', kid: cfg.keyId, typ: 'JWT' }) + '.' + enc({
    iss: cfg.teamId,
    iat: now,
    exp: now + 3600,
    aud: 'https://appleid.apple.com',
    sub: cfg.clientId,
  })
  const pem = String(cfg.privateKey).replace(/\\n/g, '\n')
  const key = crypto.createPrivateKey(pem)
  const sig = crypto.sign('SHA256', Buffer.from(input), { key: key, dsaEncoding: 'ieee-p1363' })
  return input + '.' + sig.toString('base64url')
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.')
  if (parts.length < 2) throw new Error('id_token 格式不合法')
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
}

/** 换 token，返回 { accessToken, idToken, raw } */
async function exchange(p, cfg, code, verifier, redirect) {
  const common = {
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: redirect,
  }
  if (p.id === 'github') {
    const data = await postForm(p.tokenUrl, Object.assign({}, common, {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }), { 'Accept': 'application/json' })
    return { accessToken: data.access_token || '', idToken: '', raw: data }
  }
  if (p.id === 'google') {
    const data = await postForm(p.tokenUrl, Object.assign({}, common, {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code_verifier: verifier,
    }))
    return { accessToken: data.access_token || '', idToken: data.id_token || '', raw: data }
  }
  if (p.id === 'apple') {
    const data = await postForm(p.tokenUrl, Object.assign({}, common, {
      client_id: cfg.clientId,
      client_secret: appleClientSecret(cfg),
    }))
    return { accessToken: data.access_token || '', idToken: data.id_token || '', raw: data }
  }
  if (p.id === 'x') {
    const basic = Buffer.from(cfg.clientId + ':' + cfg.clientSecret).toString('base64')
    const data = await postForm(p.tokenUrl, Object.assign({}, common, {
      code_verifier: verifier,
      client_id: cfg.clientId,
    }), { 'Authorization': 'Basic ' + basic })
    return { accessToken: data.access_token || '', idToken: '', raw: data }
  }
  // 微信开放平台：token 接口是 GET，参数走 query
  const q = new URLSearchParams({
    appid: cfg.clientId,
    secret: cfg.clientSecret,
    code: code,
    grant_type: 'authorization_code',
  })
  const data = await getJson(p.tokenUrl + '?' + q.toString())
  return { accessToken: data.access_token || '', idToken: '', raw: data }
}

/** 取平台内唯一且稳定的用户标识（不要用昵称/邮箱当主键，它们会变） */
async function fetchIdentity(p, cfg, tokens) {
  if (p.id === 'github') {
    const d = await getJson(p.profileUrl, {
      'Authorization': 'Bearer ' + tokens.accessToken,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'kiwi-todo',
    })
    if (!d.id) throw new Error('GitHub 未返回用户 ID')
    return { subject: String(d.id), name: d.login || '', email: d.email || '' }
  }
  if (p.id === 'google') {
    const d = await getJson(p.profileUrl, { 'Authorization': 'Bearer ' + tokens.accessToken })
    if (!d.sub) throw new Error('Google 未返回用户标识')
    return { subject: String(d.sub), name: d.name || '', email: d.email || '' }
  }
  if (p.id === 'apple') {
    if (!tokens.idToken) throw new Error('Apple 未返回 id_token')
    const d = decodeJwtPayload(tokens.idToken)
    if (!d.sub) throw new Error('Apple id_token 缺少 sub')
    return { subject: String(d.sub), name: '', email: d.email || '' }
  }
  if (p.id === 'x') {
    const d = await getJson(p.profileUrl, { 'Authorization': 'Bearer ' + tokens.accessToken })
    if (!d.data || !d.data.id) throw new Error('X 未返回用户 ID')
    return { subject: String(d.data.id), name: (d.data.username || ''), email: '' }
  }
  // 微信：unionid 优先（同一开放平台账号下跨应用稳定），否则退回 openid
  const subject = String(tokens.raw.unionid || tokens.raw.openid || '')
  if (!subject) throw new Error('微信未返回用户标识')
  let name = ''
  if (tokens.raw.openid && tokens.accessToken) {
    try {
      const q = new URLSearchParams({
        access_token: tokens.accessToken,
        openid: tokens.raw.openid,
        lang: 'zh_CN',
      })
      const d = await getJson(p.profileUrl + '?' + q.toString())
      name = d.nickname || ''
    } catch (e) { /* 昵称取不到不影响登录 */ }
  }
  return { subject: subject, name: name, email: '' }
}

/**
 * 授权回调：校验 state/PKCE -> 换 token -> 取平台唯一 ID。
 * @returns { provider, subject, name, email }
 */
async function callback(input) {
  const src = input || {}
  const p = findProvider(src.provider)
  if (!p) throw new Error('不支持的登录平台')
  const r = configFor(p)
  if (!r.cfg) throw new Error(p.name + ' 尚未配置凭证')
  const redirect = assertRedirect(src.redirectUri)
  const payload = verifyState(src.state, p.id, redirect)
  const code = String(src.code || '')
  if (!code) throw new Error('缺少授权码')
  if (p.pkce) {
    const verifier = String(src.verifier || '')
    if (!verifier || challengeOf(verifier) !== payload.c) {
      throw new Error('PKCE 校验失败，请重新发起登录')
    }
  }
  const tokens = await exchange(p, r.cfg, code, String(src.verifier || ''), redirect)
  if (!tokens.accessToken && !tokens.idToken) throw new Error('平台未返回访问令牌')
  const who = await fetchIdentity(p, r.cfg, tokens)
  return {
    provider: p.id,
    subject: who.subject,
    name: who.name,
    email: who.email,
  }
}

module.exports = {
  PROVIDERS: PROVIDERS,
  listProviders: listProviders,
  start: start,
  callback: callback,
  // 下面几个仅供测试与排错使用
  _internal: {
    configFor: configFor,
    signState: signState,
    verifyState: verifyState,
    challengeOf: challengeOf,
    appleClientSecret: appleClientSecret,
    decodeJwtPayload: decodeJwtPayload,
  },
}
