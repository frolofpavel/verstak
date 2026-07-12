# Code Health Baseline — Verstak

**Ветка:** `quality/phase-0-1` (от `main` @ `c6c09c2`, версия 2.0.5)
**Снято:** 2026-07-12
**Скрипт метрик:** `node scripts/code-health-report.mjs` (детерминированный, без секретов и сети)

Это стартовая точка Фазы 0 плана `Verstak-план-улучшения-кода.md`. Числа воспроизводимы: секция METRICS ниже перегенерируется скриптом на том же коммите в те же значения.

## Baseline-прогоны

Замерено в рабочем дереве ветки `quality/phase-0-1` (в дереве присутствуют 3 неотносящихся к плану modified-файла владельца — `electron/ai/baseline-verify.ts`, `scripts/verstak-cli.mjs`, `tests/scripts/verstak-cli-toolname.test.ts`; они НЕ включены в ветку и на прогоны не влияют).

| Проверка | Результат | Время (wall) |
|---|---|---:|
| `npm run type` (tsc --noEmit) | ✅ PASS, 0 ошибок | ~50 c |
| `npm run test:fast` (vitest) | ✅ 311 файлов passed / 2 skipped · **2508 tests passed / 9 skipped / 0 failed** | ~150 c (duration 140.9 c) |
| `npm run build` (electron-vite) | ✅ PASS | ~14 c |

Среда: Windows 11, Node **v24.14.0**, better-sqlite3 под Node ABI 137 (safe-rebuild в pretest).

## Известные флейки среды (НЕ регрессии — не чинить в этой сессии)

- **`tests/scripts/verstak-cli-toolname.test.ts` под Node 24** — 4× таймаут, когда порт 11434 СВОБОДЕН (undici × тест-мок keep-alive, verstak-cli HTTP виснет); когда порт занят — тест сам себя скипает (`if(!canBind)return`). В baseline-прогоне порт 11434 удерживался фоновым сокетом → тест ушёл в skip, поэтому test:fast зелёный. Без держателя порта возможен таймаут-флейк. См. память `verstak-cli-toolname-node24-flake`.
- **ABI-лок better-sqlite3** — массовые падения sqlite-тестов с `NODE_MODULE_VERSION` означают открытый `npm run dev` (Electron держит нативный модуль), НЕ регрессию. Проверять по type + не-sqlite тестам.
- **Timeout-флейки на Windows** (`eval-cheap-models` и подобные) — одиночный rerun файла обычно зелёный; не «чинить» рефактором.

## Как перегенерировать метрики

```bash
node scripts/code-health-report.mjs
```

Печатает сводку в stdout и перезаписывает секцию METRICS ниже. Шапка и baseline-секция сохраняются.

## METRICS (авто-генерация: scripts/code-health-report.mjs)

> Детерминированный статический снимок. Перезапуск на том же коммите даёт те же числа.

| Показатель | Значение |
|---|---:|
| Продакшн TS/TSX (electron/ + src/) | 475 файлов, 89348 строк |
| Тестовый TS/TSX (tests/) | 313 файлов, 29024 строк |
| Тест-кейсов (статически it/test) | 2463 |
| Функций > 100 строк | 129 |
| Функций > 200 строк | 53 |
| `as any` (prod) | 2 |
| `: any` (prod) | 11 |
| `@ts-ignore` (prod) | 2 |
| `@ts-nocheck` (prod) | 0 |
| `eslint-disable` (prod) | 17 |

### Топ-15 крупнейших prod-файлов

| Строк | Файл |
|---:|---|
| 5433 | `src/components/Settings.tsx` |
| 4261 | `src/components/Chat.tsx` |
| 1527 | `electron/ai/runner-api.ts` |
| 1495 | `electron/ai/tools.ts` |
| 1320 | `src/types/api.d.ts` |
| 1301 | `electron/ipc/ai.ts` |
| 1220 | `electron/ipc/tool-handlers/delegation.ts` |
| 1145 | `electron/storage/db.ts` |
| 1121 | `src/store/projectStore.ts` |
| 902 | `electron/ai/skills/built-in.ts` |
| 814 | `src/components/ProjectRail.tsx` |
| 803 | `electron/main.ts` |
| 667 | `src/components/AgentRunInspector.tsx` |
| 656 | `src/components/Sidebar.tsx` |
| 633 | `electron/autoupdate/service.ts` |

### Функции > 200 строк (53)

