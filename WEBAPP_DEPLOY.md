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
node tests/oauth.js      # 34 项：八平台适配器/state 签名/PKCE/账号合并/未关联拦截
node tests/i18n.js          # 24 项：11 语言字典/语言→地区→节假日行为级校验/6 页文案覆盖/多副本 md5
node tests/sound.js         # 17 项：到点铃声/Web Audio 音色/开关/低版本振动兜底/两端接入点
node tests/release-check.js # 19 项：发布门禁（订阅消息链路/多端互通/交付一致性）+ 上架材料清单
node tests/weekday.js      # 13 项：日期滚轮的周几（含同天数换月重建）/范围日期/Web 弹层
for t in tests/*.js; do node "$t" >/dev/null || echo "FAIL $t"; done   # 全量 20 个套件
```

`tests/webapp.js` 会用 Vue 自带编译器在 Node 里把 `index.html` 的模板真编译一遍，
模板写错（比如 `v-else` 不相邻）在这里就能发现，不用等部署。
`tests/oauth.js` 用内存 mock 云数据库 + mock 平台 HTTP 响应跑完整 OAuth 链路，
**不需要真实凭证、不产生外网请求**。

---

## I. 第三方账号登录（可选，凭证没配齐时自动隐藏按钮）

这一节是**可选增强**：不做也不影响 A–H 的同步口令方案。做完之后，网页三端
（PC / 安卓 / iOS）可以用 Google、Apple、GitHub、X、微信网页扫码登录，
以及按所选语言/地区出现的当地账号（日本語→LINE、한국어→Kakao / Naver），
登录后与小程序共用同一份待办。全球通用平台任何语言都显示，当地平台只在
对应地区显示；详见 J 节。

### I-1 设计原则：不留假按钮

凭证全部放在**云函数环境变量**里。`oauthProviders` 只返回「已配齐凭证」的平台，
网页端只渲染这些按钮；没配的平台在「账号接入状态」清单里列出还缺哪些变量名，
不会显示一个点了没反应的按钮。**当前默认 8 个全部未配置 = 登录页只有同步口令框**，
与之前完全一致。

### I-2 环境变量（云开发控制台 → 云函数 `webapi` → 配置 → 环境变量）

| 平台 | 需要的变量 | 备注 |
|---|---|---|
| GitHub | `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET` | 最容易先接通，回调不校验域名所有权 |
| Google | `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` | OAuth 同意屏幕 + 域名所有权验证 |
| Apple | `APPLE_CLIENT_ID`（Services ID）、`APPLE_TEAM_ID`、`APPLE_KEY_ID`、`APPLE_PRIVATE_KEY` | `.p8` 私钥全文，换行用 `\n` 写进一行值；云函数现签 ES256 client_secret |
| X | `X_CLIENT_ID`、`X_CLIENT_SECRET` | App 类型选 Web App，强制 PKCE |
| 微信网页 | `WECHAT_WEB_APPID`、`WECHAT_WEB_SECRET` | 微信开放平台「网站应用」，需认证 + 已备案域名 |
| LINE（日本） | `LINE_CLIENT_ID`、`LINE_CLIENT_SECRET` | LINE Developers → LINE Login Channel；回调填 I-3 地址；scope `profile openid`，`regions: ['jp']` |
| Kakao（韩国） | `KAKAO_CLIENT_ID`、`KAKAO_CLIENT_SECRET` | Kakao Developers → 应用 → Kakao Login → Redirect URI；需开启「Client Secret」；用户标识取 `/v2/user/me` 的 `id` |
| Naver（韩国） | `NAVER_CLIENT_ID`、`NAVER_CLIENT_SECRET` | Naver Developers → 应用 → API 设置 → Callback URL；响应包一层 `response`，换 token 要原样回传 `state` |
| 通用（强烈建议） | `OAUTH_STATE_SECRET` | 一串随机长字符串，给登录 state 做 HMAC 签名；不配也能跑（从环境派生），但正式上线务必配 |

> ⚠️ 变量名大小写必须完全一致。改完环境变量要**重新部署或重启 `webapi`** 才生效。
> 任何一个平台缺变量，该平台就自动禁用，不影响其它平台。

### I-3 回调地址（八个平台后台都填这一个）

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
| LINE | LINE Developers → Providers → Create a LINE Login channel | App type = Web app；Callback URL 填 I-3 地址；`openid` scope 需勾选 |
| Kakao | Kakao Developers → 我的应用 → 产品设置 → Kakao Login | 激活 Kakao Login、填 Redirect URI；在「安全」里生成并启用 Client Secret |
| Naver | Naver Developers → Application → 应用注册 | 使用 API 选「네이버 로그인」，Callback URL 填 I-3 地址；服务 URL 要与静态托管同源 |

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

1. 不配任何环境变量 → 登录页只有同步口令框；展开「账号接入状态」应看到 8 个平台都标
   「未配置：…」，且不出现任何第三方按钮。
2. 只配 GitHub 两组变量并重部署 `webapi` → 刷新登录页，应只出现 GitHub 一个按钮。
3. 点 GitHub → 授权 → 自动跳回 → 出现「关联微信小程序」引导条。
4. 填小程序 8 位口令 → 引导条消失，待办列表出现，与小程序一致。
5. 网页端新建一条 2 分钟后的待办 → 到点应收到**微信订阅消息**（pusher 照常工作）。
6. 云函数日志里 `webapi 版本 2026-11-13c` 说明跑的是新包；看不到就是没重新部署。

### I-7 安全边界

- 凭证只在云函数环境变量，前端拿不到；`oauthProviders` 不返回任何凭证值；
- state 用 HMAC-SHA256 签名，绑定平台 + 回调地址 + 10 分钟时效，防 CSRF 与串号；
- X / Google 强制 PKCE（S256），授权码被截获也无法换 token；
- `users` / `identities` / `web_bindings` 必须「仅管理端可读写」；
- token 30 天有效，小程序「作废口令」立即让所有**口令绑定**会话失效；
  第三方会话可在网页端点「退出」清本地（云端会话过期后自然失效）。

---

## J. 多语言 / 当地节假日 / 当地社交登录（2026-11-14 新增）

### J-1 覆盖范围

界面覆盖苹果「实时翻译」的 **11 种语言**，每种语言绑定一个地区：

| 语言 | 地区 | 语言 | 地区 |
|---|---|---|---|
| 简体中文 / 繁體中文 | 中国大陆 `cn` | English (US) | 美国 `us` |
| English (UK) | 英国 `gb` | 日本語 | 日本 `jp` |
| 한국어 | 韩国 `kr` | Deutsch | 德国 `de` |
| Français | 法国 `fr` | Español | 西班牙 `es` |
| Italiano | 意大利 `it` | Português (Brasil) | 巴西 `br` |

- **网页/PWA**：登录页、主界面顶部、桌面侧栏共 3 处语言选择器；选择存
  `localStorage.kiwi_web_lang`，首次访问按浏览器语言自动选；OAuth 回调页与
  Service Worker 缓存版本（当前 `kiwi-web-v6`）同步。
- **小程序**：「我的」页新增「语言 / Language」卡片（11 项 picker），选择存
  `wx.Storage.kiwi_lang`。**6 个页面（待办 / 提醒记录 / 节假日维护 / 我的 /
  编辑 / 邀请）+ 自定义 tabBar 的可见文案、toast、弹窗、提醒预览、滚轮选择器
  已全部走字典**，`tests/i18n.js` 会扫 WXML 与 JS 的中文残留。
- `utils/i18n-format.js` 是展示层薄封装：`reminder-core.js` 里返回中文的
  `weekdayName / priorityText / describeRepeat / describeRepeatRange /
  describeRepeatDates / INTERVAL_UNITS` 不能改（推送链路共用），由它按当前
  语言重新实现一份给页面展示用，本身不写死任何中文。
- 字典文件 `i18n.js`（129 键）/ `i18n-extra.js`（**418 键**）/
  `holidays-region.js` 在 `webapp/` 与 `utils/` 各有一份，
  全部 × 11 语言；`tests/i18n.js` 会校验 md5 一致、每键 11 值非空、
  占位符在 11 语言里完全一致，防止两端翻译口径漂移。

### J-2 切换语言 = 切换当地法定节假日（本次重点）

`webapp/holidays-region.js` 内置 10 个地区 2027 年官方假日（日本祝日含振替休日、
韩国公休日含대체공휴일、美国联邦假日含 observed 补休、英德法意西巴法定假日等）。

- 网页端 `app.js` 的 `buildHolidayMap(region)` 按当前语言的 region 取表，
  `setLang()` 立即重建响应式的 `holidayMap`，「下一次提醒」与卡片上的下次提醒
  预览随之重算（`core.nextOccurrence` 用新表）。
- 小程序 `app.setLang()` 会把 `holidaysLoaded` 置 false 并清空 `holidayMap`，
  首页 / 节假日页按 `store.regionSeed(region)` 重建；页面顶部显示「当前按 XX
  官方节假日显示」。
- **兜底路径也是地区感知的**：提醒记录页在 `holidayMap` 为空时会用本地缓存
  重建，编辑页冷启动直达或切语言后也会走 `ensureHolidayMap()`；这两处都改成
  经 `store.mergeActiveHolidays(rows, i18n.region())` 重建，非中国大陆地区
  **不会拿中国大陆缓存把当地表覆盖掉**。否则「切到日本語、节假日页是对的、
  但编辑页月历和下次提醒仍按中国表」这种半切换状态会出现。
- 编辑页「节假日跳过」标签按地区名动态生成（如「日本の祝日をスキップ」），
  但**不承诺云端按当地跳过**，见下方限制。
- **非中国大陆地区只读**：只展示本地地区表，**不读取、不回灌、不删除云端
  `holidays` 集合**。那是一张公共表、存的是中国大陆口径；若切语言就写回，
  会把所有用户的节假日表写脏。切回简体中文即恢复可自行维护。
- 中国大陆地区（默认）行为与改造前完全一致：官方 2027 表（含调休补班
  `workday`）+ 云端覆盖 + 用户排除集，原有回灌/编辑/删除逻辑一行未改。

> ⚠️ **必须知道的限制**：真正的「到点推送」由云端 `pusher` 每分钟扫描并下发
> 微信订阅消息，它仍按**中国大陆官方节假日表**判断是否跳过。本次为了不动
> 提醒链路（reminder-core 5 份副本、pusher / pushapi 零改动），语言与地区
> 影响的是**端上的显示与「下次提醒」预览**，不会改变云端实际下发日期。
> 若要让云端也按用户所在地区跳过，需要把 region 写进待办/用户配置并让
> pusher 按人取表，属于后续独立改造。

### J-3 当地社交登录

`cloudfunctions/webapi/oauth.js` 现为 8 个平台，每个带 `regions` 字段：

- 全球通用（regions 为空）：GitHub / Google / Apple / X —— 任何语言都显示；
- 微信网页（cn）、LINE（jp）、Kakao / Naver（kr）—— 只在对应地区显示；
- `oauthProviders` 会把 `regions` 一起下发，前端 `visibleProviders` 按当前
  region 过滤；未配凭证的平台依旧自动隐藏，绝不留假按钮；
- 三个新平台的注册清单见 I-2 / I-4，回调地址统一用 I-3 那一个。

### J-4 部署与验收

1. 若**上一轮 8 个 OAuth 平台的版本还没部署**，先「上传并部署」`webapi`
   （日志 BUILD 应为 `2026-11-13c`）；本轮只改端上代码，云函数零改动，
   `pusher` / `pushapi` 从头到尾都不用动。
2. 重新运行 `python tools/build_dist.py`，把 `webapp/` 下**全部文件**（含新增的
   `i18n.js` / `i18n-extra.js` / `holidays-region.js`）重新上传到静态托管；
   Service Worker 已升 v6（见 K 节），老设备刷新两次会拿到新资源。
3. 小程序重新编译上传（本轮新增/改动：`utils/i18n*.js`、
   `utils/holidays-region.js`、**`utils/i18n-format.js`**，以及 6 个页面的
   `.js`/`.wxml` 与 `custom-tab-bar/index.js`）。`webapi` / `pusher` / `pushapi`
   这一轮零改动，不需要重新部署。
4. 验收：切到日本語 → 界面变日文、侧栏显示「日本」、节假日页出现
   `2027-02-23 天皇誕生日` 而不再有中国春节调休；新建/编辑页的月历「休/班」
   标记、提醒预览、批量确认与删除弹窗也应是日文；登录页若配了 LINE 凭证
   应出现 LINE 按钮，切回简体中文则显示微信网页登录按钮。
5. 本地跑 `node tests/i18n.js`（**24 项**，含 `store.mergeActiveHolidays` 的
   行为级换表校验）与全量 20 个套件，全绿才说明联动与文案覆盖没回退。

---

## K. 到点铃声提醒（2026-11-15 新增）

### K-1 「系统默认铃声」在 Web / 小程序里的真实含义

浏览器和微信小程序都运行在沙箱里，**读不到手机 / 电脑操作系统的铃声文件**，
也没有「播放系统默认铃声」这种 API。所以本次按两层实现，全程不加载任何
自定义铃声文件（不需要准备 mp3，也不增加安装包体积）：

1. **系统通知音**：Web 的 `Notification`、小程序的微信订阅消息，提示音由
   操作系统按用户当前铃声 / 静音设置播放 —— 这就是系统默认铃声；
2. **内置默认提示音**：页面在前台时，用 Web Audio 合成一段 880Hz → 1174Hz
   的双音（约 0.45 秒，带淡入淡出包络）。很多浏览器 / 系统的通知本身是
   静音的，这一层保证到点时确实能听见。

Web 端 `webapp/sound.js`、小程序端 `utils/sound.js` 是同一套音色；
`reminder-core` 5 份副本与 `pusher` / `pushapi` **零改动**。

### K-2 触发点与开关

| 端 | 到点触发 | 开关 / 试听 |
|---|---|---|
| Web/PWA | `app.js checkDue()` 每 30 秒检查，提醒时刻落在过去 1 分钟内即响一次（同一会话去重） | 主界面顶部「♪ 铃声提醒」点击切换，桌面侧栏有 checkbox +「试听」 |
| 小程序 | `pages/index` 打开时若有刚补记的到点提醒（`freshList`）则响一声；节假日跳过的记录不响，同一批只响一次 | 「我的」→「铃声提醒」卡片：开启 / 关闭 + 试听 |

- Web 开关存 `localStorage.kiwi_web_sound`，小程序存 `wx.Storage.kiwi_sound`，
  **默认开启**；关掉后到点只剩系统通知音，不再合成提示音。
- 顺手修掉一个旧缺陷：原 `checkDue()` 在 `Notification.permission !== 'granted'`
  时**整体跳过**到点检测，等于没给通知权限就什么提示都没有。现在铃声与
  通知权限解耦，权限只决定要不要弹横幅。
- 浏览器规定 `AudioContext` 必须在用户手势链里创建 / 恢复，所以首次点击页面
  时会调用 `SOUND.unlock()`；进页面后什么都不点就干等提醒，可能被浏览器拦掉。
- 基础库低于 2.19.0 的小程序没有 `wx.createWebAudioContext()`，会自动回退
  `wx.vibrateShort()` 系统振动，不会静默失败。

### K-3 部署与验收

1. **云函数零改动**：`webapi` / `pusher` / `pushapi` 都不用重新部署。
2. 重新运行 `python tools/build_dist.py`，把 `webapp/` 下**全部文件**重新上传
   静态托管，尤其新增的 `sound.js` 与升到 **v6** 的 `sw.js`（老设备刷新两次
   拿到新缓存）。字典 `i18n-extra.js` 也更新了（407 → 418 键）。
3. 小程序重新编译上传：新增 `utils/sound.js`，改动 `pages/index/index.js`、
   `pages/mine/mine.js` / `.wxml`、`utils/i18n-extra.js`。
4. 验收：
   - Web：绑定后点主界面顶部「♪」或侧栏「试听」→ 应听到两声短提示音；
     关掉后再点「试听」不发声；新建一条 1 分钟后提醒的待办，到点响一声。
   - 小程序：「我的」→「铃声提醒」→「试听」应听到提示音（低版本为振动）；
     让一条提醒到点后重新打开小程序，首页应补响一声。
   - 本地跑 `node tests/sound.js`（**17 项**，mock AudioContext / wx 验证音色、
     开关、异常与回退）与全量 **20 个套件**。

### K-4 限制

- 网页关闭 / 小程序退到后台后**不会响铃**：后台提醒仍只有微信订阅消息，
  其提示音由系统与微信设置决定（勿扰模式、静音键、通知权限都会影响）。
- iOS 的静音拨键会同时压掉 Web Audio 合成音；Android 媒体音量过低也听不到。
- 铃声提醒是端上补充，**不改变云端 `pusher` 的下发时机与节假日口径**。


---

## L. App Store 上架准备（2026-11-15）

### L-1 先看清现状：目前没有可提交的东西

| 事实 | 说明 |
|---|---|
| 现有交付物 | 微信小程序 + 一套 Web/PWA（`dist/kiwi-{pc,android,ios}.zip`），**没有 `.ipa`、没有 Xcode 工程** |
| App Store 不收 | 微信小程序本身；以及「只是把网页塞进 WKWebView」的纯壳（Guideline **4.2 Minimum Functionality**） |
| 本环境限制 | Windows，无 Xcode / Apple 签名证书，**编译不了 `.ipa`**（此前已确认） |
| 必备前置 | Apple Developer Program 年费账号、Mac + Xcode、App Store Connect 应用记录 |

`PUBLISH.md` 里此前记录的决策是「不走原生三件套」，本次「准备申请苹果商店」等于要改这个决策，
**L-2 的路径选择必须先拍板**，否则后面做的材料可能全部作废。

### L-2 与微信提醒的根本冲突（最关键）

微信订阅消息**只能在微信客户端内下发**，原生 iOS App 收不到。当前的后台提醒链路是
`pusher` 每分钟扫库 → `subscribeMessage.send`；而 WKWebView 里那个 20 秒轮询在 App
退到后台后会被系统挂起，**不能当作提醒用**。所以只要上架原生 App，提醒就得重做：

| 路径 | 到点提醒 | 工作量 | 结论 |
|---|---|---|---|
| **A. 维持 PWA，不进 App Store** | 仍是微信订阅消息；iOS 用 Safari「添加到主屏幕」 | 零 | 商店里搜不到，但功能完整 |
| **B. Capacitor / WKWebView 壳 + 本地通知**（若要上架，推荐） | 同步后把未来 N 天提醒注册成 `UNUserNotificationCenter` 本地通知，长期提醒再接 APNs | 中高：原生工程 + 通知插件 + Mac/Xcode + 审核 | 需独立改造，云函数侧要新增「按设备下发提醒时刻」接口 |
| **C. Flutter / React Native 重写原生** | APNs | 高 | 与现有 `webapp/` 代码复用率低 |

走 B 时为了满足 4.2，壳里必须有真正的原生能力，不能只是打开一个 URL：
本地通知、写系统日历（`EKEventStore`，对应小程序已有的 `wx.addPhoneCalendar`）、
Widget / Siri 快捷指令、分享扩展里任选 2~3 项并做成主流程的一部分。

### L-3 无论选哪条路径都要备齐的材料

| 材料 | 现状 | 说明 |
|---|---|---|
| 隐私政策页（Privacy Policy URL） | ❌ 缺 | App Store Connect 必填，且 App 内必须可访问；需覆盖待办内容、位置备注、图片、OAuth 身份标识、设备 token |
| 1024×1024 无圆角图标 | ❌ 缺 | 现只有 `icon-192.png` / `icon-512.png`；不能带圆角或透明通道 |
| App Privacy 隐私营养标签 | ❌ 未填 | 逐项声明「是否收集 / 用途 / 是否关联身份 / 是否用于追踪」 |
| Info.plist 权限描述 | ❌ 缺 | `NSCalendarsUsageDescription`、`NSPhotoLibraryUsageDescription`、`NSLocationWhenInUseUsageDescription`、通知权限——与小程序 `app.json` 的 `scope.*` 一一对应 |
| 商店元数据 | ❌ 未填 | 名称/副标题/描述/关键词/分类/年龄分级/支持 URL/版权/本地化（已支持 11 语言，可复用字典） |
| 截图与预览 | ❌ 缺 | 6.9″ / 6.5″ / iPad 尺寸；若不做 iPad 适配需说明 |
| 审核用可登录账号 | ⚠ 有坑 | 审核员没有你的微信小程序，拿不到 8 位同步口令；需预置演示账号或在壳里加「演示模式」，否则可能以「无法登录」被拒 |
| Sign in with Apple | ✅ 已具备 | 8 平台 OAuth 里已有 `apple`；若上架原生包，优先把它作为主登录，规避 5.1.1(v) |

### L-4 本轮已做 / 建议下一步

已做（与路径无关，不会白做）：

- `webapp/manifest.json` 描述修正为 11 语言 + 当地节假日（原先仍写「中国大陆节假日」）。
- `utils/share.js` 分享卡片标题跟随当前语言（原先写死中文）。
- 新增 `tests/release-check.js` **19 项发布门禁**：订阅消息触发器/模板 ID 三处一致/
  `MINIPROGRAM_STATE`/时区/三游标/额度守卫/6 页冒泡补额度、webapi 12 action/401 与 409
  /协作字段白名单/8 平台 regions/分享挂载、以及 5+4+3 组共享副本 md5。
  末尾会打印发布状态与 App Store 材料缺口，可用作提审前 checklist。

下一步（**需先确认 L-2 路径**）：产出双语隐私政策页、1024 图标、原生壳工程与本地通知插件。
这些在本环境只能准备源码/资源，最终 `.ipa` 仍需在 Mac 上签名上传。

### L-5 发布前必改项（与 App Store 无关，但会卡住正式版）

1. `pusher` / `pushapi` 两处 `MINIPROGRAM_STATE` 由 `trial` 改 `formal`，重部署两个云函数
   并更新 BUILD；**只上传 `index.js` 不够**，`pusher/config.json` 触发器要单独上传。
2. 8 个 OAuth 平台真凭证（尤其 LINE / Kakao / Naver），未配会自动隐藏按钮。
3. `web_bindings` / `users` / `identities` 三个集合权限设为「仅管理端可读写」。
4. 跑 `node tests/release-check.js` + 全量 20 个套件，再按 J-4、K-3 做真机验收。


---

## M. 日期选择显示周几（2026-11-15 新增）

### M-1 需求与落点

「新增和修改都要能在选日期时看到周几」。两端的新建 / 修改本来就是同一套表单
（小程序 `pages/edit` 按 `isEdit` 分支，Web 弹层按 `editing.id` 分支），因此
一处改动同时覆盖两种模式：

| 位置 | 改造前 | 改造后 |
|---|---|---|
| 小程序日期滚轮「日」列 | `1日 / 2日 / …` | `1日 周一 / 2日 周二 / …` |
| 小程序滚轮顶部 | 只有「选择日期」标题 | 实时显示 `2027-02-11 周四`，滚动即刷新 |
| 小程序生效范围起止 | 只显示 `2027-03-01` | 显示 `2027-03-01 周一`（值仍只存纯日期） |
| 小程序主日期字段 | 已有 `{{dateStr}} {{weekdayText}}` | 保持不变（含节假日「休/班」标记） |
| Web/PWA 新建 / 编辑弹层 | 只有 `datetime-local` | 下方补一行按当前语言格式化的「2/11 Thu」 |

「按日历选择」的月历本来就有本地化周表头（`fmt.weekHead()`），无需改动。

### M-2 一个必须记住的坑

周几由**年 + 月 + 日**共同决定。原 `onCpChange()` 只在「日列长度变化」时重建
列（为处理 2 月大小月），加了周几后这个判断就不够：**7 月和 8 月都是 31 天，
切换时会显示 7 月的星期**。现在改为按 `cpYm`（当前列对应的 `YYYY-MM`）判断，
只要年/月变化就整列重建；同时 `cpWeekdayText` 每次滚动都重算。
`applyLang()` 也会在切语言时按新语言重建正在打开的滚轮列。

另外：`rangeStart` / `rangeEnd` / `cpValue` 里**仍然只存纯日期和索引**，
周几只放进 `rangeStartText` / `rangeEndText` / `cpColumns` 等展示字段，
所以 `remind_at`、`repeat_start`、`repeat_end` 的数据格式和云端推送完全没变。

### M-3 本地化与回归

新增 2 个共享词条（`wd_cp_day`、`wd_picker_full`）× 11 语言，占位符分别是
`{n}/{week}`、`{date}/{week}`；`{week}` 由 `Intl.DateTimeFormat` 按当前语言
生成，不新增任何硬编码星期表。`webapp/i18n-extra.js` 与
`utils/i18n-extra.js` 保持 md5 一致（416 → **418 键**）。

`tests/weekday.js` **13 项**是行为级测试：用 stub 真跑编辑页的
`openCp` / `onCpChange` / `onCpConfirm`，覆盖 2 月 28 天、同天数换月、
日列内滚动、索引夹取、范围起止与 Web 弹层。全量 **20 个套件**通过。

### M-4 部署

- **云函数零改动**：`webapi` / `pusher` / `pushapi` 都不用重新部署。
- `webapp/` 全部文件重新上传静态托管（改了 `app.js`、`index.html`、`i18n-extra.js`；
  **SW 升到 v6**：虽然无新增资源文件，但 `app.js` / `index.html` / 字典内容变了，
  `sw.js` 字节不变时浏览器不会重新 install，老设备会一直吃旧缓存，故必须升版本）。
- 小程序重新编译上传：`pages/edit/edit.js` / `.wxml` / `.wxss`、
  `utils/i18n-extra.js`。
- 验收：新建一条待办 → 点日期，滚轮每一天后面带周几、顶部显示选中日期周几；
  从 7 月滚到 8 月，周几要跟着变；确定后日期值仍是 `YYYY-MM-DD`；
  打开同一条待办修改，表现一致；生效范围起止也带周几；Web 弹层新建/
  编辑都在日期输入下显示周几，切语言后周几跟着换语言。
