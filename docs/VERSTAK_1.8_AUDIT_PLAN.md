# Verstak 1.8 Audit Plan

Дата: 2026-07-04
База: `1.6.3`, `main`
Источник сверки: `STATUS.md`, `docs/COMPETITIVE_ROADMAP.md`, `docs/CURRENT_STATE.md`, `docs/devblog/03-pipeline.md`, внешний план `C:\Users\Pavel\Downloads\verstak-v1.8-sprint.md`.

## Вывод

v1.8 не должен быть большим "ещё всё" спринтом. Главная линия: убрать реальные agent-usability блокеры и довести Agency Delivery до предъявляемого результата.

Берём:
- explicit external read-only context для `read_file` / `list_directory`;
- model registry hardening;
- Proof Pack delivery: PDF + Telegram;
- Agency/Pipeline видимость: статус, баннер, ссылка на Proof Pack;
- release docs: `CHANGELOG.md`, migration notes, version bump в конце.

Откладываем:
- большой `ai.ts -> orchestrator` рефактор;
- Remote Pulse как полноценный Telegram control bot;
- full headless Agency parity;
- projectStore map-selector refactor;
- vectors/RAG/Docker sandbox/swarm dashboard.

## Аудит Плана

| Пункт | Статус | Решение |
|---|---|---|
| External file/folder read | Реальный баг: агент не может прочитать явно указанный файл вне активного проекта | Взять сразу как v1.8 foundation fix |
| A1 `kimi-k2.7-code` context limit | Реальный рассинхрон | Взять |
| A2 Settings stale model lists | Реальный рассинхрон, подтверждён для Moonshot | Взять |
| A3 smart fallback reorder | Нужна опора на eval, не на вкус | Взять после model registry, если данные подтверждают |
| A4 skipped tests docs | Небольшая документация | Взять только как cleanup |
| B1 `ai.ts` orchestrator extraction | Правильно, но высокий риск без прямой пользовательской ценности | Отложить до 1.8.x/1.9 |
| B2 test gap audit | Полезно, но не hero | Взять точечно: CLI loop / background routing после delivery |
| B3 unified model registry | Закрывает A1/A2 классом | Взять, но поэтапно |
| C1 Proof PDF + Telegram | Главная B2B/agency ценность | Взять |
| C2 Agent Registry UI polish | Nice-to-have | Отложить после C1/C3 |
| C3 Pipeline v1.1 Agency banner | Полезно, часть уже есть | Взять частично |
| C4 Remote Pulse | Большая infra + approve-race/security | Отложить, оставить дизайн-notes |
| C5 headless full Agency parity | Важно, но большой runtime scope | Отложить |
| D1 compact-history priority | Нет текущего блокера | Отложить |
| D2 model registry table | Зависит от B3 | Взять только после registry core |
| D3 release docs/version | Нужен для 1.8.0 | Взять в конце |

## v1.8 Scope

### Stage 13: External Context Read

Цель: Verstak должен читать явно указанные внешние файлы и папки без переключения проекта.

Сделать:
- `read_file` принимает абсолютный путь как read-only external context;
- `list_directory` принимает абсолютный путь как read-only external context;
- `write_file`, `apply_patch`, `run_command`, git/undo остаются внутри project root;
- `.env`, `.ssh`, keys, credentials, cookies остаются заблокированы;
- tool descriptions явно говорят моделям, что absolute path для чтения разрешён.

Acceptance:
- `read_file("C:\Users\Pavel\Progetc\_artifacts\...\SKILL.md")` работает из любого активного проекта;
- external `.env` / `.ssh` блокируются;
- write outside project блокируется;
- targeted tests pass.

### Stage 14: Model Registry Foundation

Status 2026-07-04: foundation implemented. Added `electron/ai/model-registry.ts`, wired Kimi K2.7 context fallback into `context-limits.ts`, synced Moonshot Settings default to `kimi-k2.7-code`, and added targeted registry/catalog tests.

Цель: модель добавляется в одно место, а Settings/context/pricing не расходятся.

Сделать:
- добавить `electron/ai/model-registry.ts` как read-only source of truth;
- перенести минимум: provider id, model id, label, context limit, default flag, agent recommendation;
- `context-limits.ts` читает registry или валидируется against registry;
- Moonshot Settings получает `kimi-k2.7-code`;
- consistency tests: no missing context limit for registry models, no Settings-only phantom for curated providers.

Acceptance:
- `getContextLimit('kimi-k2.7-code') === 256000`;
- `kimi-k2.7-code` виден в Settings для Moonshot и остаётся default;
- targeted model tests pass.

### Stage 15: Proof Delivery

Status 2026-07-04: minimal delivery layer implemented. Added `proof:export-pdf`, `proof:send-telegram`, preload/type declarations, local `document_path` upload for Telegram `send_document`, and targeted Proof/Telegram tests.

Цель: Proof Pack можно предъявить клиенту как файл и отправить в Telegram.

Сделать:
- PDF export из существующего Proof HTML;
- Telegram delivery через существующий `telegram` connector/settings;
- не ломать `.proof.json`, `.proof.html`, `.proof.md`;
- лимит размера: если PDF слишком большой, вернуть понятную ошибку/план ссылки, не падать.

Acceptance:
- `proof:generate` остаётся совместимым;
- `proof:export-pdf` создаёт читаемый PDF;
- `proof:send-telegram` отправляет PDF при настроенных `telegram_bot_token` + chat id;
- mock tests для Telegram pass.

### Stage 16: Agency Pipeline Visibility

Status 2026-07-04: minimal visibility implemented. Agent Runs proof controls now expose Proof Pack, PDF export, and Telegram delivery actions in one place.

Цель: Agency/Pipeline не выглядит как скрытый внутренний механизм.

Сделать:
- актуализировать `PipelineBanner` под шаги `Brief -> Plan -> Execute -> Verify -> Review -> Proof`;
- показать ссылку/кнопку к Proof Pack из баннера;
- проверить WorkflowsPanel: старт Agency task, активный статус, завершение;
- live smoke обновить только если меняется UX.

Acceptance:
- активный agency run виден;
- Proof доступен из баннера;
- existing workflow tests pass.

### Stage 17: Release

Сделать:
- `CHANGELOG.md` с записью `1.8.0`;
- `docs/MIGRATION-v1.8.md`;
- `STATUS.md` update;
- bump `1.6.3 -> 1.8.0` только после зелёных проверок;
- build/release по нормальному flow.

Acceptance:
- `npm run type`;
- `npm run test:fast`;
- `npm run build`;
- `npm run dist:win`;
- GitHub Release latest = `v1.8.0`.

## Non-goals

- Не открывать произвольную запись вне проекта.
- Не добавлять новых провайдеров.
- Не добавлять новых коннекторов.
- Не делать Remote Pulse full control.
- Не делать большой `ai.ts` refactor внутри delivery спринта.
- Не переписывать Settings целиком до registry core.
