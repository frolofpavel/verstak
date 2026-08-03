# Техразведка: ядро Verstak → headless Node-сервис (облачный Verstak, Этап 1)

Дата: 2026-08-04. База: `db73d8b` (2.4.1). Постановка линии —
`Планы/Верстак/детали/online-verstak.md` («свой Manus», раздел «Следующий шаг»).
Метод: три параллельных прохода по зонам (tool-handlers/гейты · connectors/artifacts/
skills/storage · runner-цепочка/AiDeps) с транзитивным замыканием импортов; несущие
утверждения перепроверены по живому коду вручную. Только разведка — код не менялся.

---

## Главный вывод

**Ядро уже отрезано от Electron почти начисто — граница проведена по `electron/ipc/`
и она аккуратная.** В `electron/ai/**` (170 файлов) — ноль прямых импортов `electron`.
В `electron/connectors/**` и `electron/storage/**` — тоже ноль (единственное исключение
`storage/project-icons.ts` — не на пути прогона). Вся связь с окном сведена к
интерфейсу из двух функций — `TaggedSender { send, exec }`
(`electron/ipc/tool-handlers/shared.ts:23–28`), и **headless-заглушка этого интерфейса
уже существует и работает в проде** (`electron/ipc/ai.ts:359`, путь scheduled-прогонов).

Жёсткий блокер импорта ядра в чистом Node — **ровно один файл**:
`electron/runtime-log.ts:1` (`import { app, ipcMain } from 'electron'` на верхнем
уровне). Его тянут значением четыре файла: `runner-api.ts:50`, `runner-plain.ts:23`,
`grok-cli.ts:13`, `connectors/yandex-wordstat.ts:15`. Ирония: `baseDir()` внутри уже
имеет фолбэк без Electron (`runtime-log.ts:13–18`) — падает только сам top-level
import при резолве модуля. Лечение — расщепить файл (ipcMain-регистрация отдельно,
`app` — лениво/инъекцией); одна правка разблокирует импорт всего ядра. Сегодня это
обходится только `vi.mock('electron')` в тестах (`tests/ipc/agent-loop.test.ts:14`).

---

## 1. Где ядро цепляется за Electron/renderer — полный перечень

Легенда: **ЛЕГКО** — вырезается/заглушается без потери Этапа 1 · **ЗАМЕНА** — нужен
серверный эквивалент · **УЗЕЛ** — архитектурное решение.

