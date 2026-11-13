# KIWI Todo — WeChat Mini Program

[English](README.md) | [简体中文](README.zh-CN.md)

KIWI Todo is a reminder-focused to-do app for WeChat. You capture a task once, and it keeps reminding you at the right moment — on a schedule you define, across your phone's native calendar, and through WeChat subscription messages even when the mini program is fully closed.

**Highlights**

- **13 recurrence modes** — once, every X minutes/hours/days, weekly, monthly, yearly, and every-working-day, each with an adjustable interval. Start and end dates constrain any repeating rule, inclusive on both ends.
- **Chinese public-holiday awareness** — reminders are silently skipped on statutory holidays, optionally *postponed to the next working day*, and make-up workdays (weekends where China requires work) are correctly treated as working days.
- **Push that works when the app is closed** — a cloud function scans due reminders **every minute** and delivers WeChat subscription messages. No dedicated server, no domain whitelisting: everything runs on WeChat CloudBase.
- **Native calendar integration** — every new task is written to the phone's system calendar by default (`wx.addPhoneCalendar`), so local system alarms fire without consuming WeChat's push-quota.
- **Collaboration** — share a task as a WeChat card, or invite via a 6-character code; collaborators see the same todo list in real time.
- **Configurable completion** — by default a finished reminder auto-archives; per-task you can require a manual "mark as done" confirmation instead.
- **Batch management, filtering, history** — multi-select done/delete, combined priority + date-range + time-range filtering, and a searchable reminder log for every fired (or holiday-skipped) reminder.

## Architecture

```
├── pages/            index (todo list) / edit / history / holidays / invite / mine
├── utils/            store (data layer), reminder-core (scheduling engine), push, subscribe, collab
├── cloudfunctions/
│   ├── pusher/       timer-triggered (every minute) — scans due todos, sends subscription messages
│   ├── pushapi/      device & quota API — authorization state, test pushes, health reporting
│   └── dataapi/      batch writes & holiday pruning with admin privileges
└── tests/            13 Node-based smoke & structure test suites
```

Key design points:

- **Cursor-based, idempotent push.** Each todo tracks a push cursor so the per-minute scanner never double-sends; a 15-minute window, a 2-hour backstop and a 200-item enumeration cap keep worst-case loops bounded. Push failures don't advance the cursor.
- **Duplicate-share of one scheduling engine.** The exact same `reminder-core.js` file (md5-verified) ships in `utils/` and inside both push cloud functions, so the client's "catch-up reminders" and the cloud's push decisions can never disagree about what is due.
- **Timezone-safe cloud functions.** WeChat cloud functions run in UTC; every function sets `process.env.TZ = 'Asia/Shanghai'` before any `Date` arithmetic, avoiding the classic 8-hour drift bugs.
- **One-shot subscription quota management.** WeChat's subscription messages are consumed per authorization tap. A single guarded entry point (`utils/subscribe.js`) handles authorization, renewal and concurrency so quota is topped up on nearly every user interaction.
- **Idempotent saves.** A client-token + page-lock + navigation-throttle stack makes double-taps and flaky networks produce at most one database write.

## Getting Started

1. Open **WeChat DevTools** → Import project → select this directory. The mini program uses AppID `wx79fbbd4f1cc1a4e3` (replace with your own).
2. Hit **Compile** — there are no npm dependencies and no build step.
3. Log in with WeChat one-tap (openid is resolved through a cloud function; no auth server needed).
4. Enable **CloudBase** in DevTools and create the database collections: `todos`, `remind_logs`, `holidays`, `push_devices`, `push_quotas`. Per-user isolation is enforced with custom security rules (`auth.openid == doc.openid`).

### Push delivery (optional but recommended)

1. Pick a subscription-message template in the WeChat admin console and copy its template ID and keyword keys.
2. Fill the template ID into `cloudfunctions/pushapi/index.js` and `cloudfunctions/pusher/index.js`.
3. Deploy all three cloud functions ("upload & deploy"). For `pusher`, additionally right-click its `config.json` → **Upload trigger config** — this registers the every-minute timer that drives real pushes.
4. In the mini program: *Mine → enable push → authorize one reminder → send a test push*.

> Note: while the mini program is in trial/review, both cloud functions must set `MINIPROGRAM_STATE = 'trial'` (or `'developer'`); switch to `'formal'` after the official release. Without push enabled the app still works — due reminders are caught up on each launch.

## Holiday Rules

- `holiday` — a statutory day off: skipped when skip-holiday is on, or postponed to the next working day.
- `workday` — a weekend make-up workday: still reminds, never misjudged as a holiday.
- "Every working day" advances along Mon–Fri **plus** make-up workdays **minus** statutory holidays.
- Built-in tables cover 2026–2027 (from the State Council announcement); users can add or override any year's arrangement in the Holidays page.

## Tests

```bash
node tests/smoke.js          # recurrence engine: period advancing, holiday skip/postpone, month-end overflow
node tests/cursor.js         # push cursors: separation, no-regress, failure doesn't advance
node tests/repeat-workday.js # every-working-day recurrence across holidays & make-up days
node tests/manual-done.js    # configurable completion: auto-archive vs manual confirm
node tests/auto-calendar.js  # default calendar write on save: timing, toggle, fallback
node tests/calendar.js       # recurrence → system calendar rule mapping
node tests/save-guard.js     # idempotent save: client token, page lock, throttle
node tests/batch-done.js     # batch completion
node tests/batch-delete.js   # batch deletion
node tests/compact-list.js   # layout height budget for the compact list
node tests/subscribe.js      # subscription quota guard & throttle
node tests/holidays-active.js# holiday year filtering
node tests/verify.js         # project structure & config checks
```

All 13 suites run with plain Node — no test framework required.

## License

This project is released for learning and portfolio purposes.
