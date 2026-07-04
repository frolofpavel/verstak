# Migration Notes - Verstak 1.8.0

## Who Should Read This

Users updating from `1.6.3` to `1.8.0`.

## Data And Settings

- No database migration is required for the v1.8.0 foundation changes.
- Existing provider keys remain in encrypted settings.
- Existing Telegram settings are reused:
  - `telegram_bot_token`
  - `telegram_notify_chat_id`
  - `telegram_chat_whitelist`

## Behavior Changes

- Agents can read explicit absolute file/folder paths outside the active project as external context.
- External access is read-only. File writes, patches, shell commands, git operations, and undo remain scoped to the active project.
- Secret-like paths remain blocked even when passed as absolute paths.
- Moonshot Kimi defaults to `kimi-k2.7-code`.
- Proof Pack can be exported as PDF and sent to Telegram from the Runs panel.

## Known Limits

- PDF export is a minimal local Proof Pack export, not a full browser-rendered print pipeline.
- Telegram delivery requires a configured bot token and target chat id.
- Gateway server-side preset remaps remain an external follow-up if the mapping lives outside this repository.

## Recommended Smoke

- Open a project and ask the agent to read an explicit external non-secret file path.
- Confirm external `.env` or `.ssh` paths are blocked.
- Open Settings -> Providers -> Moonshot and confirm `kimi-k2.7-code` is available/default.
- Generate a Proof Pack from a completed run.
- Export PDF from the same run.
- Send the Proof PDF to Telegram when Telegram settings are configured.