| Место | Что именно | Характер | Вердикт |
|---|---|---|---|
| `electron/runtime-log.ts:1` | top-level `import { app, ipcMain }`; тянут runner-api/runner-plain/grok-cli/yandex-wordstat | Единственный жёсткий блокер импорта ядра | **ЗАМЕНА** (правка одного файла) |
| `electron/ipc/tool-handlers/browser.ts:62` + `browser-ready.ts:46,50` | Все 11 `browser_*` идут через `sender.exec(code)` → `webContents.executeJavaScript` → renderer → `window.verstakBrowser` над `<webview>` (`src/components/BrowserView.tsx:43–62`) | Единственный потребитель `exec` во всём репо | **УЗЕЛ**, но на Этапе 1 браузер исключён по постановке → выключить через allowlist. Для Этапа 2 — драйвер CDP/Playwright под тот же контракт `window.verstakBrowser`; `browser.ts` тогда не меняется вовсе |
| `electron/ipc/tool-handlers/screen.ts:11,81` | `await import('electron')` (desktopCapturer/screen) — ленивый, внутри хендлера | Ломается только `screen_capture`/`screen_info` | **ЛЕГКО** — исключить 2 инструмента |
| `electron/ipc/ai.ts` (registerAiIpc) | `ipcMain` для `ai:send` + через `ai-resolve.ts` — `ai:stop/suspend/append-context/resolve-write/resolve-command/resolve-plan` | Транспорт. Логика диспетчера (`ai:send` — сборка провайдера, deps, resume) переиспользуема, но обёрнута в ipcMain | **ЗАМЕНА** — HTTP/WS-роутер поверх той же логики; `resolvePending` (`ai-resolve.ts:21–39`) и Map'ы уже чистые |
| `electron/ai/runner-progress.ts:43` (`tagSender`) | Единственная фабрика TaggedSender поверх `Electron.WebContents` (тип — ambient, не рантайм-импорт); единственный вызов — `ipc/ai.ts:548` | Шов уже чистый | **ЗАМЕНА** — своя реализация из двух функций (SSE/WS-эмиттер); образцы: no-op `ai.ts:359`, собирающий-в-массив `tests/live/agent-control-plane.live.test.ts:59` |
| `electron/main.ts:650–795` | Сборка `AiDeps` (обёртки над db+settings+undo+journal), `main.ts:379–383` — путь БД через `app.getPath('userData')` | Композиция, не логика | **ЗАМЕНА** — серверный bootstrap: `openDb(path)` уже параметризован, все фасады строятся от db |
| `electron/ipc/terminal.ts` | node-pty, `ipcMain`, BrowserWindow | Пользовательская терминал-панель — **не** инструмент агента; в ядре node-pty не используется вообще | **ЛЕГКО** — не переносится |
| `electron/mobile-bridge/run-proxy.ts:7–23` + `src/App.tsx:126–144` | `chat.send` извне проксируется ЧЕРЕЗ renderer (`mobile:run-request` → renderer зовёт `ai.send` → события обратно через renderer) | Костыль десктопа; сам transport (`transport.ts`, `adapter.ts`, relay по env-ключам) — чистый и готовый | **УЗЕЛ-подарок**: в headless `run-proxy` и оба хука App.tsx исчезают — sender пишет в relay напрямую |
| `electron/storage/project-icons.ts:1` | `app`, `nativeImage` | Десктопная фича | **ЛЕГКО** — не переносится |
| CLI-провайдеры (`claude-cli.ts`, `codex-cli.ts`, `gemini-cli.ts`, `grok-cli.ts`) | Electron не тянут (кроме grok-cli через runtime-log), но требуют бинарей + интерактивного OAuth на машине (`cli-auth.ts`, `codex-oauth/`, каталог `cli-accounts` в userData — `main.ts:600`) | Причина выключения — OAuth, не Electron | **ЛЕГКО** — на Этапе 1 только API-транспорт (так уже делает `runScheduledHeadless`, `ai.ts:293–298`) |
| Остальной `electron/ipc/*` (chats, plans, undo, settings, journal, …) | `ipcMain.handle` — тонкие обёртки над чистыми storage-фасадами | Транспорт | **ЗАМЕНА** — нужные ручки становятся HTTP-эндпоинтами; логика не меняется |

Отдельно про зависимости package.json: runtime-деп почти весь Node-совместим
(better-sqlite3, docx, mammoth, exceljs, unpdf, diff, официальные SDK провайдеров).
Electron-специфичны только `electron-updater`, node-pty и renderer-пакеты (react,
xterm) — ничего из этого ядру не нужно. better-sqlite3 на сервере — обычный
`npm rebuild` под Node ABI (без @electron/rebuild).

## 2. Что уже чистое и переносится как есть

Подтверждено транзитивным замыканием импортов (не только прямым грепом):

- **runner-цепочка целиком**: `runner-api.ts` (вход — один объект `AgentRunContext`,
  runner-api.ts:146–218), `runner-plain.ts` (`PlainRunContext`, :45–59),
  `runner-shared/progress/supplements/util/attempt/tool-turn/tool-outcome/
  verification/finalize`, `sub-agent-loop.ts`. `AiDeps` импортируется type-only.
  Единственный хвост — runtime-log (см. выше).