| Строк | Функция | Файл:строка |
|---:|---|---|
| 3639 | `Chat` | `src/components/Chat.tsx:541` |
| 2679 | `Settings` | `src/components/Settings.tsx:1655` |
| 1325 | `runApiConversation` | `electron/ai/runner-api.ts:201` |
| 948 | `registerAiIpc` | `electron/ipc/ai.ts:349` |
| 828 | `anonymous` | `src/store/projectStore.ts:286` |
| 778 | `anonymous` | `electron/ipc/ai.ts:388` |
| 681 | `renderConnectorForm` | `src/components/Settings.tsx:2498` |
| 581 | `ComposerToolsMenu` | `src/components/ComposerToolsMenu.tsx:22` |
| 513 | `anonymous` | `electron/main.ts:289` |
| 484 | `ProjectSettings` | `src/components/ProjectSettings.tsx:15` |
| 482 | `UpdatesSettings` | `src/components/UpdatesSettings.tsx:46` |
| 468 | `ProvidersPage` | `src/components/Settings.tsx:4392` |
| 454 | `McpTab` | `src/components/Settings.tsx:1200` |
| 448 | `App` | `src/App.tsx:103` |
| 448 | `ProjectRail` | `src/components/ProjectRail.tsx:366` |
| 415 | `anonymous` | `src/components/Chat.tsx:1323` |
| 412 | `anonymous` | `src/components/Chat.tsx:1324` |
| 405 | `ModelsPage` | `src/components/Settings.tsx:5028` |
| 384 | `ProjectRulesView` | `src/components/ProjectRulesView.tsx:243` |
| 370 | `runPlainConversation` | `electron/ai/runner-plain.ts:26` |
| 369 | `SideChat` | `src/components/SideChat.tsx:33` |
| 364 | `AuthScreen` | `src/components/AuthScreen.tsx:49` |
| 349 | `PlanView` | `src/components/PlanView.tsx:21` |
| 336 | `DevTaskPanel` | `src/components/DevTaskPanel.tsx:42` |
| 313 | `createGrokCliProvider` | `electron/ai/grok-cli.ts:309` |
| 312 | `PolicyTab` | `src/components/Settings.tsx:817` |
| 302 | `send` | `electron/ai/grok-cli.ts:318` |
| 302 | `send` | `src/components/Chat.tsx:2559` |
| 300 | `renderConnectorsTabV3` | `src/components/Settings.tsx:3433` |
| 290 | `registerDevTaskIpc` | `electron/ipc/dev-task.ts:114` |
| 289 | `SkillsView` | `src/components/SkillsView.tsx:216` |
| 288 | `anonymous` | `src/components/Chat.tsx:3244` |
| 276 | `handle` | `electron/ipc/tool-handlers/delegation.ts:943` |
| 269 | `registerProjectIpc` | `electron/ipc/projects.ts:55` |
| 264 | `RunDetail` | `src/components/AgentRunsPanel.tsx:66` |
| 261 | `AgentsPanel` | `src/components/AgentsPanel.tsx:104` |
| 257 | `SetupWizard` | `src/installer/SetupWizard.tsx:23` |
| 252 | `renderConnectorsTab` | `src/components/Settings.tsx:3180` |
| 248 | `handle` | `electron/ipc/tool-handlers/delegation.ts:369` |
| 243 | `registerDeferredIpc` | `electron/main.ts:556` |
| 241 | `ChatNavSection` | `src/components/Sidebar.tsx:21` |
| 238 | `CreateClientModal` | `src/components/CreateClientModal.tsx:65` |
| 236 | `createGeminiProvider` | `electron/ai/gemini.ts:50` |
| 236 | `createFileTools` | `electron/ai/tools.ts:1175` |
| 226 | `createClaudeCliProvider` | `electron/ai/claude-cli.ts:153` |
| 224 | `send` | `electron/ai/gemini.ts:60` |
| 223 | `handle` | `electron/ipc/tool-handlers/delegation.ts:96` |
| 218 | `ReviewPanel` | `src/components/ReviewPills.tsx:76` |
| 215 | `send` | `electron/ai/claude-cli.ts:162` |
| 215 | `reduceAgentProgress` | `src/lib/agent-progress.ts:196` |
| 211 | `createReviewSlice` | `src/store/review-slice.ts:68` |
| 205 | `RemindersView` | `src/components/RemindersView.tsx:32` |
| 203 | `ModelPicker` | `src/components/ModelPicker.tsx:140` |

### Обходы типизации — где именно

- `as any` (2): electron/ai/gigachat.ts×1, electron/ipc/undo.ts×1
- `: any` (11): electron/ai/codex-oauth/provider.ts×1, electron/ai/secret-scanner.ts×1, electron/connectors/avito.ts×1, electron/connectors/kontur-focus.ts×1, electron/connectors/mpstats.ts×1, electron/connectors/notion.ts×6
- `@ts-ignore` (2): electron/ai/skills/built-in.ts×1, electron/ai/skills/recipe.ts×1
- `eslint-disable` (17): electron/ai/office.ts×4, electron/ipc/tool-handlers/files.ts×1, src/components/Chat.tsx×2, src/components/DiffView.tsx×1, src/components/MentionPopup.tsx×1, src/components/ScheduledTasksView.tsx×1, src/components/Settings.tsx×3, src/components/Sidebar.tsx×1, src/components/SlashCommandPopup.tsx×2, src/components/TerminalErrorToast.tsx×1

