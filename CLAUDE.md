# CLAUDE.md — регламент проекта Verstak

Файл читается user_layer'ом Verstak и Claude Code как «правила работы с этим проектом». См. `electron/ai/user-layer.ts` — порядок поиска: AGENTS.md → CLAUDE.md → GEMINI.md → .verstak/RULES.md.

---

## 1. Что это за проект

**Verstak** — десктопный AI coding agent (Electron + TypeScript + React + Zustand + better-sqlite3). Позиционируется как высококонтролируемая, независимая альтернатива Cursor / Antigravity, заточенная под российские реалии 2025–2026.

**Ключевая ценность:** контроль, прозрачность, мульти-провайдерность.

**Базовые фичи:**
- **8 провайдеров одновременно:** Gemini API / Gemini CLI / Claude API / Claude Code / Grok API / Grok Build / OpenAI API / Codex CLI. Аккаунт упал — переключился, не теряя работу.
- **5 режимов агента** (`ask` / `accept-edits` / `plan` / `auto` / `bypass`) — переключаются 1-5.
- **Per-chat провайдер + модель.** Multi-chat со снапшотами фоновых стримов.
- **Explicit Review V1.** Кнопка 🔍 запускает ревью текущего ответа другим провайдером, результат — pill в Timeline, кнопка «↪ Учесть» переписывает в основной чат.
- **Сессионный checkpoint + per-file undo.** Откат любой агентной сессии одной кнопкой.
- **Cost controller** в статус-баре. Жёлтый > $2, красный > $5.
- **Context sliding window** для длинных сессий (старые tool results сжимаются в маркеры).
- **Exponential backoff** на 429/503/ECONNRESET.

**V3 фичи:**
- **Skills как first-class.** Frontmatter `.md` файлы → system prompt + tools_allow + context_loaders + default_provider/model. Авто-импорт из `~/.claude/skills/` + `~/.verstak/skills/` + 3 built-in (code-review / git-summary / explain-code). Picker 🎭 в composer + slash commands `/code-review`.
- **Context loaders** — frontmatter `context_loaders: [{impl, runs_on}]` авто-инжектят данные в первое user msg. Готовые: `load_client_card`, `load_clients_list`, `load_today_brief`.
- **31 коннектор:** базовые (1C OData, generic HTTP, Google Sheets, SSH с denylist, Telegram, Битрикс24, Я.Директ, Я.Диск, GitHub, Social Publish) + RU-стек (DaData, Контур.Фокус, Я.Метрика/Вебмастер/Wordstat/Трекер, GA4, Ozon Seller/Performance, Wildberries, MPSTATS, Avito, amoCRM, МойСклад, ЮКасса-чтение, SendPulse, UniSender, VK, Jira, Trello, Notion). Все read-only, свой код поверх официальных API.
- **Artifacts:** `generate_html` / `generate_docx` / `render_chart` (SVG bar/line/pie) tools. Embedded preview (HTML напрямую, DOCX через mammoth.js).
- **Multi-user profiles:** Onboarding wizard + Settings → Профили. 5 ролей с пресетами.
- **delegate_task** — мультиагент V1: основной агент делегирует sub-task другому скиллу/модели, получает результат как tool_result.
- **Sidecar Terminal Intelligence** — детектор ошибок (TS/Python/npm/ESLint) в потоке терминала → toast с кнопкой «Fix in chat».
- **Claude Code OAuth env-passthrough** — Settings field, Verstak передаёт `CLAUDE_CODE_OAUTH_TOKEN` дочернему claude процессу, headless+Max заработал.

---

## 2. Архитектура — карта