- **tool-handlers: 35 из 37 модулей** — только Node (fs/net/child_process). Включая
  весь `delegation/*` (delegate/parallel/orchestrate/swarm + durable job-runtime),
  `web.ts` (web_fetch/web_search на глобальном fetch + SSRF-guard `node:dns`, не
  `electron.net`), `command.ts`, `file-ops.ts`, `verification.ts`, `outcome.ts`,
  `memory.ts`, `execute-code.ts` (PTC на `node:vm`), `artifacts.ts`, `mcp.ts`.
  Исключения — только `browser.ts` и `screen.ts` (§1).
- **Все 34 файла connectors** — ноль npm-зависимостей, ноль Electron; секреты
  приходят колбэком `ConnectorContext.getSecret` (`connectors/types.ts:44–49`),
  ни один адаптер не знает про safeStorage. SSRF-защита (`ip-guard.ts`) уже
  подключена в http/onec — на сервере нужнее, чем на десктопе.
- **Инфраструктура**: `mode-policy.ts` (ноль импортов, чистая `decide()`),
  `secret-scanner.ts`, `path-policy.ts`, `with-retry.ts`, `compact-history.ts`,
  `compose-system.ts`, `system-layer.ts`, `user-layer.ts`, `context-pack.ts`,
  `cli-prompt.ts`, `command-policy.ts` + `dangerous-commands.ts`, `bash-allowlist.ts`.
- **`charts.ts`** — ноль импортов вообще, свой SVG-рендерер. **`artifacts.ts`** —
  fs + npm `docx`; `app.getPath` не использует, пути от `projectPath`, downloads
  уже параметризован (`generateDocx(..., { downloadsDir })`, artifacts.ts:154).
- **`skills/`** — все 8 файлов чисты; корни поиска уже параметризованы
  (`LoaderConfig.roots`, loader.ts:80 — поле добавлено ради изоляции тестов, для
  сервера это готовый рычаг: `roots: ['/srv/verstak/skills']`).
- **`storage/db.ts`** — `openDb(path)` принимает путь параметром; ~15 тестовых
  файлов уже открывают БД вне Electron. `storage/settings.ts` — инъектируемый
  `SafeStorageLike` из 3 методов. Чекпойнты crash-resume
  (`agent_run_checkpoints`, storage/agent-runs.ts:534–555) — чистый Node.
- **API-провайдеры** (`gemini.ts`, `claude.ts`, `grok.ts`, `openai.ts` +
  `openai-compat` со всеми 8 совместимыми) — официальные SDK, изоморфный JS.
- **Уже работающие headless-контуры**: `runScheduledHeadless` (`ipc/ai.ts:264–403`,
  null-sender + те же гейты, но на урезанном `sub-agent-loop`), `scheduler.ts`
  (тикает без окна, итог в Telegram), `autonomous.ts`, `AgentJobScheduler`
  (durable-очередь; шов `deps.execute` свободен — `main.ts:471` исполнителя не
  передаёт, это готовая точка для серверного воркера).

## 3. Три узла

### (а) Секреты: чем заменить safeStorage

Замена тривиальна по коду и нетривиальна по продукту.

**Код.** `createSettings(db, safe: SafeStorageLike)` — интерфейс из трёх методов,
Electron не импортируется. Серверная реализация — AES-GCM с мастер-ключом из
env/KMS, подставляется одной строкой bootstrap'а. Уже есть и env-фолбэк:
`main.ts:432–436` делает `settings.getSecret(key) ?? process.env[ENV_MAP[key]]`
(сейчас ENV_MAP покрывает 5 AI-ключей — для сервера расширить на коннекторные).

**Продукт (настоящий вопрос узла) — мульти-тенантность.** Вся модель хранения
десктопа — «одна БД = один пользователь»: `settings` — глобальный key/value, ключи
коннекторов пользователя лежат рядом с чатами. На сервере секреты РАЗНЫХ
пользователей смешивать в одну таблицу нельзя. Самый дешёвый путь, не ломающий ни
строчки ядра: **sqlite-файл на пользователя (или на workspace)** —
`openDb('/data/users/{uid}/verstak.db')` + серверный `SafeStorageLike` с per-user
ключом. Это сохраняет и chats/plans/checkpoints per-user бесплатно. Постановка
(«секреты только в серверном хранилище, в браузер не попадают») выполняется
дизайном: реестр коннекторов отдаёт наружу только ИМЕНА недостающих ключей
(`withHonestStatus`, connectors/registry.ts:92–105), значения не покидают main —
эта дисциплина уже в коде.

