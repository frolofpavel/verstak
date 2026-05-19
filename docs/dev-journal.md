# GeminiGrok — Журнал разработки

Хронология значимых изменений. Записывать каждое закрытое усилие (новая фича, фикс, рефакторинг).

| Дата | Что сделано | Коммит | Результат |
|------|-------------|--------|-----------|
| 2026-05-19 | Initial design spec (10 разделов) | `5011cde` | `docs/superpowers/specs/2026-05-19-geminigrok-design.md` — что строим, зачем, как |
| 2026-05-19 | MVP implementation plan (15 задач) | `66592aa` | `docs/superpowers/plans/2026-05-19-geminigrok-mvp.md` — пошаговый план реализации |
| 2026-05-19 | **Task 1.** Bootstrap Electron + Vite + React + TS | `fd49445` | Минимальный скелет. `npm run build` зелёный |
| 2026-05-19 | **Task 2.** Vitest + sanity-тест | `7304275` | Тестовый стенд готов |
| 2026-05-19 | **Task 3.** SQLite storage (better-sqlite3) | `2e8772f` | `db.ts` с миграциями для `settings` и `chats` |
| 2026-05-19 | **Task 4.** Settings storage с safeStorage | `df7e2f5` | Шифрованное хранение секретов через OS keyring |
| 2026-05-19 | **Task 5.** Chats history (per-project) | `2a43d07` | Сообщения изолированы по `project_path` |
| 2026-05-19 | **Task 6.** Gemini provider (@google/genai, streaming) | `8a49ad1` | `ChatProvider` интерфейс + Gemini impl |
| 2026-05-19 | **Task 7.** IPC для projects/files | `bc80b15` | `projects:pick`, `files:tree`, `files:read` |
| 2026-05-19 | **Task 8.** Project store (Zustand) + Sidebar UI | `7490cbb` | Дерево файлов с глубиной до 5, ignore для `node_modules`/`.git` |
| 2026-05-19 | **Task 9.** Settings UI + AI IPC | `0be92df` | Модалка ввода API ключа, главный IPC для чата |
| 2026-05-19 | **Task 10.** Chat UI + Gemini streaming | `9c196f0` | Сообщения с ролями, авто-скролл, streaming в реальном времени |
| 2026-05-19 | **Task 11.** Chat history persistence | `60eb8d7` | История загружается при открытии проекта, сохраняется на `done` |
| 2026-05-19 | **Task 12.** File tools (read/list/write) + multi-turn loop | `2fc81a7` | AI читает файлы и предлагает изменения. Max 5 turns |
| 2026-05-19 | **Task 13.** DiffView + write_file confirmation | `cfc257b` | Modal с diff'ом, Accept/Reject, IPC `ai:resolve-write` |
| 2026-05-19 | **Task 14.** Терминал + run_command tool | `2a41fa2` | xterm.js + node-pty, AI может запускать команды |
| 2026-05-19 | **Task 15.** README + native rebuild script | `a816d31` | Документация запуска. Electron pinned to v40 (better-sqlite3 prebuild) |
| 2026-05-19 | **Fix.** Externalize electron в build | `de4785d` | electron-vite бандлил electron в main.mjs → ошибка "failed to install". Добавлен `externalizeDepsPlugin` |
| 2026-05-19 | **Feature.** Gemini CLI provider (подписка) | `cc450f9` | Subprocess `gemini` с stream-json. Пользователь подключает свою Gemini Ultra подписку без API ключа |
| 2026-05-19 | **UX.** Ярлык на рабочем столе | — | `Desktop/GeminiGrok.bat` — двойной клик и запускается |
| 2026-05-19 | **Design.** Полный UI редизайн | `(см. ниже)` | Geist Sans/Mono, GitHub-dark тема, markdown + highlight.js, новый layout. Sidebar с дискверным брендом, status footer с провайдером, новая модалка Settings, DiffView v2, тема терминала |
| 2026-05-19 | **Feature.** Model pill в composer'е | — | Под полем ввода справа виден текущий провайдер `Gemini 2.5 Pro · API` или `Gemini Ultra · CLI`. Кликабельно — открывает Settings. Добавлен `hooks/useProvider.ts` (polling settings) |
| 2026-05-19 | **Feature.** Вложения: файлы, скриншоты (Ctrl+V), drag-drop | `dc60a8f` | Кнопка скрепки в composer'е, обработчик paste для clipboard images, drag-drop overlay. API режим — `inlineData` в Gemini (нативная multimodal). CLI режим — упоминание имён файлов в промте. Лимит 5MB/файл, 8 файлов |
| 2026-05-19 | **Security.** Аудит от Codex → закрытие критики | `(см. ниже)` | По итогам внешнего ревью закрыт MUST-блок безопасности (3 фикса) + SHOULD-блок UX (3 фичи) |
| 2026-05-19 | **Security 1.** Path boundary для `files:read` IPC | `(в составе security commit)` | Главный процесс трекает активный проект (`state/project-state.ts`); `files:read` нормализует путь и отказывается читать вне корня. Лимит на размер файла 2MB |
| 2026-05-19 | **Security 2.** `run_command` confirmation flow | `(в составе security commit)` | Раньше команды выполнялись неявно через `execSync`. Теперь IPC показывает модалку `CommandConfirm.tsx`, ждёт явное Accept/Reject. Внутри — `execFile` с timeout 60s, captured stderr, exit code |
| 2026-05-19 | **Security 3.** Denylist деструктивных команд | — | `ai/command-policy.ts`: hard-блок 11 паттернов (rm -rf /, format, mkfs, dd of=/dev, fork bomb, shutdown, curl|sh, sudo rm, git push --force, git filter-repo, чтение ~/.ssh / .aws / .npmrc). 12 unit-тестов. Blocked-команды не доходят до confirmation — сразу отказ с причиной |
| 2026-05-19 | **UX.** Activity log + Changed files summary | — | Под сообщением Gemini виден список действий (read/write/command) с цветовым статусом pending/ok/rejected/blocked. После окончания ответа — выделенный блок "Изменены файлы (N)" с зелёной рамкой |
| 2026-05-19 | **UX.** Stop streaming (Esc / красная кнопка) | `7fd7e07` | `ai:stop` IPC с AbortController per-send. CLI subprocess убивается, API loop вылетает на следующей итерации. Незавершённые подтверждения auto-rejected чтобы модалки не зависали |