```
electron/                  ← main process (Node.js)
├── main.ts                ← entry: window, IPC регистрация, db open
├── preload.ts             ← contextBridge: window.api для renderer
├── ai/                    ← провайдеры + ядро агентной логики
│   ├── skills/              ← V3: skill loader + frontmatter + 3 built-in + loaders registry
│   ├── artifacts.ts         ← generate_html / generate_docx (docx npm)
│   ├── charts.ts            ← render_chart — SVG bar/line/pie без зависимостей
│   ├── registry.ts          сводный список 8 провайдеров
│   ├── types.ts             ChatMessage / ChatEvent / ChatProvider
│   ├── gemini.ts, claude.ts, grok.ts, openai.ts  ← API-провайдеры
│   ├── *-cli.ts             ← CLI-провайдеры (Claude Code и т.п.)
│   ├── cli-prompt.ts        ← общий serializer истории для CLI
│   ├── compose-system.ts    ← единый сборщик system prompt
│   ├── system-layer.ts      ← неизменяемый протокол агента
│   ├── user-layer.ts        ← поиск AGENTS/CLAUDE/GEMINI.md/RULES
│   ├── context-pack.ts      ← Recent writes + project map в контекст
│   ├── compact-history.ts   ← sliding window для tool results
│   ├── with-retry.ts        ← exponential backoff
│   ├── tools.ts             ← read_file/write_file/apply_patch/run_command
│   ├── mode-policy.ts       ← decide(): confirm/auto-accept/block по mode
│   ├── path-policy.ts       ← safeRealJoin: anti symlink escape
│   ├── secret-scanner.ts    ← redact API keys / tokens в logs
│   ├── review-prompt.ts     ← REVIEWER_SYSTEM_PROMPT
│   └── child-kill.ts        ← treeKill через taskkill /F /T на Windows
├── ipc/                   ← IPC handlers
│   ├── ai.ts                ← главный: ai:send / ai:stop / ai:event
│   ├── tool-handlers.ts     ← dispatch регистратор для тулзов
│   ├── chats.ts             ← chat sessions + messages
│   ├── undo.ts              ← undo stack + checkpoint API
│   ├── files.ts             ← tree / read / reveal в проводнике
│   ├── projects.ts          ← список проектов, pick, remove
│   ├── settings.ts          ← key/value в sqlite + safeStorage
│   ├── journal.ts           ← dev journal
│   ├── terminal.ts          ← node-pty
│   ├── verify.ts            ← npm test / typecheck кнопки
│   ├── autonomous.ts        ← фоновый self-improvement loop
│   ├── feedback.ts, plans.ts ← Feedback / Plans вкладки
├── storage/               ← sqlite слой
│   ├── db.ts                ← openDb + schema + migrations
│   ├── chat-sessions.ts     ← kind: 'main' | 'review', parent_chat_id
│   ├── chats.ts             ← messages
│   ├── undo.ts              ← per-file undo stack
│   ├── plans.ts, journal.ts, tasks.ts, projects.ts, feedback.ts
│   └── settings.ts          ← encrypted secrets через safeStorage
└── connectors/            ← внешние сервисы — 31 шт
    ├── registry.ts
    ├── types.ts             ← Connector interface
    ├── onec.ts              ← 1С OData
    ├── http.ts              ← generic REST
    ├── gsheets.ts           ← Google Sheets (service account JWT, без googleapis)
    ├── ssh.ts               ← SSH executor через системный ssh (denylist)
    ├── telegram.ts          ← Telegram Bot API
    ├── bitrix24.ts          ← Битрикс24 incoming webhook
    ├── yandex-direct.ts     ← Я.Директ OAuth + Reports API (sync polling)
    └── yandex-disk.ts       ← Я.Диск OAuth для шеринга артефактов с клиентами

src/                      ← renderer (React 19)
├── App.tsx                ← composition root + Onboarding + Toast + Preview
├── store/
│   ├── projectStore.ts    ← основной zustand store (см. п.5 — рефакторить!)
│   └── skillStore.ts      ← V3: список скиллов + activeSkillId
├── components/            ← UI компоненты
│   ├── SkillPicker.tsx + SlashCommandPopup.tsx — V3 skill UX
│   ├── ArtifactPreview.tsx + ArtifactsPanel.tsx — V3 артефакты
│   ├── OnboardingWizard.tsx + ProfilesTab.tsx — V3 multi-user
│   ├── TerminalErrorToast.tsx — V3 sidecar terminal intelligence
│   ├── ReviewButton.tsx + ReviewPills.tsx — Explicit Review V1
│   ├── CheckpointButton.tsx + TimelineBar.tsx — UX штурм V1
│   └── (остальные старые)
├── hooks/                 ← useProvider / useAgentMode / useTheme
├── lib/                   ← compose-review-payload, pricing
├── styles/                ← layout / theme / markdown CSS
└── types/api.d.ts         ← типы для window.api (bridge типизация)

tests/                    ← vitest
├── ai/                     ← compact-history, with-retry, apply-patch, ...
├── storage/                ← settings, chat-sessions
├── connectors/             ← onec, http
└── lib/                    ← pricing
```