### (б) Confirm-гейты без окна

Механика гейтов транспорт-агностична уже сейчас: `decide()` в `mode-policy.ts` —
чистая функция; `diffConfirmWrite` (`file-ops.ts:54–182`) и `awaitCommandConfirm`
(`shared.ts:250–266`) кладут Promise в module-singleton Map'ы
`pendingWrites`/`pendingCommands` (`runner-shared.ts:66,69`, ключ
`${sendId}::${callId}`) и эмитят `pending-write`/`pending-command` через
`sender.send`. Резолвят их сейчас ipcMain-хендлеры `ai:resolve-write/command`
(`ai-resolve.ts:63–69`) —**вся замена: два HTTP/WS-эндпоинта, зовущих тот же
`resolvePending`**. Abort-разрыв ожидания по `ctx.signal` уже встроен.

Кто подтверждает на сервере — вопрос продукта, и у него три яруса:

1. **Этап 1 минимум**: режим `auto` + Этап-1-allowlist инструментов. Опасное
   вырезано составом инструментов (нет run_command/browser), записи заперты
   workspace'ом задачи (`allowed_write_roots` + path-policy), коннекторы
   read-only (`readOnlyConnectors: true` — как в scheduled-пути). Подтверждать
   нечего — карточек не возникает.
2. **Кабинет онлайн**: pending-события уходят в стрим (узел «в»), кабинет
   показывает ту же карточку diff'а, ответ — POST на resolve-эндпоинт. Задача
   при этом честно ВИСИТ до ответа — для «поставил и закрыл вкладку» нужен
   таймаут-дефолт (отклонить и продолжить/остановиться), его в коде нет — писать.
3. **Асинхронное согласование** (закрыл вкладку — решил утром): паттерн уже
   построен для планов — прогон завершается, не ожидая человека, решение приходит
   через `plans:resolve-approval` по чекпойнту (`plan-await.ts`,
   `plansAwaitingApproval`, runner-shared.ts:143). Перенос этого паттерна на
   write-confirm — отдельная работа Этапа 2, для Этапа 1 не нужна.

### (в) События прогресса наружу (SSE/WS)

Готово больше, чем ожидалось. Все события прогона (стрим-текст, tool-activity,
agent-progress, pending-*) идут через одну воронку — `sender.send('ai:event',
{id, event})`. Серверный `TaggedSender` = «писать в канал задачи» (SSE или WS),
это ~30 строк. Двойная опора уже в коде:

- **Durable-таймлайн**: `agent_runs` + `agent_run_events` пишутся В БД независимо
  от renderer'а — «вернулся к готовому: полный таймлайн» из постановки Этапа 1
  собирается чтением из БД, а не из живого сокета. Плюс `waitForRun`
  (`ai/run-lifecycle.ts`) — polling завершения, headless-friendly.
- **Внешний transport уже написан**: `mobile-bridge/transport.ts` + `adapter.ts`
  (relay по `VERSTAK_MOBILE_RELAY_URL/TOKEN`, команды chat.send/run.stop/
  changes.list, события `run.event`). Его единственный дефект — `run-proxy.ts`
  гоняет запуск и события ЧЕРЕЗ renderer; в headless это исчезает: sender пишет
  в relay напрямую, `run-proxy.ts` и хуки `App.tsx:126–144` не переносятся.

Единственная содержательная работа — маппинг `sendId` (эфемерный int процесса) ↔
`runId` (durable UUID) для реконнекта клиента: сейчас mobile-bridge использует
`runId = String(sendId)`, для облака каналом должен быть runId.

