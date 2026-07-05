# Changelog

## 1.8.5 - 2026-07-05

### Added
- Settings navigation is now grouped into clear blocks for app, AI/models, integrations, agent control, and project data.
- Provider settings include an explicit `Find CLI` action for installed CLI agents.
- Model settings and the model picker show the default agent model policy: Kimi K2.7 Code as the main coding/planner/reviewer model, DeepSeek Chat as fallback, and unsafe agent-mode choices marked clearly.
- Settings now has a `Rules` tab that shows global and project rules candidates, the active layer, file status, and safe open/create actions.
- Explicit absolute `write_file` / `apply_patch` exports are allowed only inside the user's Downloads directory.

### Changed
- External absolute paths remain read-only context by default, while project writes stay project-bound unless the target is an explicit Downloads export.
- Settings footer now distinguishes unsaved, saving, and saved state instead of looking inert after instant settings.

### Security
- Downloads exports use real-path checks to block symlink escape.
- Secret paths such as `.env`, `.ssh`, key files, credentials, and cookies remain blocked for read/write.
- Rules IPC is limited to registered projects and known rules filenames.

### Verification
- `npm run type` passed.
- `npm run test:fast` passed: 2102 tests, 7 skipped.
- `npm run build` passed.

## 1.8.0 - 2026-07-04

### Added
- Read-only external context: `read_file` and `list_directory` now accept explicit absolute paths outside the active project.
- Agent model registry foundation with Kimi K2.7 Code as the synchronized coding/planner/reviewer default layer.
- Proof Pack delivery actions: local PDF export and Telegram delivery.
- Runs panel actions for `Proof Pack`, `PDF`, and `Telegram`.

### Changed
- Moonshot Settings now exposes `kimi-k2.7-code` and uses it as the default.
- Kimi K2.7 Code has an explicit 256K context limit and visible UI pricing metadata.
- Telegram `send_document` can upload a local `document_path` as multipart form data.

### Security
- External context remains read-only: write/apply/run/git/undo stay project-root-bound.
- Forbidden paths such as `.env`, `.ssh`, key files, credentials, and cookies remain blocked.
- Proof Telegram delivery reuses encrypted settings and does not log token values.

### Verification
- `npm run type` passed.
- `npm run test:fast` passed: 2093 tests, 7 skipped.