---

## 3. Команды

```bash
npm run dev          # запуск в dev (electron-vite + HMR)
npm run build        # build в out/
npm run type         # tsc --noEmit
npm run test:fast    # vitest run (без rebuild native)
npm run test         # rebuild better-sqlite3 + vitest (full)
npm run dist:win     # NSIS + portable .exe
```

**Перед коммитом обязательно:** `npm run type && npm run test:fast`. Если type-check падает — НЕ коммитим.

**Известный shum в тестах:** 8 sqlite-тестов (`settings`, `chat-sessions`, `projects`) падают по `NODE_MODULE_VERSION 137 vs 143` — это better-sqlite3 скомпилирован под Electron, а vitest идёт под Node. **НЕ путать с реальными регрессиями.** Если падений становится больше 8 — смотреть что сломал.

---

## 4. Зоны файлов и правила

| Зона | Можно | НЕЛЬЗЯ |
|---|---|---|
| `electron/ai/` | новые провайдеры, тулзы, helpers | менять `system-layer.ts` (immutable протокол) |
| `electron/ipc/` | новые IPC handlers | менять контракт существующих без обновления preload + api.d.ts |
| `electron/storage/` | новые таблицы (через MIGRATIONS) | менять схему inline в `openDb()` |
| `electron/connectors/` | новые внешние сервисы | хардкодить креды, делать без validation args |
| `src/` | компоненты, hooks, lib | импорт из `electron/` (renderer не имеет доступа) |
| `tests/` | свободно | моки настолько глубокие что не тестируют реальную логику |
| `resources/` | иконки, статика | трогать без явного запроса |

**Никогда не трогать без явного разрешения:**
- `*.env`, `*.key`, `creds*.json`, `.ssh/` — секреты (path-policy блокирует).
- `out/`, `release/`, `node_modules/` — артефакты.
- `MIGRATIONS` массив в порядке индексов — только append, никогда edit/reorder.

---

## 5. Известные слабые места (приоритеты на доработку)

1. **`src/store/projectStore.ts` разрастается** (~800 строк). После Phase A (SendRegistry) часть классов race-багов закрыта, но при добавлении новых фич (фоновые агенты, debate mode) надо вынести:
   - `ChatSessionLifecycle` (enterChat/leaveChat вместо setProject + switchChatSession + newChatSession)
   - `PerChatState` (map chatId → ChatStateBundle вместо top-level полей + chatSnapshots копирования)
   - План в комментариях того же файла.

2. **CLI parity 7.5/10.** runPlainConversation проще runApiConversation: нет attachments, нет verify hints. См. `cli-prompt.ts` для разбора уже сделанного (Phase 2 cli-аудит).

3. **Тестовое покрытие критичных путей слабое.** Сильно покрыто: compact-history (6), with-retry (14), pricing (12), apply-patch. Слабо: ipc handlers, agent loop, review flow, multi-chat routing.

4. **Long-running session resilience.** Есть exitReason + journal на любой exit. Нет: checkpoint-resume агентного цикла после crash.

5. **Multi-agent (debate / delegate_task) не построена.** Phase A очистила дорогу через SendRegistry. Для делегирования нужно: новый SendOwner kind, отдельная команда tool в реестре, UI индикация какой агент сейчас.

---

## 6. Конвенции кода

- **TypeScript strict.** Любой `any` — обоснован в комментарии.
- **Минимализм.** Только запрошенный код. Без спекулятивных абстракций.
- **Сохранять существующий стиль.** Если рядом без точек с запятой — не ставь. Если используется одинарные кавычки — не меняй на двойные.
- **Комментарии на русском** для product-логики, на английском для технических деталей и API-интеграций (так уже сложилось в коде).
- **Не удалять чужой код** без явной просьбы.
- **Зависимости трогаем только лишние** (которые стали лишними от наших правок).

