# KIWI待办 · 多端同步部署指南（PC / 安卓 / iOS）

> 目标：一套 Web/PWA 代码覆盖电脑、安卓、苹果三个端，**与微信小程序共用同一个微信云开发后台**，
> 任意一端新建/编辑/完成/删除待办，其余端自动同步（网页端 20 秒轮询，小程序端进页面即拉云端）。
>
> 真实的后台只有一个，不需要为三个端分别搭服务。本指南只需做**一次**云端配置，
> 三个版本指向同一个接口地址即可互相同步。

---

## 0. 先理解架构（很重要）

```
微信小程序 ─┐
PC 浏览器   ─┼─→ 微信云开发 todos 集合（同一份数据）
安卓 PWA    ─┤        ▲
iOS PWA     ─┘        │
                 webapi 云函数（HTTP 访问服务 /webapi）
                        │
       小程序端 callFunction 走微信 openid 生成「同步口令」
       网页端两条登录路径，最终都汇聚到同一个 openid：
         A. 8 位同步口令 → token → openid（最直接）
         B. 第三方 OAuth → users/identities → kiwi_uid → token
            └ 首次填一次同步口令，把 openid 合并进 kiwi_uid
```

- **身份打通**：小程序「我的」页生成 8 位同步口令（`web_bindings` 集合里存 openid + token），
  网页端输入口令换到 token，token 存在该设备 localStorage，30 天有效。
- **提醒不丢**：网页端写入的待办与小程序 `edit.js` 保存的字段完全同构（`remind_at` /
  `status:'active'` / `openid` / 三个游标 / `next_remind_at`），因此 **pusher 云函数照常扫描并下发微信订阅消息**。
  网页端不需要也不能替代微信订阅消息。
- **五份 `reminder-core.js` 必须保持 md5 一致**（`utils/` + `pusher/` + `pushapi/` + `webapi/` + `webapp/`），
  `tests/webapp.js` 会校验。

---

## A. 云数据库：新建 3 个集合

在微信开发者工具 → 云开发 → 数据库，新建以下集合（名字固定，代码里写死了）：

| 集合 | 用途 | 不建会怎样 |
|---|---|---|
| `web_bindings` | 口令 / token / OAuth 会话 | 网页端完全无法登录 |
| `users` | 统一用户 `kiwi_uid` 与其合并后的 `openid` | 第三方账号登录后无法关联小程序 |
| `identities` | 平台 + 平台内唯一 ID → `kiwi_uid` | 第三方账号每次登录都被当成新用户 |

**三个集合权限都务必选「仅管理端可读写」**。

> ⚠️ `web_bindings` 里存的是 token，`identities` 里存平台用户 ID，公开可读等于账号可被冒用。
> 小程序端从不直接读写这三个集合，全部通过 `webapi` 云函数（管理员权限）访问，
> 所以最严格的权限完全不影响功能。

其余集合（`todos` / `remind_logs` / `holidays` / `push_devices`）保持原样，不用改。
只打算用同步口令、暂不接第三方登录时，后两个集合可以先不建（登录页不会出现第三方按钮）。

---

## B. 部署 `webapi` 云函数

1. 在微信开发者工具里，右键 `cloudfunctions/webapi` → **「上传并部署：云端安装依赖」**。
   > 注意：这和 `pusher/config.json` 的触发器是两回事。webapi 走 **HTTP 访问服务**，
   > 不需要 `config.json`，也不需要上传触发器。
2. 部署完成后可在云函数日志里看到 `webapi 版本 2026-11-13b`（未知 action 的报错尾巴会带这个号）。

---

## C. 开通 HTTP 访问服务（网页端唯一的入口）

在 **云开发控制台 → 设置 / 更多 → HTTP 访问服务**（微信开发者工具「云开发」面板里也能找到）：

1. 开通 HTTP 访问服务（首次开通需要等 1–3 分钟生效）。
2. 新建一条路由：
   - 路径：`/webapi`
   - 目标：云函数 `webapi`
   - **请求方法：勾选 POST 和 OPTIONS**（OPTIONS 是浏览器跨域预检，必须放行）
   - 如界面有「**集成响应**」开关，**打开它**（webapi 返回的是 `{statusCode, headers, body}` 结构）。
3. 记下完整地址，形如：

   ```
   https://<你的环境ID>.service.tcloudbase.com/webapi
   ```

4. 验证：浏览器控制台执行
   ```js
   fetch('https://<环境ID>.service.tcloudbase.com/webapi', {
     method: 'POST', headers: {'Content-Type':'application/json'},
     body: JSON.stringify({action:'no-such-action'})
   }).then(r => r.text()).then(console.log)
   ```
   能看到含 `webapi 版本 2026-11-13b` 的 JSON 就说明通了。

