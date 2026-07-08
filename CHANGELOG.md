# Changelog

## 1.8.9 - 2026-07-08

### Добавлено
- Managed worktree lifecycle v1: dirty/unpushed detector, snapshot-before-remove, restore-from-snapshot, lossless remove and no-push regression coverage.
- Worktree registry actions for list/snapshot/restore/delete through IPC/preload/types and visible snapshot action in the WorktreeBar.
- Background process manager v1: `spawn_process`, `process_status`, `read_process`, `stop_process`, bounded redacted output tail, PID-reuse guard, TTL pruning and owner-bound completion queue.
- Process completion events can be routed into the next agent turn without cross-chat leakage.

### Безопасность
- Background process spawn uses the same command policy, permission rules, bash allowlist and optional smart-approval path as foreground commands.
- Real Windows anti-orphan smoke covers process-tree stop behavior.

### Проверка
- `npm run test:security` прошёл: 24 tests.
- Targeted 1.8.9 suite прошёл: 69 tests across dangerous commands, smart approval, worktree lifecycle/status and process tools.

## 1.8.8 - 2026-07-08

### Добавлено
- Security Regression Pack: typed security catalog in `tests/security/_catalog.ts`, markdown registry in `docs/SECURITY_REGRESSION_PACK.md`, and focused `npm run test:security`.
- Deterministic dangerous-command detector with deobfuscation for destructive shell commands, credential access, shell-pipe installers, force push and common RCE patterns.
- Smart Approval seed: LLM guard contract, anti-injection prompt wrapping, strict verdict parsing, deterministic deny for known-dangerous commands and hash-only audit support.

### Безопасность
- Covered classes now include path escape, command approval binding, SSRF/private redirects, skill install safety, config mutation, dotenv guard and URL secret redaction.

### Проверка
- `npm run test:security` прошёл: 7 files / 24 tests.

## 1.8.7 - 2026-07-06

### Изменено
- Подтянуты правки Ильи из ветки `codex/verstak-1.8.6-ui-model-fixes`: восстановлены UI-правки главного окна, выбора моделей и настроек.
- ModelPicker и Settings снова показывают расширенные карточки моделей, транспорт провайдера, состояние подключения и политику agent-mode.
- Обновлены правила выбора моделей и ценовые/контекстные метаданные для gateway, Grok, DeepSeek/Qwen/Kimi/GLM/MiniMax-пресетов.
- Улучшены элементы рабочего экрана: меню инструментов композера, worktree bar, восстановление окна и компактные стили Shell Atelier.

### Проверка
- `npm run type` прошёл.
- `npm run test:fast` прошёл: 2102 tests, 7 skipped.

## 1.8.6 - 2026-07-06

### Исправлено
- Установщик Windows теперь копирует и проверяет `resources/app.asar` через Electron `original-fs`, поэтому payload asar обрабатывается как обычный файл, а не как виртуальный архив.
- Silent install / автообновление больше не падает с ложной ошибкой `empty resources\app.asar`.
- Self-extract wrapper корректно передаёт `--silent --install-dir` во внутренний установщик.

### Проверка
- `npm run type` прошёл.
- Installer targeted tests прошли.
- Self-extract silent install прошёл с `LASTEXITCODE=0`.

## 1.8.5 - 2026-07-05

### Добавлено
- Навигация Settings сгруппирована в понятные блоки: приложение, AI/модели, интеграции, контроль агента, проектные данные.
- В настройках провайдеров появилась явная кнопка `Найти CLI` для установленных CLI-агентов.
- Settings → Модели и ModelPicker показывают default agent model policy: Kimi K2.7 Code — основная coding/planner/reviewer модель, DeepSeek Chat — fallback, неподходящие agent-mode модели помечены явно.
- В Settings появилась вкладка `Правила` с глобальными и проектными rules-кандидатами, активным слоем, статусом файла и безопасными действиями create/open/folder.
- Явные абсолютные `write_file` / `apply_patch` exports разрешены только внутри пользовательского Downloads.

### Изменено
- Внешние абсолютные пути по умолчанию остаются read-only context, а проектные записи остаются внутри project root, кроме явного Downloads export.
- Footer Settings теперь различает состояния: есть несохранённые изменения, сохраняю, сохранено.

### Безопасность
- Downloads exports проходят real-path проверку против symlink escape.
- Секретные пути вроде `.env`, `.ssh`, key files, credentials и cookies остаются заблокированы для read/write.
- Rules IPC ограничен зарегистрированными проектами и известными rules-файлами.

### Проверка
- `npm run type` прошёл.
- `npm run test:fast` прошёл: 2102 tests, 7 skipped.
- `npm run build` прошёл.

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
