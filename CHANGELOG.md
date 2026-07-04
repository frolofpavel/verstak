# Changelog

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