> **没开「集成响应」也能用**：`webapp/app.js` 做了兼容，会自动再解一层 `body`。
> 如果浏览器控制台报 CORS 错误，检查路由是否允许 OPTIONS、集成响应是否开启。

---

## D. 上传网页版（静态托管，一次上传三端共用）

在云开发控制台 → **静态网站托管**，把 `webapp/` 目录里的**全部文件**上传（保持目录结构，
含 `vendor/`、`icon-192.png`、`icon-512.png`、`sw.js`、`manifest.json`、
**`oauth-callback.html`**）。最后这个是第三方登录的回调页，漏传会导致授权后跳到 404。

上传后得到访问地址，形如：

```
https://<你的环境ID>.tcloudbaseapp.com/index.html
```

> 这个地址就是**三个端共用的网址**：
> - **PC**：电脑浏览器直接打开，可存书签；
> - **安卓**：Chrome 打开 → 右上角菜单 →「添加到主屏幕 / 安装应用」；
> - **iOS**：Safari 打开 → 分享按钮 →「添加到主屏幕」。
>
> 装到主屏后是独立窗口、无地址栏，观感与原生 App 一致。
> 三个端（以及多台设备）打开的是同一份代码、同一个后台，天然互相同步。

也可以用 `dist/` 里三个分发包分别上传；它们内容相同，只是附带各自平台的说明文件。

### D2. PC 桌面界面（自适应，无需单独部署）

同一份 `index.html` 用 CSS 媒体查询按窗口宽度切换布局，**不需要部署第二个地址**：

| 窗口宽度 | 界面 |
|---|---|
| ≥ 980px（PC） | 桌面工作台：左侧固定导航栏（视图/计数/新建/同步/下一次提醒）+ 右侧 2～4 列待办卡片网格 + 顶部搜索工具条 + 加宽的两列新建/编辑弹层；未绑定时登录页为左品牌 + 右口令卡分栏 |
| 700–979px（平板） | 720px 居中单列 |
| < 700px（手机 / PWA） | 原有单列窄栏，桌面元素全部隐藏 |

PC 专属能力：标题/备注搜索、侧栏计数与「下一次提醒」、卡片悬停高亮、
快捷键 `N` 新建 / `/` 搜索 / `R` 同步 / `Esc` 关闭 / `Ctrl(⌘)+Enter` 保存、
新建表单新增「需要手工确认完成」开关（与小程序 `manual_done` 字段一致）。

> 改过 `webapp/` 后必须重新跑 `python tools/build_dist.py` 生成三个 zip，
> 并把 `webapp/` 全量重新上传到静态托管；`sw.js` 缓存版本同步 +1 可让老设备清掉旧缓存。

---

## E. 小程序端：重新编译上传

「我的」页新增了「网页 / 电脑端同步」卡片，必须重新编译小程序代码并上传：
1. 微信开发者工具点「编译」，确认「我的」页能看到同步卡片；
2. 上传新版本（提审/体验版均可）。

> ⚠️ 别忘了之前那一轮的关键项：`pusher/config.json` 要单独「上传触发器」，
> 且 `pusher`/`pushapi` 的 `MINIPROGRAM_STATE` 目前是 `'trial'`（体验版）。
> **正式发布后要改回 `'formal'` 并重新部署这两个云函数**，否则正式版用户收不到订阅消息。

---

## F. 首次使用流程（验收清单）

1. 小程序 →「我的」→「网页 / 电脑端同步」→ 点「生成同步口令」→ 8 位口令自动复制到剪贴板。
2. 在 PC / 安卓 / iOS 打开网页版地址：
   - 第一次展开「接口地址设置」，填入 C 步记下的 `/webapi` 完整地址；
   - 输入 8 位口令 → 点「绑定并同步」。
3. 验证互相同步：
   - 网页端点「＋ 新建待办」→ 小程序首页下拉刷新应能看到；
   - 小程序新建/完成一条 → 网页端 20 秒内自动出现（或点「刷新」立即看）；
   - 第二台设备用**同一个口令**绑定，也能看到同一份数据。
4. 验证提醒不丢：网页端建一条 2 分钟后的待办 → 到点应收到**微信订阅消息**（由 pusher 下发，
   前提是用户已授权且订阅额度充足）。
5. 作废：小程序点「作废口令」，所有已绑定网页端立即失效，需重新生成口令。
6. （可选）第三方账号登录：按 **I 节**配好凭证后，登录页会出现对应平台按钮。
   授权回来会显示「关联微信小程序，打通全部待办」引导条，填一次 8 位口令即可；
   之后该账号与小程序读写同一份数据。不同平台账号用**同一个口令**关联，会收敛到同一个账号。

---

## G. 已知限制（说清楚，免得上线后困惑）

