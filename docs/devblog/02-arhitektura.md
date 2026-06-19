# 2. Архитектура: как устроен контроль

Контроль и прозрачность — это не лозунги, а конкретные модули. Разберём, где они живут.

## Два процесса, жёсткая граница

Классический Electron: `electron/` — main-процесс (Node.js, полный доступ), `src/` — renderer (React 19, **без** доступа к Node). Renderer общается с main только через `preload.ts` (contextBridge → `window.api`). Правило в проекте железное: **renderer никогда не импортит из `electron/`**. Любой новый IPC-эндпоинт трогает три места — handler в `electron/ipc/`, мост в `preload.ts`, тип в `src/types/api.d.ts`. Забыл одно — TypeScript strict не даст собрать.

`nodeIntegration: false` + `contextIsolation: true`. ESM-preload требует `sandbox: false` — это known trade-off, осознанный.

## System-layer + user-layer: почему промпт прозрачен

Сборка system prompt разнесена:

- **`system-layer.ts`** — неизменяемый протокол агента. Его нельзя править без явного разрешения — это immutable-контракт. Здесь живёт то, как агент обязан себя вести независимо от проекта.
- **`user-layer.ts`** — ищет твои правила в порядке `AGENTS.md → CLAUDE.md → GEMINI.md → .verstak/RULES.md` и подмешивает их.
- **`compose-system.ts`** — единый сборщик, который склеивает слои + context-pack (recent writes + карта проекта) + активный скилл.

Итог: в любой момент понятно, из чего собран промпт. Нет «магии в одном файле на 2000 строк».

## Agent loop

Ядро — `runApiConversation` в `electron/ipc/ai.ts`. Цикл: модель просит tool → `tool-handlers.ts` диспатчит через `HANDLER_REGISTRY` → результат возвращается модели → повтор, пока не `done`. Поверх навешано:

- **`mode-policy.ts`** — `decide()` решает confirm / auto-accept / block в зависимости от режима (`ask` / `accept-edits` / `plan` / `auto` / `bypass`, переключаются клавишами 1–5).
- **`path-policy.ts`** — `safeRealJoin(root, rel)` против symlink-escape. Все файловые операции только через него.
- **`secret-scanner.ts`** — `scanText()` режет ключи/токены в `[REDACTED:type]`; `isForbiddenPath()` блокирует запись в `.env`, `*.key`, `creds*.json`.
- **`compact-history.ts`** — sliding window: старые tool-результаты в длинной сессии сжимаются в маркеры, чтобы не разорвать контекст.
- **`with-retry.ts`** — экспоненциальный backoff на 429/503/ECONNRESET.
- **`child-kill.ts`** — `treeKill` через `taskkill /F /T` на Windows, чтобы Stop убивал всё дерево процессов, а не только верхний `cmd.exe`.

## FileTools — одна абстракция, разные бэкенды

Все файловые тулзы агента ходят через интерфейс `FileTools` (`execute(name, args)` + `runCommand` + `classifyCommand`). Это оказалось ключевым решением: когда понадобилось научить агента править файлы **на удалённом сервере по SSH**, не пришлось трогать ни один handler — достаточно подменить реализацию `FileTools` на ssh-версию для удалённых проектов. Об этом — в посте про [удалённые проекты](07-udalennye-proekty.md).

## Хранилище

`electron/storage/` — слой над SQLite (better-sqlite3). Схема и миграции — в `db.ts`, массив `MIGRATIONS`. Правило: **только append, никогда не редактировать и не переставлять старые миграции** (на момент блога их 23). Здесь же — chat-sessions (`kind: 'main' | 'review'`), per-file undo-стек, plans, journal, tasks, зашифрованные секреты.

## Известная боль (честно)

`src/store/projectStore.ts` разросся до ~800 строк. Часть race-багов закрыли через `SendRegistry` (Phase A), но при добавлении фоновых агентов его надо доразбить на `ChatSessionLifecycle` и `PerChatState`. Полную миграцию компонентов на map-селекторы решили **не делать** — это churn без багофикса, ценность уже взята дедупликацией. Прагматизм важнее красоты.

→ Дальше: [Pipeline Brief→Proof: флагман, собранный автономно](03-pipeline.md)
