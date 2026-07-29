# CLAUDE.md — регламент проекта Verstak

Файл читается user_layer'ом Verstak и Claude Code как «правила работы с этим проектом». См. `electron/ai/user-layer.ts` — порядок поиска: AGENTS.md → CLAUDE.md → GEMINI.md → .verstak/RULES.md.

> **📋 ЖИВОЙ ПЛАН РАБОТ.** Источник, который видит Павел — **Планы внутри Verstak** (вкладка «План», проект `verstak`, таблица `plans`/`plan_steps` в `%APPDATA%/verstak/storage/verstak.db`). Зеркало в git — `STATUS.md` в корне (чтобы не терялось и я мог читать без БД). В начале сессии прочитать STATUS.md; после закрытого блока — ОБНОВИТЬ оба: строки в «Сделано», дата/версия сверху. Павел не должен держать это в голове.
> **Как обновить Планы в Verstak:** через `node --experimental-sqlite` + `node:sqlite` (DatabaseSync), `PRAGMA busy_timeout`, INSERT/UPDATE в `plans`/`plan_steps`. **`project_path` брать из `process.cwd()`** (скрипт запускать из корня проекта), НЕ из JS-литерала с бэкслешами — `"...\verstak"` ломается escape'ами (`\v`=vertical tab, `\U` и т.п.) и план оседает с битым путём, невидимый под проектом (так осиротел план #10, чинено 23.06). НЕ через `require('better-sqlite3')` — его ABI скачет между Node(тесты) и Electron(сборка). После записи UI обновляется при ре-открытии вкладки «План».

---

## 1. Что это за проект

**Verstak** — десктопный AI coding agent (Electron + TypeScript + React + Zustand + better-sqlite3). Позиционируется как высококонтролируемая, независимая альтернатива Cursor / Antigravity, заточенная под российские реалии 2025–2026.

**Ключевая ценность:** контроль, прозрачность, мульти-провайдерность.

