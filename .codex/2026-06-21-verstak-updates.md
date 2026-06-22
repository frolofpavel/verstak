# Verstak updates to reapply after installing new version

Date: 2026-06-21

## Auto-update

- Reworked local auto-update/install flow so payload is staged and installed without deleting required files before restart.
- Added stronger diagnostics/logging around update download, staging, install, cleanup, and failure paths.
- Added cleanup of temporary update payloads after success/failure to avoid filling drive C.
- Fixed update page/status behavior, including green success state when "Check updates" finds the current version is already actual.

## Journal

- Reworked Journal from scattered raw fragments into session/day summaries.
- Session summary should describe what was done/changed/added/deleted/discussed during the session.
- If app stays open across midnight, journal rolls over by a scheduled timer rather than minute polling.
- Removed old journal generation pattern so only the new session/day summary path remains.

## Reminders

- Added "Напоминания" under Control.
- Reminder creation supports date/time, target notification or project chat, and chat selection.
- Fixed missing `reminders` SQLite table/schema initialization.
- Reminder modal made compact.
- Clicking date/time field opens picker.
- If app is closed at due time, reminder appears on next launch and persists until closed.
- Notification reminders support close, snooze 10 minutes, and open reminders section.
- Notification "Open" routes to Reminders, not project chat.
- Chat reminders now send as user messages into the selected chat and start the AI task.
- Chat reminders no longer auto-open/switch chat.
- After chat reminder is sent, app shows toast "Команда отправлена в чат" with "Перейти в чат" and "Закрыть".
- Chat reminder message body contains only reminder title and description.
- User message from reminder has UI note: "Отправлено автоматически из раздела Напоминания".

## Sidebar / Chat State

- When opening a project, sidebar "Чат" group is collapsed by default.
- Chat planning/agent mode is stored per chat, not globally, so Help mode/settings do not leak into other chats.

## Composer / Chat UI

- Reworked crowded composer bottom bar.
- Added opaque "Инструменты чата" popover for mode/model/tools/pipeline/CLI controls.
- Removed leading ellipsis from the label.
- Removed economy model recommendation block that pushed chat upward while typing.
- Token count preview moved near autoscroll controls.
- Fixed broken fonts after composer changes.
- Made composer tools popover opaque.

## Build / Deploy

- Latest local deploy target used for verification:
  `C:\Users\RAYNER\AppData\Local\Programs\Verstak`
- Verification commands used after changes:
  `npm.cmd run type`
  `npm.cmd run dist:win`
  `npm.cmd run deploy:local`

## Important restore notes

- Do not revert unrelated dirty worktree changes.
- Reapply changes from the current `C:\Users\RAYNER\verstak` worktree after installing the new version.
- After reinstall, rebuild and redeploy locally first, then push to git when user confirms.