| 限制 | 说明 |
|---|---|
| **iOS / 安卓没有真正的后台推送** | PWA 在网页关闭后不能像微信订阅消息那样推送。真正的到点提醒仍由微信订阅消息下发到你的微信；网页版只在页面打开时用浏览器通知提示一次。 |
| **同步靠轮询** | 网页端每 20 秒自动刷新一次 + 切回页面时立即刷新；小程序端是进页面/下拉刷新时拉云端。不是毫秒级实时。 |
| **时区** | 小程序与云函数按北京时间（Asia/Shanghai）算；网页端按设备本地时区解释 `datetime-local`。设备不在 UTC+8 时，所选时间会按当地时区换算，可能与预期差几小时。 |
| **口令 30 天有效** | 每次绑定自动续期 30 天；过期后重新在小程序生成即可。小程序「作废口令」立即让所有网页端失效。 |
| **订阅额度** | 与小程序原有机制一致：一次性订阅，需在小程序里点「开启推送服务 / 补充提醒次数」。网页端不能代用户授权。 |
| **集合权限** | `web_bindings` / `users` / `identities` 都必须是「仅管理端可读写」，否则 token 与平台用户 ID 泄露。 |
| **小程序端没有第三方登录按钮** | 微信小程序只能用 `wx.login` 拿 `openid`，页面内不允许跳 Google / Apple / GitHub / X 的授权页，所以小程序天然就是「微信身份」，无需也不能新增这些登录方式。网页端的「微信」指**微信开放平台网站应用**扫码登录，拿到的是开放平台 `unionid/openid`，与小程序 `openid` 不是同一个值，因此仍需口令合并。 |
| **第三方登录需要域名/资质** | GitHub 可用腾讯赠送的 `*.tcloudbaseapp.com` 静态托管域名；Google / Apple / 微信网页登录要求验证域名所有权或已备案域名，通常需要给静态托管绑定自己的域名。Apple 还需 Apple Developer Program，微信网站应用需开放平台认证（见 I 节）。 |
| **EXE / 原生包** | 本次交付的是 Web/PWA 三端版本，不是 `.exe` / `.apk` / `.ipa`。若后续确实要 EXE，可用 Electron 把 `webapp/` 套壳（同一份代码直接复用）；iOS 原生包仍需 Apple 开发者账号 + Xcode。 |

---

## H. 本地自检（改代码后跑）

```bash
node tests/webapi.js     # 24 项：口令/token/CRUD/白名单/游标/幂等/归属
node tests/webapp.js     # 18 项：模板编译/资源齐全/共享模块 md5/PWA 清单/登录链路
node tests/oauth.js      # 31 项：五平台适配器/state 签名/PKCE/账号合并/未关联拦截
for t in tests/*.js; do node "$t" >/dev/null || echo "FAIL $t"; done   # 全量 16 个套件
```

`tests/webapp.js` 会用 Vue 自带编译器在 Node 里把 `index.html` 的模板真编译一遍，
模板写错（比如 `v-else` 不相邻）在这里就能发现，不用等部署。
`tests/oauth.js` 用内存 mock 云数据库 + mock 平台 HTTP 响应跑完整 OAuth 链路，
**不需要真实凭证、不产生外网请求**。

---

## I. 第三方账号登录（可选，凭证没配齐时自动隐藏按钮）

这一节是**可选增强**：不做也不影响 A–H 的同步口令方案。做完之后，网页三端
（PC / 安卓 / iOS）可以用 Google、Apple、GitHub、X、微信网页扫码登录，
登录后与小程序共用同一份待办。

### I-1 设计原则：不留假按钮

凭证全部放在**云函数环境变量**里。`oauthProviders` 只返回「已配齐凭证」的平台，
网页端只渲染这些按钮；没配的平台在「账号接入状态」清单里列出还缺哪些变量名，
不会显示一个点了没反应的按钮。**当前默认 5 个全部未配置 = 登录页只有同步口令框**，
与之前完全一致。

### I-2 环境变量（云开发控制台 → 云函数 `webapi` → 配置 → 环境变量）

| 平台 | 需要的变量 | 备注 |
|---|---|---|
| GitHub | `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET` | 最容易先接通，回调不校验域名所有权 |
| Google | `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` | OAuth 同意屏幕 + 域名所有权验证 |
| Apple | `APPLE_CLIENT_ID`（Services ID）、`APPLE_TEAM_ID`、`APPLE_KEY_ID`、`APPLE_PRIVATE_KEY` | `.p8` 私钥全文，换行用 `\n` 写进一行值；云函数现签 ES256 client_secret |
| X | `X_CLIENT_ID`、`X_CLIENT_SECRET` | App 类型选 Web App，强制 PKCE |
| 微信网页 | `WECHAT_WEB_APPID`、`WECHAT_WEB_SECRET` | 微信开放平台「网站应用」，需认证 + 已备案域名 |
| 通用（强烈建议） | `OAUTH_STATE_SECRET` | 一串随机长字符串，给登录 state 做 HMAC 签名；不配也能跑（从环境派生），但正式上线务必配 |