---

## 7. Тесты

- **Цель = тест воспроизводящий баг, потом фикс.** Не «фикс + тест который проходит».
- **Pure logic — обязательно тесты.** `compose-system`, `compact-history`, `with-retry`, `pricing` — всё покрыто.
- **IPC handlers — интеграционные, по возможности.** Через mock electron-окружения. Сейчас минимум, надо растить.
- **UI компоненты** — пока не покрываем, кроме критических (DiffView render).

---

## 8. Безопасность

- **path-policy.ts** — все file access через `safeRealJoin(projectRoot, rel)`. Никогда не использовать raw `path.join` для пользовательских путей.
- **secret-scanner.ts** — все text который попадает в lows (logs / context) пропускается через scanText. API keys / tokens заменяются на `[REDACTED:type]`.
- **isForbiddenPath()** блокирует `.env`, `*.key`, `creds*.json` — никакой write через write_file туда не пройдёт.
- **Web Speech / mic permissions:** `installMediaPermissions` явно разрешает только `media`.
- **Renderer = `nodeIntegration: false`** + `contextIsolation: true`. ESM preload требует `sandbox: false`, это known trade-off.

---

## 9. Куда писать новые фичи

- **Новый AI-провайдер:** `electron/ai/{name}.ts` + регистрация в `registry.ts`. Если это API — реализуй `ChatProvider.send` как async generator. Если CLI — посмотри `claude-cli.ts` как шаблон (treeKill + stdin payload + stream-json parser).
- **Новый коннектор (1С/Bitrix/Yandex):** `electron/connectors/{name}.ts` реализует `Connector` интерфейс (info + query). Регистрация в `connectors/registry.ts` — одна строка в BUILTINS массиве. Settings UI секция в `src/components/Settings.tsx` вкладка connectors.
- **Новый skill:** просто `.md` файл в `~/.verstak/skills/` (или редактируй `~/.claude/skills/` — авто-импортится). Frontmatter: id (обязательно) + name/description/icon/slash/tools_allow/context_loaders/suggested_prompts. Body = system prompt. Для built-in (захардкоженного fallback) — `electron/ai/skills/built-in.ts`.
- **Новый context loader:** функция в `electron/ai/skills/loaders.ts` + регистрация в REGISTRY map. Frontmatter скилла ссылается через `impl: ваше_имя`.
- **Новый tool (для агента):** TOOL_DEF в `electron/ai/tools.ts` + handler в `electron/ipc/tool-handlers.ts` (mode: parallel-read / sequential / confirm-write). Регистрируй в HANDLER_REGISTRY.
- **Новый артефакт type:** добавь kind в ChatEvent `artifact-created` + handler в tool-handlers + render в ArtifactPreview.tsx.
- **Новый IPC endpoint:** handler в `electron/ipc/{file}.ts` → bridge в `preload.ts` → тип в `src/types/api.d.ts`. Все три места.
- **Новая таблица в БД:** добавь миграцию в `MIGRATIONS` массив `electron/storage/db.ts` с НОВЫМ version номером. Никогда не правь старые миграции.
- **Новая фича UI:** компонент в `src/components/`, состояние через zustand, стили в `src/styles/layout.css` секцией с комментарием-маркером.

---

## 10. Куда НЕ писать

- **Не делать MCP Client рефактор** коннекторов сейчас — сломает текущие onec/http и блокирует приоритет российских коннекторов.
- **Не делать JSON-RPC events** стандартизацию — большой инвазивный рефактор IPC, низкий ROI пока.
- **Не строить cross-platform encryption fallback** — safeStorage на Windows работает, cross-platform при необходимости добавляется отдельно.
- **Не пытаться сделать "version 3.0" одной большой PR.** Инкрементально, фазы с тегами, каждый коммит откатывается.

---

Последнее обновление: 2026-05-22. Если архитектура изменилась — обнови этот файл.
