# Lint Baseline — Verstak

**Ветка:** `quality/phase-0-1` · **Снято:** 2026-07-12 · **Конфиг:** `eslint.config.mjs` (ESLint 10 + typescript-eslint 8, flat, type-aware)
**Набор правил:** ровно план §1.2 (без `js.recommended`/`recommendedTypeChecked` — чтобы baseline не тонул в косметике).

> **Report-only.** Legacy НЕ чинится, массовый `--fix` НЕ запускался. Гейт `lint:changed` (в precommit) блокирует только НОВЫЕ errors на изменённых файлах; warnings — ratchet.
> Перегенерация: `npm run lint:full`. Время прогона: ~37 c (475 prod + 313 test файлов).

## Итог

**47 errors · 508 warnings** (0 реальных parse-ошибок — см. ниже).

## По правилам

| Правило | errors | warnings |
|---|---:|---:|
| `@typescript-eslint/no-misused-promises` | 28 | 0 |
| `@typescript-eslint/switch-exhaustiveness-check` | 10 | 0 |
| `@typescript-eslint/no-floating-promises` | 5 | 0 |
| `@typescript-eslint/only-throw-error` | 3 | 0 |
| `@typescript-eslint/await-thenable` | 1 | 0 |
| `complexity` (>15) | 0 | 158 |
| `max-depth` (>4) | 0 | 114 |
| `max-lines-per-function` (>120) | 0 | 105 |
| `@typescript-eslint/no-unused-vars` | 0 | 94 |
| `react-hooks/exhaustive-deps` | 0 | 25 |
| unused `eslint-disable` (`reportUnusedDisableDirectives`) | 0 | 12 |

`no-async-promise-executor`, `no-fallthrough`, `eqeqeq`, `react-hooks/rules-of-hooks` — **0 находок** (чисто).

## Топ файлов по errors

| errors | warnings | Файл |
|---:|---:|---|
| 6 | 31 | `src/components/Chat.tsx` |
| 4 | 1 | `src/components/TasksView.tsx` |
| 3 | 0 | `src/components/CommandConfirm.tsx` |
| 3 | 2 | `src/components/ReviewPills.tsx` |
| 3 | 3 | `src/components/ScheduledTasksView.tsx` |
| 3 | 29 | `src/components/Settings.tsx` |
| 3 | 0 | `tests/ai/gateway-fallback.test.ts` |
| 2 | 4 | `src/components/AgentRunInspector.tsx` |
| 2 | 0 | `src/components/ResumeBanner.tsx` |

## Подозрения на реальные дефекты

> ТЗ просит вынести отдельно floating-promise-находки, похожие на проглоченную ошибку в **IPC/agent-loop**. **Таких — 0**: ни одной floating/misused-promise в `electron/ipc/**` или `electron/ai/**` (ядро loop'а и IPC чисты по этому классу). Ниже — то, что стоит посмотреть глазами в фазах 2–5, **в этой сессии НЕ фиксится**.

### Кандидат A — floating promise в bootstrap приложения (1)
- `electron/main.ts:289` — Promise без владельца в стартовом коде main-процесса (внутри 513-строчной анонимной функции). Не ядро loop'а, но при отклонении ошибка стартапа проглатывается. Проверить владельца/catch при разборе `main.ts`.
- Остальные 4 floating — вне критичных путей: `electron/installer/main.ts:113` (инсталлер), `src/components/AuthScreen.tsx:93`, `src/components/Chat.tsx:1969` (UI), `tests/ai/lsp-client.test.ts:26` (тест).

### Кандидат B — неисчерпывающие switch в провайдер/артефакт-коде (5 из 10)
Non-exhaustive switch по union: если union вырастет новым вариантом, он молча не обработается. Проверить, что у каждого безопасный `default`:
- `electron/ai/artifacts.ts:140`
- `electron/ai/claude-cli.ts:45`
- `electron/ai/codex-cli.ts:46`
- `electron/ai/gateway-meta.ts:37`
- `electron/ai/role-tools.ts:108`

(остальные 5 switch — в UI: `src/components/ReviewPills.tsx` ×3, `src/lib/skill-suggest.ts:130`, `src/lib/staging-step-label.ts:18`.)

### Не-подозрения (класс известного паттерна, низкий риск)
- **28 `no-misused-promises`** — все в renderer: async-функции переданы как event-handler (`onClick={async …}`), 2 в hooks, 1 в installer-wizard. Классический React-паттерн; отклонение промиса не ожидается, но ошибка внутри может проглотиться. Разбирать при декомпозиции соответствующих компонентов (фаза 4), не механически.
- **3 `only-throw-error`** — все в `tests/ai/gateway-fallback.test.ts` (тест бросает не-`Error`). Тестовый код, не продакшн.
- **1 `await-thenable`** — единичный, посмотреть при касании файла.

## Warnings — ratchet (не чинить массово)

`complexity` (158), `max-depth` (114), `max-lines-per-function` (105), `no-unused-vars` (94), `exhaustive-deps` (25) — метрики сложности легаси. Это карта для декомпозиции (фазы 4–5), а не список к немедленному исправлению. `lint:changed` не даёт их РАСТИ на изменённых файлах.

## Неиспользуемые `eslint-disable` (12) → suppression ledger

`reportUnusedDisableDirectives` нашёл 12 директив, гасящих правило, которое больше не срабатывает (`electron/ai/office.ts` ×4, `electron/ipc/tool-handlers/files.ts`, `src/components/Settings.tsx` ×2, `ScheduledTasksView.tsx`, `SlashCommandPopup.tsx`, `TerminalErrorToast.tsx`, `tests/ai/office-tools.test.ts`, `tests/ai/swarm-isolate.test.ts`). Разбор — фаза 6.3 (suppression ledger), не эта сессия.