**Базовые фичи:**
- **18 провайдеров:** база (10) — Gemini API/CLI, Claude API/Code, Grok API/CLI, OpenAI API, Codex CLI, GigaChat, YandexGPT; плюс 8 OpenAI-совместимых (DeepSeek, Qwen, Mistral, Moonshot, Groq, OpenRouter, Ollama, custom endpoint). Аккаунт упал — переключился, не теряя работу.
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
│   ├── registry.ts          сводный список провайдеров (10 база + 8 OpenAI-совм.)
│   ├── types.ts             ChatMessage / ChatEvent / ChatProvider
│   ├── gemini.ts, claude.ts, grok.ts, openai.ts  ← API-провайдеры
│   ├── *-cli.ts             ← CLI-провайдеры (Claude Code и т.п.)
│   ├── cli-prompt.ts        ← общий serializer истории для CLI
│   ├── runner-api.ts        ← ЯДРО agent-loop API-пути: runApiConversation (вынесено из ai.ts, 1.9.8 #1)
│   ├── runner-plain.ts      ← ядро CLI/one-shot пути: runPlainConversation
│   ├── runner-shared.ts     ← общий синглтон-стейт runner↔ai.ts: pending-registry + turn-константы (разрыв circular-dep)
│   ├── runner-progress.ts   ← эмиссия прогресса agent-loop в UI
│   ├── runner-supplements.ts← ai:append-context во время прогона (conversationSupplements)
│   ├── runner-util.ts       ← чистые хелперы runner'ов (selectAllowedToolDefs, retriableErrorEvent)
│   ├── runner-attempt.ts    ← попытка провайдера внутри хода
│   ├── runner-tool-turn.ts  ← исполнение tool-хода
│   ├── runner-tool-outcome.ts← сбор итога tool-хода для журнала сессии
│   ├── runner-verification.ts← проверки перед финалом хода
│   ├── runner-finalize.ts   ← финализация прогона
│   ├── ptc.ts               ← execute_code: vm-песочница + read-only тулзы (за флагом ptc_enabled)
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
│   ├── ai.ts                ← IPC-shell: registerAiIpc + resolve/stop/suspend + scheduled headless (ядро loop'а вынесено в ai/runner-*.ts, 1.9.8 #1)
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
├── store/                 ← 8 модулей; состояние чата живёт ТОЛЬКО в chats (PerChatState 4.4)
│   ├── projectStore.ts    ← основной zustand store, 1153 строки
│   ├── session-snapshot.ts← типы одной сессии + фабрика пустого снапшота
│   ├── chat-lifecycle.ts  ← enterChat/leaveChat, перевод чата в фон и обратно
│   ├── chat-bundle-update.ts + apply-snapshot-event.ts ← применение событий к bundle
│   ├── review-slice.ts + pipeline-slice.ts ← Explicit Review и pipeline
│   └── skillStore.ts      ← V3: список скиллов + activeSkillId
├── components/            ← UI компоненты
│   ├── chat/              ← 12 модулей, вынесенных из Chat.tsx (пакет 2.1.11):
│   │     ComposerSkillBar / ComposerInputRow / ComposerMetaRow / ComposerBudgetBar,
│   │     ChatStreamMessages (рендер потока) / message-parts / ChatRunControls,
│   │     PromptRouteControl, send-chat-message, send-help-message, skill-prompts,
│   │     system-slash-commands
│   ├── RuntimeFlagsTab.tsx — вкладка «Поведение агента» (рантайм-флаги, 27.07)
│   ├── SkillPicker.tsx + SlashCommandPopup.tsx — V3 skill UX
│   ├── ArtifactPreview.tsx + ArtifactsPanel.tsx — V3 артефакты
│   ├── OnboardingWizard.tsx + ProfilesTab.tsx — V3 multi-user
│   ├── TerminalErrorToast.tsx — V3 sidecar terminal intelligence
│   ├── ReviewButton.tsx + ReviewPills.tsx — Explicit Review V1
│   ├── CheckpointButton.tsx + TimelineBar.tsx — UX штурм V1
│   └── (остальные старые)
├── hooks/                 ← useProvider / useAgentMode / useTheme
├── lib/                   ← compose-review-payload, pricing, runtime-flags
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

**Шума в тестах НЕТ (проверено 28.07).** Зелёный прогон = **0 падений**. Прежняя запись про «8 известных sqlite-падений по `NODE_MODULE_VERSION`» устарела: `pretest:fast` гоняет `scripts/safe-rebuild.cjs`, который приводит better-sqlite3 под нужный ABI сам. Шесть полных прогонов подряд 27–28.07 дали 0 падений при 447+ файлах.

**ЛЮБОЕ падение — регрессия.** Не списывать на «известный шум»: этой отговорки больше не существует. Если тест упал по таймауту — сначала зафиксировать его личность (`--reporter=json --outputFile`), потом перезапускать: повторный прогон затирает улику. Два таких таймаута уже вылечены явными лимитами (`2fe6c2c`, `136eba9`).

### 3.1 Правила исполнителя (не выводятся из кода — читать всегда)

Список добыт дорого, каждая строка стоила потерянного времени. Он здесь, а не в тексте
задания, чтобы очистка контекста сессии ничего не стоила.

- **Полный гейт после каждой задачи, без сокращений:** `check:mojibake` → `lint:full`
  (0 errors) → `type` → `test:fast` (0 падений) → `build` → `check:performance` →
  `git diff --check`.
- **`lint:full` и `lint:changed` разной строгости.** Хук на изменённых файлах ловит то,
  чего не видит полный прогон (например switch-exhaustiveness как ошибку). Проверять
  изменённое надо тем, чем гоняет хук, иначе упрёшься на самом коммите.
- **Никогда `git add -A` и `git commit -a`.** В рабочем дереве периодически лежит чужая
  незакоммиченная работа; `add -A` утаскивает её в твой коммит. Только явный `git add`
  по своим файлам. «Чистое дерево» = чистое **от твоей** работы.
- **Хрупкая зона: подписка `ai.onEvent` в `src/components/Chat.tsx`** ставится ОДИН раз
  за жизнь экрана. Её пересоздание теряет события МОЛЧА — без падений и красных тестов.
  Не трогать. 46 пинов characterization чата обязаны оставаться зелёными без правок.
- **Существующие пины не править под изменение.** Правка утверждения — подгонка. Правка
  фикстуры при неизменных утверждениях допустима, но объявляется в отчёте. Если пин
  мешает — сначала доказать, что он стережёт ОТМЕНЁННЫЙ контракт, и сказать об этом прямо.
- **Сначала тест, воспроизводящий дефект, потом фикс.** Тест обязан краснеть на текущем
  коде. Мутация фикса — обязательная проверка, что пин не декоративный.
- **«Падает под нагрузкой» ≠ «тесный лимит».** Сначала измерить, ЧТО именно
  долгое, и только потом решать: убрать работу или поднять бюджет. 28.07 из
  четырёх упавших файлов три лечились УДАЛЕНИЕМ работы и только один — лимитом.
  Мерить надо под реальным условием отказа (максимум по каждому тесту из
  json-отчётов полных ПАРАЛЛЕЛЬНЫХ прогонов), а не соло-запуском: соло меряет не
  то, что роняет.
- **Бюджет теста, равный глобальному `testTimeout` (20 000) или больший, запаса
  не даёт вовсе.** Сравнивать надо с двумя числами сразу: с измеренным временем
  И с глобальным лимитом. Внутренний бюджет ожидания (`AbortSignal.timeout`,
  `waitFor`, свои хелперы) обязан быть заметно МЕНЬШЕ таймаута своего теста —
  иначе осмысленная ошибка ожидания превращается в безымянный таймаут прогона.
  Третий аргумент `it()` — исключение: он для того и существует, чтобы превышать
  глобальный.
- **Прогон, собравший МЕНЬШЕ тестов, чем эталон, — не вердикт, а оборванный
  запуск.** Эталон на 30.07: `numTotalTests` = **4385**
  (4371 passed + 14 skipped); до него 4377, 4370, 4364, 4358, 4353, 4348, 4321, 4310, 4290, 4285, 4278, 4274, 4267, 4256, 4237, 4212.
  Эталон живёт константой
  `EXPECTED_TOTAL_TESTS` в `scripts/release-gate.mjs` — добавил тесты, подними и её,
  иначе обрезанный прогон однажды проедет как полный.
  Меньше — значит часть файлов не дошла до сбора, и результат нельзя трактовать ни
  зелёным, ни красным: он не о коде. Сначала восстановить полноту (разгрузить
  машину, снизить параллелизм), и только потом судить о падениях. Публикацию 2.2.21
  дважды отменяли по «N failed» из прогонов на 4179 и 4172 теста — на тихой машине
  тот же код, те же артефакты, тот же гейт дали 0 падений с первого раза. Причина
  ограничения параллелизма — ПАМЯТЬ, не ядра: при 11 воркерах свободной ОЗУ
  остаётся 129 МБ, при 4 — 2.4 ГБ (замер в шапке `scripts/release-gate.mjs`).
  Сверку с эталоном делает сам гейт, отдельной проверкой перед вердиктом.
- **Счёт падений — не вердикт. Вердикт — это СООБЩЕНИЯ плюс УСЛОВИЯ прогона.**
  За одни сутки 29.07 красное трижды оказывалось не о коде: 559 падений от ABI
  нативного модуля (приложение держало `better_sqlite3.node`), 4179/4172 от
  недособранного набора, 10 падений от чужой НЕДОПИСАННОЙ правки в общем рабочем
  дереве. Каждый раз счёт и имена выглядели приговором и приговором не были.
  Перед тем как объявить красное регрессией, обязательны три вещи:
  1. **Сообщения, а не имена.** Имя теста не отличает упавшее утверждение от
     таймаута и от сорванного импорта, а лечатся они по-разному. `expected … to
     be …` — код; `Test timed out in 20000ms` — нагрузка; `ReferenceError … is
     not defined` — сломанный или недописанный модуль. Полный вывод гейт
     сохраняет сам в `release/gate-tests-failure.log`.
  2. **Условия названы.** Нет параллельного полного прогона (два vitest'а по 11
     воркеров на одной машине независимыми прогонами не являются), приложение
     закрыто (иначе ABI), параллелизм указан явно — гейт ставит `--maxWorkers=4`,
     голый `npm run test:fast` берёт дефолт, и это разные условия.
  3. **`test:fast` проверяет РАБОЧЕЕ ДЕРЕВО, а не коммит.** Прогон в дереве, где
     кто-то прямо сейчас пишет, вердиктом не является в принципе: 29.07 полный
     набор поймал файл, сохранённый наполовину, — переменная уже использовалась и
     ещё не была объявлена. Такого состояния не было ни в одном коммите. Сначала
     `git status` и уверенность, что в дереве никто не пишет; для суждения о
     конкретном коммите — прогон на нём (`git checkout <sha>` или worktree).
- **Артефакт релиза привязан к коммиту, поэтому ЛЮБАЯ правка после сборки её
  обесценивает.** Гейт сверяет `release/BUILD_PROVENANCE.json` с HEAD: один коммит
  после сборки — и провенанс красный, нужна пересборка (10–15 мин). Значит починки,
  найденные во время релиза, собираются в ОДИН коммит и делаются ДО сборки, а не
  между сборкой и публикацией. 29.07 прошли этот круг дважды и потеряли час.
- **Тест, читающий реальные домашние деревья запускающего, невоспроизводим по
  построению.** На одной машине он видит 272 скилла, на чистой — ноль, и однажды
  соврёт в любую сторону. Изоляцию задавать ЯВНО (параметр «только эти корни») и
  закреплять пином, что посторонние источники не подмешиваются.
- **`write_file` НЕ РАБОТАЕТ по файлу, который secret-scanner считает секретным**
  (гард в `diffConfirmWrite`, 29.07). Замер по живому дереву: 16 исходников из
  588 — реестр провайдеров, все четыре обработчика делегирования, `ipc/ai.ts`,
  `model-catalog.ts`, `codex-oauth/*`. Настоящих секретов там нет, срабатывает
  `auth-keyword-value` на обычном коде. Правь такие файлы `apply_patch`'ем: он
  ложится на СЫРОЕ содержимое и специально оставлен без гарда. Отсюда же
  неочевидное: **литеральный пример секрето-подобной строки, написанный в
  комментарии или в тесте, срабатывает САМ** и запирает свой файл для
  `write_file`. Один раз уже наступили — пример ложного срабатывания в
  комментарии `file-ops.ts` запер `file-ops.ts`. Перечень снимается прогоном
  `scanText` по `electron/` и `src/`, наизусть не помнить.
- **Проверка на отсутствие события нуждается в контрольном кейсе.** «Таймаут не сработал»
  зелено и тогда, когда тест ничего не проверяет; рядом должен стоять зеркальный случай,
  который обязан упасть (образец — сетка §10 план-гейта).
- **UI под jsdom:** реальный конвейер отправки из смонтированного `Chat` НЕ завершается —
  любое асинхронное ожидание после Enter (`await act`, флаш микрозадач, `setTimeout`)
  вешает прогон без вывода. Характеризация — только синхронные проверки через `act()`,
  события подавать прямой эмиссией (образец `tests/components/chat-usage-cost.test.ts`).
  Спаи в `window-api-mock` ленивые: считать через
  `mock.calls.get(name)?.mock.calls.length ?? 0`.
- **Зелёные тесты ≠ работающая функция.** Пользовательскую функцию главный процесс может
  отдавать правильно, пока в renderer она не работает вовсе (так §10 показывала карточку,
  которую тут же снимало событие `done`). Если функцию нельзя доказать со стороны
  пользователя — сказать об этом прямо, а не закрывать задачу зелёным прогоном.
- **Частичный результат называется частичным ПРЯМО В ЗАГОЛОВКЕ**, с явным перечнем
  остатка. Ожидание из постановки сравнивать с фактом в самом отчёте.
- **Стоп-правила:** не чинится за 2 попытки без изменения поведения — остановиться на
  последнем зелёном и записать остаток; кончается контекст — остановиться и записать
  карту остатка. Часть лучше, чем всё красное. Работа, вставшая на середине жизненного
  цикла прогона, опаснее несделанной.

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

> Актуализировано 2026-07-27. Каждая цифра ниже перепроверена командой на живом
> коде, а не переписана из прошлой версии.

1. **~~ГЛАВНЫЙ монолит — `electron/ipc/ai.ts`~~ РАСПИЛЕН (1.9.8 #1 → пакет 2.1.10):** было ~3360 строк, стало **1104** (−67%). Оба гиганта вынесены в `ai/runner-*.ts`: `runApiConversation` (~1300) → `runner-api.ts`, `runPlainConversation` (~419) → `runner-plain.ts`; circular-dep разорван через `runner-shared.ts` (pending-registry + turn-константы), `AiDeps` type-only. Каждый переезд верифицирован харнесами `tests/ipc/agent-loop.test.ts`(30)+`plain-loop.test.ts`(17) — поведение идентично; 2 адверсариальных ревьюера подтвердили (identity разделяемого состояния + семантика байт-в-байт). `ai.ts` = IPC-shell (registerAiIpc ~700 + resolve/stop/suspend + scheduled headless). **Остаток:** registerAiIpc можно дробить дальше, но это уже НЕ гигант-функция — низкий приоритет. При правках runner'ов держать харнесы зелёными.
   - `src/store/projectStore.ts` — **1153 строки**, но монолитом уже не является: PerChatState закрыт полностью (срез 4.4, `ef4af73`). Состояние чата живёт ТОЛЬКО в `chats`; `chatSnapshots` и тройное хранение удалены, `chat-lifecycle.ts` держит единый `enterChat`/`leaveChat`. Прежняя запись про «`ChatSessionLifecycle` НЕ сделан и `chatSnapshots`-race» устарела — `chatSnapshots` остался лишь в исторических комментариях.
   - `src/components/Chat.tsx` — **3205 строк** (было 4122). Пакет 2.1.11 закрыт: вся разметка вынесена в 12 модулей `src/components/chat/`, поведение закреплено 46 пинами characterization. Осталось ~394 строки JSX против ~2810 строк логики, поэтому дальнейшее сокращение = декомпозиция эффектов, а это другой класс риска (подписка `ai.onEvent` ставится один раз за жизнь экрана — её пересоздание теряет события молча). Не брать без отдельной постановки со своей сеткой.
   - Крупное, что осталось нетронутым: `src/components/Settings.tsx` **4662** строки, `src/styles/layout.css` **22055** строк. Решение 27.07 — не трогать: техдолг без пользовательского эффекта.
   - Дубли renderer↔main (нет shared-модуля из-за context-изоляции): `CLI_WITH_TIMELINE`, `secretProtectionLevel`, `GATEWAY_PRESET_LABELS`, `ProviderId`, `PRICES` — держать синхронно, часть покрыта анти-дрейф-тестами.

2. **CLI-путь: session-continuity (Mode C) НЕ построена; разведка проведена 27.07.** Проекция tool-таймлайна, честные runtime-ярлыки, Control Envelope (git-якорь + откат из UI), permission-mode/guard секретов claude-cli, account-switch на лимите — ВСЁ есть (1.9.5–1.9.7). Остаётся: каждый ход CLI сериализует всю историю в one-shot `--print`. **Проверено живьём на `claude 2.1.207`: нативная сессия ЕСТЬ** (`-c/--continue`, `-r/--resume`, `--session-id`, `--fork-session`), `--resume` удержал один `session_id` на три хода. Значит допущение в шапке `electron/ai/cli-prompt.ts` («CLI providers in `stream-json` mode are effectively ONE-SHOT») для claude-cli устарело. НЕ снято: input-токены по ходам (не было авторизованного CLI) — размер выигрыша неизвестен, реализацию начинать рано. Отчёт и команда для досъёма: `docs/cli-session-recon-2026-07-27.md`.

3. **Тест-покрытие критичных путей — выросло.** Хорошо: agent-loop API (`agent-loop.test.ts`, 30), CLI-путь (`plain-loop.test.ts`, 17), multi-chat routing (`project-store-routing.test.ts`), композер и поток чата (46 пинов в трёх сетках `tests/components/chat-*-characterization.test.ts`), рантайм-флаги (30 пинов), PTC (`ptc.test.ts` + `execute-code-*`), compact-history/with-retry/pricing/apply-patch. Прежняя запись «`cross-verify.ts` (0 тестов)» **неверна**: `tests/ai/cross-verify.test.ts` существует и содержит 10 тестов. Реально слабое место — review flow целиком и часть ipc handlers.

4. **Long-running resilience — checkpoint-resume ПОСТРОЕН** (Crash-resume Фаза 1/2: per-turn snapshot `agent_run_checkpoints` с троттлингом, reconcileStale на старте, findResumable + ResumeBanner с гардом деструктива, provider-guard возобновления). Остаётся: Mode C session-continuity (см. п.2).

5. **Multi-agent ПОСТРОЕН (delegate/parallel/orchestrate/swarm + durable jobs)** — старый монолит `delegation.ts` распилен: файл оставлен двухстрочным re-export, реализация живёт в `electron/ipc/tool-handlers/delegation/`. Durable control plane хранит job-состояние, переживает рестарт и не позволяет writer'у выйти за разрешённый scope. Реальный пробел — адверсариальный iterative **debate** (тезис↔критика↔синтез) поверх swarm-арбитра и live-приёмка полного сценария. PTC (`execute_code`) построен и остаётся за флагом `ptc_enabled` (по умолчанию выключен). 27.07 доказан периметр: в песочнице ровно пять read-only тулзов, права совпадают с `run_command` во всех пяти режимах, гейт под пином; петля проверена на реальных файлах (итог в контексте >10× короче суммы сырых tool-результатов). Не хватает одного — прогона, где МОДЕЛЬ сама вызывает инструмент; условие включения описано в аудите.

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

Последнее обновление: 2026-07-27 (позиция 5 плана работ: §2 и §5 сверены с кодом покомандно — размеры ai.ts 1104, projectStore 1153, Chat.tsx 3205, Settings 4662, layout.css 22055; добавлены 12 модулей `components/chat/` и полный список `ai/runner-*`; снята неверная запись про 0 тестов у cross-verify; обновлены Mode C и PTC). Если архитектура изменилась — обнови этот файл.