## 4. Оценка Этапа 1 (веб-чтение + коннекторы + артефакты + файлы workspace, БЕЗ shell/браузера)

Состав инструментов Этапа 1 из уже существующих чистых: `web_fetch`, `web_search`,
`list_connectors`, `connector_query` (read-only), `render_chart`, `generate_html`,
`generate_docx`, `convert_file`, `edit_spreadsheet`, `read_file`/generic-read,
`write_file`, `apply_patch`, `create_plan`, память/журнал/todo. Выключаются
составом allowlist'а (механизм `allowedTools` уже есть — `runScheduledHeadless`
так и работает): `run_command`, `run_until_green`, `spawn_process`, `dev_server`,
`browser_*`, `screen_*`, `execute_code`, `delegate_*` (на первый релиз), ssh-
коннектор (одна строка `registry.ts:39` или env-флаг).

| # | Работа | Объём |
|---|---|---|
| 1 | Расщепить `runtime-log.ts` (ipcMain-часть отдельно, `app` лениво) — разблокирует импорт ядра в Node | 0.5 дня |
| 2 | Bootstrap headless-хоста: `openDb(pathПоUID)`, серверный `SafeStorageLike`, сборка AiDeps-аналога (по образцу `main.ts:650–795`), провайдер через `buildProviderRuntimeOptions` (урок CODE-AUDIT: не собирать опции руками), реестр коннекторов, skills c `roots` | 2–3 дня |
| 3 | Транспорт: серверный `TaggedSender` → SSE/WS канал по runId; HTTP-ручки start/stop/suspend/status; resolve-эндпоинты поверх `resolvePending`; таймлайн-чтение из `agent_run_events` | 2–3 дня |
| 4 | Запуск ПОЛНОГО `runApiConversation` headless (сегодня headless-путь сидит на урезанном `sub-agent-loop`): собрать AgentRunContext вне `ai:send`, прогнать с null/SSE-sender, снять расхождения | 1–2 дня |
| 5 | Workspace задачи: known roots per task, `allowed_write_roots`, `downloadsDir` override, allowlist Этапа 1, `readOnlyConnectors: true` | 1 день |
| 6 | Security-долг переноса: `readFile` по пути из аргументов модели в `telegram.ts:147` и `yandex-disk.ts:99` прогнать через path-policy (на десктопе терпимо, на сервере — примитив чтения произвольного файла) | 0.5 дня |
| 7 | Мульти-тенантный слой секретов (per-user ключи коннекторов, API поверх settings) | 1–2 дня |
| | **Итого ядро-сторона (репо verstak)** | **≈ 8–12 рабочих дней** |

Вне этой оценки (зона agi-iri/Gateway, отдельная постановка): authn по сессии
кабинета/API-ключу, списание через биллинг, UI пульта задач в кабинете, деплой.

Риски, двигающие оценку вверх: (1) `runApiConversation` никогда не гонялся
headless целиком — харнесы `agent-loop.test.ts` дают уверенность, но живой прогон
на сервере обязателен и может вскрыть неучтённые швы; (2) мульти-тенантность —
если «sqlite на пользователя» не устроит (масштаб, бэкапы), альтернативы дороже
недели; (3) билд-контур: ядро сейчас собирается electron-vite'ом — headless-сервису
нужна своя сборка (esbuild/tsc) поверх тех же исходников, в оценке сидит в п.2,
но при сюрпризах с путями/alias может съесть лишний день.

Что сознательно НЕ предлагается: выпиливать `electron/ipc/*` или перекраивать
десктоп. Headless-сервис — второй потребитель ТЕХ ЖЕ модулей ядра (как тесты
сегодня); десктоп не трогается, дрейфа двух реализаций нет (`scripts/verstak-cli.mjs`
— существующий независимый headless-агент на 1747 строк — этим требованиям НЕ
отвечает: это второй контур, а не переиспользование, в фундамент не брать).
