# -*- coding: utf-8 -*-
"""
重新生成 PC / 安卓 / iOS 三个分发包。

三端共用同一份 webapp/ 代码，靠 CSS 媒体查询自动切换界面：
  >= 980px  → 桌面工作台（侧栏 + 多列卡片网格 + 搜索工具条 + 两列表单）
  <  980px  → 手机单列布局

运行：python tools/build_dist.py
"""
import os
import shutil
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, 'webapp')
DIST = os.path.join(ROOT, 'dist')
os.makedirs(DIST, exist_ok=True)

NOTES = {
    'kiwi-pc': '''KIWI待办 · PC 电脑版（桌面工作台 / Web·PWA）
==============================================

与微信小程序、安卓、iOS 共用同一个云开发后台，待办互相同步。
窗口宽度 >= 980px 时自动切换为桌面界面；缩窄窗口会自动变回单列手机布局。

【桌面界面】
  * 左侧固定导航栏：进行中 / 已完成 / 全部（带条数）、新建待办、立即同步、
    下一次提醒、自动同步状态、快捷键说明
  * 右侧多列卡片网格：按窗口宽度自动排 2～4 列，鼠标悬停高亮，操作按钮常驻
  * 顶部工具条：标题/备注搜索、结果条数、刷新
  * 新建/编辑弹层：加宽 + 两列表单，支持「跳过节假日」「顺延」「优先级」
    「需要手工确认完成」等完整规则
  * 未绑定时登录页为左侧品牌介绍 + 右侧口令卡的居中分栏

【键盘快捷键】
  N               新建待办
  /               聚焦搜索框
  R               立即同步
  Esc             关闭弹层 / 清空搜索
  Ctrl / ⌘ + Enter  保存当前编辑

【运行方式】
  方式一（推荐）：按 WEBAPP_DEPLOY.md 部署后，在电脑浏览器打开静态托管地址，
                  存成书签即可，支持离线缓存与浏览器通知。
  方式二（本地）：双击「启动本地服务.bat」用本地静态服务器打开；
                  也可直接双击 index.html（离线缓存与安装能力会受限）。

【首次配置（只需一次，本设备记住）】
  1. 展开「接口地址设置」，填云开发 HTTP 访问服务里 webapi 的完整地址，例如：
     https://<环境ID>.service.tcloudbase.com/webapi
  2. 在微信小程序「我的」→「网页 / 电脑端同步」生成 8 位同步口令，
     填到这里点「绑定并同步」。

说明：这是 Web/PWA 版本，不是 .exe。若确实需要 EXE，可用 Electron 把本目录
套壳打包（代码直接复用），届时告诉我即可。到点提醒仍由微信订阅消息推送，
网页端只在页面打开期间弹一次浏览器通知。
''',
    'kiwi-android': '''KIWI待办 · 安卓版（PWA）
=====================================

与微信小程序、PC 版、iOS 版共用同一个云开发后台，待办互相同步。
窄屏自动使用手机单列界面（无侧栏、无桌面搜索框）。

【安装到手机桌面】
  1. 按 WEBAPP_DEPLOY.md 部署后，用 Chrome（或 Edge / 三星浏览器）
     打开静态托管地址。
  2. 右上角菜单 →「添加到主屏幕」或「安装应用」。
  3. 确认后桌面出现 KIWI 图标，点开是全屏无地址栏的独立窗口，
     观感与原生 App 一致。

【首次配置】
  - 展开「接口地址设置」填入 webapi 完整地址（只需一次，本设备记住）。
  - 在微信小程序「我的」→「网页 / 电脑端同步」生成 8 位口令，
    输入后点「绑定并同步」。

【提醒说明】
  真正的到点提醒仍由微信订阅消息推送到你的微信（由云端 pusher 下发）。
  安卓 PWA 在页面打开时会额外弹一次浏览器通知，但关闭页面后
  不能像原生 App 那样后台推送，这是浏览器平台限制。
''',
    'kiwi-ios': '''KIWI待办 · iOS 版（PWA）
=====================================

与微信小程序、PC 版、安卓版共用同一个云开发后台，待办互相同步。
窄屏自动使用手机单列界面（无侧栏、无桌面搜索框）。

【安装到主屏幕】
  1. 必须用 Safari 打开静态托管地址（微信内置浏览器 / Chrome 不支持
     「添加到主屏幕」的完整能力）。
  2. 点底部「分享」按钮 → 下滑找到「添加到主屏幕」→ 点「添加」。
  3. 主屏出现 KIWI 图标，点开是全屏独立窗口（standalone）。

【首次配置】
  - 展开「接口地址设置」填入 webapi 完整地址（只需一次）。
  - 在微信小程序「我的」→「网页 / 电脑端同步」生成 8 位口令，
    输入后点「绑定并同步」。

【iOS 平台限制（重要）】
  * PWA 关闭后无法后台推送；到点提醒请以微信订阅消息为准，
    网页版只在页面打开时弹一次浏览器通知。
  * iOS 对长期未打开的 PWA 会清理本地缓存；口令存在本机，
    若提示需重新绑定，回小程序重新生成口令即可，云端数据不会丢。
  * 本版本不是 App Store 的 .ipa。原生 iOS App 需要 Apple 开发者
    账号 + Xcode + 上架审核，本环境无法编译。
''',
}

BAT = '''@echo off
cd /d "%~dp0"
echo Starting KIWI Todo local server at http://localhost:8765 ...
start "KIWI-Todo-Server" python -m http.server 8765
timeout /t 2 >nul
start "" http://localhost:8765/index.html
echo Browser opened. Close the "KIWI-Todo-Server" window to stop the server.
pause >nul
'''

OAUTH_NOTE = '''
【第三方账号登录（可选）】
  除 8 位同步口令外，网页端还支持 Google / Apple / GitHub / X /
  微信网页扫码登录，三端共用同一套逻辑。
  按钮由云端控制：只有在 webapi 云函数环境变量里配好对应平台凭证才会出现，
  未配置的平台不会显示假按钮（可展开「账号接入状态」查看还缺哪些变量）。
  首次用第三方账号登录后，需再输入一次小程序里的 8 位同步口令完成账号合并，
  之后与小程序读写同一份待办，并继续由微信订阅消息准时提醒。
  完整配置清单见 WEBAPP_DEPLOY.md 的 I 节。
'''

# 临时预览 / 调试文件绝不进分发包
IGNORE = shutil.ignore_patterns('_vue.dev.js', '_preview*', '_probe*', '*.pyc')

for name, note in NOTES.items():
    note = note + OAUTH_NOTE
    target = os.path.join(DIST, name)
    if os.path.isdir(target):
        shutil.rmtree(target)
    shutil.copytree(WEB, target, ignore=IGNORE)
    with open(os.path.join(target, '安装说明.txt'), 'w', encoding='utf-8') as f:
        f.write(note)
    if name == 'kiwi-pc':
        with open(os.path.join(target, '启动本地服务.bat'), 'w', encoding='ascii') as f:
            f.write(BAT)
    zpath = os.path.join(DIST, name + '.zip')
    with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_DEFLATED) as z:
        for base, dirs, files in os.walk(target):
            for fn in files:
                full = os.path.join(base, fn)
                z.write(full, os.path.relpath(full, target))
    print(name + '.zip', os.path.getsize(zpath), 'bytes')
