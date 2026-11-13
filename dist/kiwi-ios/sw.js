/**
 * KIWI待办 Web/PWA · Service Worker
 * 策略：静态资源「网络优先 + 离线回退缓存」，保证改版能及时生效，断网也能打开界面；
 *       API 请求（POST 到云函数 HTTP 访问服务）一律直连网络，绝不缓存。
 */
var CACHE = 'kiwi-web-v3'
var ASSETS = [
  './',
  './index.html',
  './app.js',
  './vendor/vue.global.prod.js',
  './reminder-core.js',
  './holidays-2027.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
]

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(ASSETS) })
      .then(function () { return self.skipWaiting() })
  )
})

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE })
          .map(function (k) { return caches.delete(k) }))
      })
      .then(function () { return self.clients.claim() })
  )
})

self.addEventListener('fetch', function (e) {
  var req = e.request
  // 非 GET（webapi 全是 POST）与跨域请求直接放行，不进缓存
  if (req.method !== 'GET') return
  var url
  try { url = new URL(req.url) } catch (err) { return }
  if (url.origin !== self.location.origin) return
  // OAuth 回调页的 URL 带 code/state，绝不能进离线缓存（授权码落磁盘有泄露风险）
  if (url.pathname.indexOf('oauth-callback.html') >= 0) return

  e.respondWith(
    fetch(req)
      .then(function (res) {
        var copy = res.clone()
        caches.open(CACHE).then(function (c) { c.put(req, copy) }).catch(function () {})
        return res
      })
      .catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('./index.html')
        })
      })
  )
})