---

## Архитектурные решения

### 2026-05-19 — Multi-provider через ChatProvider interface
Один интерфейс для всех способов подключения AI:
```typescript
interface ChatProvider {
  id: string
  name: string
  models: string[]
  send: (messages, tools, toolResults) => AsyncIterable<ChatEvent>
}
```
Текущие реализации: `gemini-api` (через `@google/genai` SDK), `gemini-cli` (subprocess `gemini` CLI).
Готовится: `claude-api`, `claude-code-cli`, `gpt-api`, `codex-cli`.

### 2026-05-19 — Settings как key/value в SQLite + safeStorage
Все значения (включая не-секреты типа `provider`) проходят через `safeStorage.encryptString` → base64 → SQLite. Шифрование симметричное, OS-native. Доступ через `settings:get-key` / `settings:set-key` IPC.

### 2026-05-19 — Чаты в SQLite, в БД приложения, не в `.geminigrok/` проекта
Изначально проектировали хранить историю в папке проекта (`.geminigrok/chats.db`), но в реализации перешли на единую БД в `app.getPath('userData')`. История разделяется по полю `project_path`. Перенос на per-project DB — отдельная задача если понадобится "взять с собой" историю.

### 2026-05-19 — Externalize нативных модулей в build config
`electron`, `better-sqlite3`, `node-pty` помечены как `rollupOptions.external` в `electron.vite.config.ts`. Иначе Vite пытается бандлить их runtime-код и приложение падает при старте. См. фикс `de4785d`.

### 2026-05-19 — Tools API для AI, но не для CLI
AI tools (`read_file`/`list_directory`/`write_file`/`run_command`) работают только в API режиме (через function calling в Gemini). В CLI режиме gemini-cli сам управляет файлами внутри — diff-подтверждение не показывается. Эта несимметрия — осознанный trade-off. Чтобы вернуть diff в CLI режим, нужно парсить output gemini-cli'а (как делает Cursor с Claude Code).

---

## Известные ограничения / технический долг

- **Electron pinned на v40.** better-sqlite3 ещё не выпустил prebuilt бинарники для Electron 42+ (ABI 146). При апгрейде Electron надо ждать prebuild или собирать better-sqlite3 из source.
- **`npm test` после `electron-rebuild`.** Native модули собираются для Electron, Vitest падает. Чтобы тестировать — `npm install --legacy-peer-deps` (восстанавливает node-бинарники), потом снова `electron-rebuild` перед `npm run dev`.
- **Renderer bundle 1.5 MB.** Из-за highlight.js (с языками) и зависимостей React/Zustand/Markdown. Не критично для desktop приложения, но при packaging .exe можно оптимизировать code-splitting.
- **Вложения не сохраняются в истории.** В DB записывается только текстовый markdown с упоминанием файлов (`📎 screenshot.png`). При перезагрузке проекта картинок в старых сообщениях больше нет. Если понадобится — сохранять base64 в `chats.content` JSON-блобом или отдельной таблицей `attachments`.
- **run_command без подтверждения.** AI может выполнять любые shell-команды без подтверждения пользователя. Для production-сценариев нужен подобный diff-подтверждению UI или whitelist команд.
- **CLI режим: каждый запрос — новая сессия.** `gemini` CLI вызывается как subprocess для каждого сообщения, контекст сессии не накапливается. История чата в нашей UI есть, но в gemini-cli не передаётся (gemini-cli получает только последнее user-сообщение).
- **Один проект за раз.** Открыть второй проект параллельно нельзя — store перезаписывается. Tabs или multi-window — отдельная фича.

---

## Следующие шаги (черновик)

1. **Multi-provider (v0.2).** Claude API + Claude Code CLI + GPT API + Codex CLI. Дизайн уже описан в брейнсторме (Settings → список провайдеров + переключатель в чате).
2. **Сохранение вложений в истории.** Хотя бы для последних N сообщений, иначе reload теряет картинки.
3. **Multi-chat per project.** Сейчас один линейный чат на проект. Хорошо бы — список бесед, как в ChatGPT/Claude.
4. **Inline edit для AI.** Когда AI правит файл — открывать прямо в Monaco-editor вместо отдельной модалки. Удобнее для серий правок.
5. **Distributable installer.** electron-builder → `.exe` с подписью.