> ⚠️ 变量名大小写必须完全一致。改完环境变量要**重新部署或重启 `webapi`** 才生效。
> 任何一个平台缺变量，该平台就自动禁用，不影响其它平台。

### I-3 回调地址（五个平台后台都填这一个）

```
https://<你的静态托管域名>/oauth-callback.html
```

- 必须与网页 `index.html` **同源**，因为登录状态存在 `sessionStorage`（同源才能读回）；
- 前端 `oauthStart` 会自动按当前页面算出这个地址并签进 state，云函数会校验回调地址一致，
  所以平台后台填的地址必须与它**逐字相同**（含末尾无斜杠、无 query）；
- `oauth-callback.html` 必须随静态托管一起上传；Service Worker 已特意排除缓存这个页面
  （URL 里带 `code/state`，不能落进离线缓存）；
- Apple 刻意不请求 `name/email` scope，用 `response_mode=query` 回落 GET，因此能落到静态页；
  若以后要拿用户姓名，需改成 `form_post` 并把回调指向能接 POST 的云函数路由。

### I-4 各平台注册要点

| 平台 | 去哪注册 | 关键设置 |
|---|---|---|
| GitHub | Settings → Developer settings → OAuth Apps → New OAuth App | Homepage / Authorization callback URL 填 I-3 地址；生成 Client secret |
| Google | Google Cloud Console → OAuth consent screen → Credentials → OAuth client ID (Web) | 需验证域名所有权（放验证文件到静态托管）；Authorized redirect URIs 填 I-3 地址 |
| Apple | Apple Developer → Certificates, Identifiers & Profiles → Identifiers (Services ID) + Keys | Services ID 勾选 Sign in with Apple 并绑定域名与回调；新建 .p8 Key 记下 Key ID / Team ID（Team ID 在 Membership 页） |
| X | developer.x.com → Project / App → User authentication settings | App type = **Web App**；Callback URL / Redirect URI 填 I-3 地址；勾选 `users.read`（代码还会请求 `tweet.read offline.access`） |
| 微信 | 微信开放平台 → 网站应用（不是小程序！） | 需企业/个体认证 + 已备案域名；「授权回调域」填 I-3 地址的域名部分（不带路径） |

> 微信开放平台网页登录拿到的是 `unionid/openid`，**不等于小程序 openid**，
> 所以登录后仍要填一次小程序同步口令完成数据合并，这是刻意设计，不是缺陷。

### I-5 身份合并规则（避免"登录了却看不到数据"）

1. 第一次用某平台登录 → 建 `users.kiwi_uid` + `identities(provider, subject)`，
   签发 token，但 `openid` 为空 → 网页端显示「关联微信小程序」引导条；
   此时所有待办读写返回 `409 NEED_LINK`，**不会写脏数据**。
2. 在引导条里填入小程序「我的 → 网页 / 电脑端同步」的 8 位口令 →
   `linkWechat` 把该 `openid` 写进 `users` 与当前会话。此后写入 `todos` 的字段
   与小程序完全同构（`openid` / `status:'active'` / 三游标），**pusher 一行都不用改**。
3. 再用另一个平台账号登录、填**同一个口令** → 两个第三方身份收敛到同一个 `kiwi_uid`，
   看到同一份待办。已有口令绑定的网页设备完全不受影响。

### I-6 验收顺序

1. 不配任何环境变量 → 登录页只有同步口令框；展开「账号接入状态」应看到 5 个平台都标
   「未配置：…」，且不出现任何第三方按钮。
2. 只配 GitHub 两组变量并重部署 `webapi` → 刷新登录页，应只出现 GitHub 一个按钮。
3. 点 GitHub → 授权 → 自动跳回 → 出现「关联微信小程序」引导条。
4. 填小程序 8 位口令 → 引导条消失，待办列表出现，与小程序一致。
5. 网页端新建一条 2 分钟后的待办 → 到点应收到**微信订阅消息**（pusher 照常工作）。
6. 云函数日志里 `webapi 版本 2026-11-13b` 说明跑的是新包；看不到就是没重新部署。

### I-7 安全边界

- 凭证只在云函数环境变量，前端拿不到；`oauthProviders` 不返回任何凭证值；
- state 用 HMAC-SHA256 签名，绑定平台 + 回调地址 + 10 分钟时效，防 CSRF 与串号；
- X / Google 强制 PKCE（S256），授权码被截获也无法换 token；
- `users` / `identities` / `web_bindings` 必须「仅管理端可读写」；
- token 30 天有效，小程序「作废口令」立即让所有**口令绑定**会话失效；
  第三方会话可在网页端点「退出」清本地（云端会话过期后自然失效）。
