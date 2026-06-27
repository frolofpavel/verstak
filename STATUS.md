# STATUS — Verstak

> Единый живой план работ. Открой — и сразу видно: что в проде, что осталось, что в бэклоге.
> **Обновляется в конце каждой рабочей сессии.** Не держи это в голове — держи здесь.

**Обновлено:** 2026-06-27 · **В проде:** `1.5.35` 🚀 · **Tier-2 6/6 зарелизено** (#1 LSP-нав, #6 file-rules, #4 bash-allowlist, #2 microcompact, #5 browser+MP4-Proof, #3 ветвление сессий) · **Тесты:** 1580 зелёных · **Ветка:** main · **Хвост:** T1.2 фундамент построен (swarm isolate opt-in; рой-прогон — live); UI-биты (#3 дерево, #5 browser-цикл) — 1 живой клик

> **1.5.35** 🚀 — **весь Tier-2 спринт (6/6) зарелизен.** LSP-навигация (find_definition/find_references любой язык), правила под файлы (glob-маски в AGENTS/CLAUDE.md), белый список безопасных команд (анти-обход цепочек/arg-injection), ветвление чатов (⑂ Ветвить), MP4-доказательства веб-проверки (кадры browser-прохода → видео), microcompact (обратимое промежуточное сжатие). **Финальное ревью перед шипом поймало 6 багов вкл. 2 HIGH data-loss в fork** (remove стирал ветки + осиротевшие review-leak) — все закрыты, fork-тесты вживую зелёные. Урок усилен: ревью+live-проверка обязательны для не-live-кода; за сессию 17 багов в своём коде (5 HIGH + 1 critical) пойманы до прода.

> **1.5.34** 🚀 — **live-проверка не-TS LSP с реальным pyright** поймала+починила третий баг: в 1.5.33 авто-диагностика не-TS была инертна на Windows (file-URI mismatch — регистр диска/кодировка → строгий `===` не матчил → диагностики терялись). Фикс `sameFile` (сравнение по разрешённому пути) + интеграционный тест (за `RUN_LSP_IT=1`). Также проверено: PTC хендлер end-to-end (4 теста), Ollama qwen2.5 шлёт structured tool_calls нативно (repair — фолбэк для слабых, парсер юнит-тестирован), graceful-деградация на сломанном rust-analyzer (rustup-прокси без компонента) — no-op без краша. **Урок: live-проверка так же окупается, как ревью — «фича в проде, но инертна» ловится только реальным сервером.**

> **1.5.33** 🚀 — **Tier-1 усиление по конкурентному исследованию зарелизено** (5 фич, дважды отревьюено адверсариально, 13 багов закрыто): LSP-диагностика Python/Go/Rust в петле (graceful), repair tool-call'ов слабых/RU-моделей, Inbox approvals фоновых чатов, структурная итеративная компакция, PTC `execute_code` (opt-in, default off). Все безопасны для дефолтных юзеров (LSP→no-op без сервера, PTC выключен). Сборка через bypass (дев был открыт) → закрыли дев → `dist:win` → GitHub Release v1.5.33 + latest.yml (автообновление). **Урок ревью: 2 паса (фичи + сами фиксы) поймали critical PTC-RCE и «LSP мёртв на Windows» — для не-live-кода ревью обязателен; см. [[verstak-tier1-strengthening-2026-06-24]].**

> **1.5.32** — воронка Verstak→Gateway добита (после сверки с тем, что Codex отдаёт на шлюзе): `verstak/free` (🎁 проба) в пресетах → проба за 0₽; онбординг первого запуска предлагает Gateway первым/рекомендованным (рубли, один ключ, без VPN, ссылка на ключ за 30 сек) вместо недоступных из РФ зарубежных провайдеров; кликабельные CTA — ссылки чата открываются в браузере (не уводят окно), ссылка пополнения при нехватке баланса кликабельна. Плюс **pre-commit гейт «гарантия вместо обещания»** (`.githooks/` + `core.hooksPath`, type жёстко + тесты с ABI-awareness, gate-lib под TDD) — закрыт вариант 2 решения по скилл-архитектуре. Хвост: smoke `verstak/free` реальным `vsk_live_` (Codex/Pavel — шлюз проверяет ключ до модели).

> **1.5.31** — батч усиления по итогам сравнения исходников с конкурентами (внутр.): SSRF-guard коннекторов (ip-guard + redirect-loop), prompt-injection escape user/skill-layer, redactUrlSecrets (query/fragment/userinfo), undo unlink-ошибки в failed[], undo DB-first ordering, авто-компакшн (output-резерв + cooldown + usage-учёт + error-guard), CRLF регресс-тест. Всё TDD, 3 ревью-роли + security review. Tier-2 (tool-call-cap/interrupted/tokenizer/prefix-cache) — обоснованно отложены (см. `Downloads/Verstak-усиление-vs-...md`).

> **1.5.28** — безопасность + надёжность по итогам глубокого код-ревью (workflow 12 агентов + адверсариальная верификация): 🔴 закрыт обход isForbiddenPath в SSH-файл-тулзах (секреты на ssh-проектах), Retry-After в backoff, человеко-понятные ошибки провайдера, фикс утечки per-chat состояния при restore, фикс тихого неполного отката (undo prune защищает пост-чекпоинт записи). Все по TDD.
> **1.5.27** — стабильность по конкурентному ревью (OpenCode/KiloCode): дедуп дублей (5.2), сброс состояния при закрытии проекта (5.3), безопасный фолбэк с накопленной историей (6.2), рефактор ядра в `AgentRunContext` (6.1).


---

## 🆚 Усиление по конкурентному исследованию (24.06) — РОУДМАП

Многоагентное исследование (32 агента, grounded в коде Verstak + адверсариальная верификация) vs OpenCode/KiloCode/OpenClaw/Hermes/Cursor/Antigravity → план `Downloads/Verstak-исследование-конкурентов-2026-06-24.md`, память `verstak-competitor-research-2026-06-24`. **Вердикт: НЕ гнаться за Cursor по in-editor (нет редактора = другая категория, осознанный non-goal). Сосём на (1) агентной петле на не-TS коде, (2) своём же «agent не IDE» углу (Inbox/TG).**

Реализовано автономно по TDD (каждый коммит через pre-commit гейт) + дважды отревьюено адверсариально (13 багов закрыто) → **зарелизено в `1.5.33` (25.06)**. Остаётся live-проверка не-TS петли (pyright) и PTC (ptc_enabled):

- ✅ **T1.5 tool-call repair** (75d56f5) — слабые/RU-модели (Ollama/GigaChat/Qwen/Mistral/gpt-oss), отдающие вызов ТЕКСТОМ, теперь исполняются (парсер 5 форматов в `tool-call-repair.ts`, встроен в openai-compat только для не-structured → сильные не затронуты; +9 тестов). Заодно fix гейта (многострочная better-sqlite3 ABI-ошибка). РФ-моат.
- ✅ **T1.6 структурная итеративная компакция** (147f2ef) — `buildCompactSummaryPrompt` со схемой Goal/Constraints/Progress/Files + `extractTouchedFiles` (провенанс) + итеративное обновление прошлого резюме (`lastSummary` в ai.ts). +6 тестов.
- ✅ **T1.3 Inbox approvals** (536a756) — `selectInboxApprovals` агрегирует pendingCommand по всем чатам, панель `InboxApprovals` (резолв фоновых не заходя в чат). +4 теста. UI — 1 живой клик.
- ✅ **T1.1 мультиязычный LSP в петле** (0a3997b) — write_file Python/Go/Rust → языковой сервер (pyright/gopls/rust-analyzer), ERROR-диагностики в следующий ход (как tsc для TS). `lang-servers.ts` (ядро, +10 тестов) + `lsp-diagnose.ts` (graceful spawn). Live-проверка нужен установленный pyright/gopls.
- ✅ **T1.4 PTC `execute_code`** (5b50e76) — агент пишет скрипт, оркестрирующий READ-ONLY тулзы, в контекст только итог (меньше токенов). Движок `ptc.ts` (vm-песочница без process/require/fs, таймаут, +9 тестов). **Opt-in** (`ptc_enabled`, default off — ждёт live-проверки петли; выключенным невидимо, нулевой риск).
- 🟡 **T1.2 git-worktree изоляция swarm — ФУНДАМЕНТ построен + отревьюен** (`8fe0814`→`9c22cb1`, 27.06): `git-worktree.ts` (add/remove/list/diff/isGitRepo, graceful, чистит ambient GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE — гейт сам обнажил этот баг; +7 тестов на реальном git) + opt-in `isolate` в `swarm` (executor правит в своём worktree → git diff к арбитру → главный применяет выбранный в main; researcher/critic в main; cleanup в finally). Additive, default OFF. **Адверсариальное ревью → 3 бага, вкл. 🟠HIGH «изоляция инертна» (ctx.tools был забинден на главный root → executor писал в main, worktreeDiff читал пустой wt → клоббер не устранён) — это ровно тот re-root FileTools, ради которого деферили; починен через `createToolsForProject(memberRoot)→subCtx.tools`. + MEDIUM ENOBUFS-diff фолбэк на --stat, low rmSync-guard.** type+тесты зелёные. **Хвост: сквозной рой-прогон с реальными правками — live-проверка (провайдеры).**
- 🔍 **Ревью №1 (все 5 фич)** — workflow 19 агентов × верификация → **9 багов из 14, закрыты по TDD:** 🔴CRIT PTC vm-побег → RCE (`59e6601`); 🟠LSP spawn без shell → ENOENT на Windows + EPIPE-краш + мульти-файл (`55b1c0d`); 🟠T1.5 Format 5 на прозе с JSON (`e90ac10`); 🟠T1.6 пропуск propose_edits (`1c15471`); T1.3 ghost-approval + sendId (`6523197`).
- 🔍 **Ревью №2 (ФИКСЫ ревью №1 — их никто не смотрел)** — workflow 11 агентов → **ещё 4 дефекта в моих же фиксах, закрыты (`a7ffb17`):** LSP `child.kill` убивал только cmd.exe → осиротевший pyright (фикс: treeKill); T1.3 ghost-модалка оставалась в АКТИВНОМ чате (фикс закрыл только фон); T1.5 проза с примером РЕАЛЬНОЙ тулзы + обёртки (фикс: dominant-content для Format 5); **PTC async-вектор остался открыт** (тулзы возвращали host-Promise → `.then.constructor` → побег) — закрыт по-настоящему через vm-native Promise. **Урок: ревью ФИКСОВ обязателен — «лиса проверяет курятник» (фиксы писал и проверял один и тот же), нашлось 4 дефекта вкл. недозакрытый critical. vm в процессе принципиально не изолирует → ОСНОВНОЙ контроль PTC = гейтинг как команда (trust run_command), vm-хардинг лишь defense-in-depth.**
- 🧭 **Tier-2 (дифференциаторы) — 4/6 в main** (TDD → адверсариальное ревью → фиксы; не зарелизено):
  - ✅ **#1 LSP-навигация** `find_definition`/`find_references` (семантика через язык-сервер; `70fca63`→`254daa2`; live pyright + ревью 6 багов).
  - ✅ **#6 file-scoped rules** `.verstak/rules/*.mdc` (условные правила по glob в user-layer; `a49b89c`; ревью: ReDoS+braces+cap закрыты).
  - ✅ **#4 bash-allowlist** (доверенные команды без подтверждения в ask; `41883f5`; ревью: arg-injection через флаги-эскалаторы закрыт — ESCALATOR-денилист).
  - ✅ **#2 microcompact** (дешёвый обратимый прунинг по размеру до full-compact; `ad2bf4e`; ревью: оценка по slid-копии).
  - ✅ **#5 browser-проверка + MP4 → Proof** (`abe9f89`,`1bda9a8`): `browser_click` (клик по селектору/тексту во вкладке Browser) + `create_proof_video` (кадры browser_screenshot прогона → MP4 в `.verstak/proof/` через ffmpeg) — видео live-проверки веб-сценария для Proof Pack (РФ-угол). Encoder live-проверен реальным ffmpeg (3 PNG→MP4). Полный browser→video цикл — 1 живой клик (Browser-вкладка). Глубокая Proof-Pack хэш-цепочка — follow-up.
  - ✅ **#3 ветвление сессий (fork)** (`6627242`,`d0b60ae`): бэкенд `sessions.fork` (новая main-сессия с копией истории до точки, parentChatId=источник → дерево; +4 теста, sqlite-валиден при закрытом dev) + IPC/preload/тип + store `forkChat` + Sidebar контекст-меню «⑂ Ветвить» + индикатор ⑂. Полная визуализация дерева — follow-up. UI — 1 живой клик.
- 💡 Новые фишки (бэклог): TG-двусторонний-пульт к Gateway (статус/approve/Proof + воронка), Proof Pack как юр-артефакт сдачи, PTC-витрина «стоимость хода».

---

## 🎯 Verstak v3 — машина задачи (СЕВЕР)

Тезис: **результат уровня Opus на дешёвой модели (DeepSeek)** через ХАРНЕС (надёжность в коде, не в доверии модели). Юзер — РФ SMB, BYO-токен, локально, без VPN. Конкурент — OpenCode/Manus и «нанять фрилансера», не ChatGPT. Полный план: `Downloads/verstak-product-plan-v3-2026-06-19.md` + план #5 в Verstak. Вдохновлено разбором OpenCode/ClawCode.

- ✅ **A. Ядро надёжности** (4b8e771) — verify-gate: модель не вправе сказать «готово», провал → авто-починка, лимит → честный стоп `blocked`. pipeline-gate (6 тестов) + миграция 24.
- ✅ **B. Task-spec контракт** (aba770c) — дорогая модель пишет детальные ТЗ-задачи → дешёвая исполняет. TASK_SPEC_CONTRACT в buildPlanPrompt/create_plan + scoreTaskSpec (6 тестов). **Рычаг «Opus на дешёвой».**
- ✅ **C. Профиль проекта** (97d7d55) — machine-readable `.verstak/profile.json`, self-load в context-pack каждой сессии (8 тестов).
- ✅ **D. Промпт-пресеты + beast + max-steps** (fd298da + d653b77) — beast-автономность (auto/bypass) + max-steps hard-stop (последний turn: тулзы off + отчёт). 10 тестов. Минор-остаток: per-family тюнинг, CLI-паритет.
- ✅ **E. Доказательство Opus-на-DeepSeek** — прокликано вживую 19.06 (марафон), харнес A–E работает end-to-end. Тезис подтверждён.
- ⬜ Бонус: LSP-тул + per-role профили (не блокирует).

**Зарелизено в `1.5.18`** (19.06), сейчас в проде `1.5.29`. Харнес A–E **прокликан вживую 19.06 и работает** (`TASK-ilya-v3-livetest.md`). Бонус: per-role (#7) покрыт role-tools; LSP (#6) — отдельной сессией, не блокирует.

---

## 🩹 Открытые хвосты (наши задачи, не закрыты)

| # | Что | Почему висит | Зона |
|---|-----|--------------|------|
| 1 | Облачный дизайн-полиш Pipeline-UI | ТЗ выдано (DESIGN_BRIEF), ждём облачного агента в ветке `design/cloud-polish` | внешн. |
| 2 | **Gateway-баги → отдать Codex** | Пакет file:line+фиксы: `Downloads/IRI-Gateway-баги-ревью-2026-06-23.md`. Начать с 🔴 двойного начисления баланса + овердрафта. Память: [[review-2026-06-23]] | Codex |
| 3 | **Решение по архитектуре скиллов** | ✅ Вариант (2) pre-commit хук СДЕЛАН (23.06: `.githooks/pre-commit` → `scripts/precommit.cjs`, type жёстко + тесты с ABI-awareness, gate-lib под TDD, активируется через `npm install`). Остаются на выбор Павла: (1) аудит 50+ скиллов; (3) тонкий `/verstak`-скилл | Павел |

---

## ✅ Сделано (23.06 ч.2 — reliability-батч, зарелизено в 1.5.29)

Разбор ревью-хвоста B + свежий ре-ревью reliability-поверхности (workflow 4 reviewer'а × адверсариальная верификация, т.к. лог `wf_c485e0e0` потерян). Найдено и пофикшено **5 реальных багов**, все TDD (тест воспроизводит баг → фикс), все в зоне `electron/ai` + `electron/storage`:

- **#1 (user-facing) Стоп во время retry-backoff падал в 'crashed' + страшный error-тост.** `sleep()` в `withInitialRetry` бросает `Error('aborted')`, которая вылетала мимо per-event abort-проверок прямо в внешний catch — без guard'а run писался `failed` и юзер видел ошибку, хотя сам нажал Стоп. Фикс: `if (signal.aborted)` первой строкой catch → чистый `aborted`/`stopped`. (`ai.ts`)
- **#3 supervisor-нота при зацикливании была мёртвым кодом** — пушилась в историю и тут же `return`, модель её не видела. Фикс: bounded nudge — нота скармливается модели (1 шанс сменить подход), при повторном зацикливании hard-stop. (`ai.ts`)
- **F2 (HIGH) `writeSessionJournal` — выпилен в void-стаб** регрессией `4f94c72` («session journal updates» по факту убил журнал). Журнал сессии тихо не писался на всех exit-путях, хотя ai.ts это гарантирует. Восстановлено по `3401bdc`. (`session-journal.ts`)
- **F3 (HIGH) undo floor-protection перетирался между чатами** — `floors` keyed по проекту, второй чекпоинт затирал первый → ранние undo-записи первого чата теряли защиту от prune → частичный откат. Фикс: чистый `FloorTracker` (несколько активных floor'ов, защита по MIN) + `clearProtection(projectPath, floorId?)`. (`undo-floors.ts` нов., `undo.ts`, `ipc/undo.ts`)
- **F1 (medium) `shouldFallback` смотрел только message, не `.code`** — обёрнутая сетевая ошибка (ECONNRESET в `.code`, но не в тексте) не уходила в фолбэк. Зеркалит `isRetriableError`. (`smart-fallback.ts`)
- **#2 cross-verify на max-turns — решено by-design:** max-turns = незавершённая работа, ревью половины кода = шум; cross-verify остаётся только на `completed`.

**Тесты: +13** (smart-fallback 4, undo-floors 7 pure, agent-loop +1 F2, undo.test +1 sqlite-интеграция мульти-чекпоинт). agent-loop +#1/#3 ранее. type ✓. **Полный набор 1420 зелёных** (better-sqlite3 пересобран под Node ABI, sqlite-интеграция F3 подтверждена на реальной БД).

## ✅ Сделано (23.06 ч.3 — догфудинг-ревью Verstak'ом самого себя, зарелизено в 1.5.30)

Ревью внутри Verstak (вкладка Code-review) нашло 3 находки в области ч.2 — **ВСЕ ЗАКРЫТЫ properly** (не band-aid):
- **finding 2+3 (§5 PerChatState bundle):** `checkpointId`/`preflights`/`subagentRuns` внесены в `ChatStateBundle` (типы PreflightCard/SubagentRunCard перенесены в store-agnostic `session-snapshot.ts` + re-export для Chat.tsx) → **сохраняются per-chat** при переключении чата/проекта/выхода из справки, чужие НЕ утекают (каждый чат восстанавливает свой). f2: кнопка отката больше не пропадает при переключении чатов. f3: карточки активности не залипают (preserve вместо reset — лучше для фоновых чатов). switchChatSession/setProject/leaveHelpMode/openHelpChat сведены на captureBundle/restoreBundle (убрана 4-я рукописная копия литерала). Локирующие тесты переписаны под preserve-семантику + roundtrip. **type ✓, store 54 зелёных.**
- **finding 1 (durability):** undo `floors` теперь **персистятся в SQLite** (миграция 28 `undo_floors`) + гидратация при старте `createUndoStack` → переживают краш (раньше in-memory терялись, prune съедал пост-чекпоинт записи). +3 sqlite-теста (durability/restart/дубликат floor). **type ✓, полный набор 1424 зелёных (sqlite на реальной БД).**

## ✅ Сделано (21.06)

- **Тех-долг §5 — распил `projectStore` (1308 → 905 строк, −403/−31%).** Пять behavior-preserving шагов под type+тесты: (1) ядро роутинга стрим-событий `applySnapshotEvent` (3× near-duplicate → 1 модуль, +13 тестов); (2) операции над сообщениями `lib/chat-messages` (дедуп 5+ мест, +10); (3+4) **структурный распил на zustand-слайсы** `pipeline-slice` + `review-slice` (8 review-методов + ReviewState + 4 pipeline-метода вынесены, ProjectState = Main & PipelineSlice & ReviewSlice). Перед структурным распилом — **состязательный архитектурный ревью плана** (4 агента + verify): вердикт GO, все «high» приземлены (цикл импортов → type-only `interface`; задвоение/токены → дисциплина исполнения, не дефект). Чеклист ревью соблюдён: `StateCreator<ProjectState>` над полным типом, `import type` обратное ребро, спред справа, тела Main не тронуты, страж partial-merge (cleanupReviewsFor не обнуляет main). **+24 теста, вся суита 1354 зелёных, type ✓.** Коммиты 9be3905/3ef960f/5f51d4c/17f0e4f. ⚠️ Renderer-изменения — нужен разовый клик-тест сборки (Pipeline-баннер + 🔍 Review) как финальная страховка.

## ✅ Сделано (20.06)

- **Мердж автообновления Ильи + адверсариальный ревью + харднинг (→ войдёт в 1.5.23).** Влил `filatov/main` (модульный рефактор апдейтера `electron/autoupdate/`), решил конфликты (версия/changelog). Перед выкаткой всем прогнал ревью flow установки (9 агентов) — поймал реальный HIGH: новый flow требует системный `node.exe` для распаковки/установки (у dev-юзеров Павел/Илья есть → сработает; у будущих не-dev нет). Остальное проверка приземлила (залипание installing само-восстанавливается; robocopy-откат не регрессия; «.cmd node» ложное). Точечные безопасные фиксы (e7441cf): фильтр node.exe, busy-guard (нет ложного тоста ошибки), идемпотентность install, восстановление из застрявшего installing, понятное сообщение node-missing. +3 теста, 1330 зелёных. **ХВОСТ ИЛЬЕ** (его зона, нужен E2E на чистой машине без Node): настоящий zero-Node автоапдейт — бандл `node.exe` в extraResources ИЛИ PS-rewrite helper'а; + medium-харднинг robocopy-откат/silent-installer fallback.
- **Аудит надёжности релея (12 агентов, живой сервер) + закрытие находок.** После релея прогнал состязательный аудит «будет ли у юзеров чётко». Подтверждено ОК: стриминг/cost-pill/корректность, релей не open-proxy, авторизация не байпасится, серт до сентября + автопродление. **Найдена и закрыта реальная дыра (не Verstak):** на сервере релея CRM-порт AI-BOS `8765` торчал в интернет без firewall — анонимный дамп задач+карточек клиентов с PII. Закрыл `iptables`-правилом (DROP снаружи, loopback/nginx целы), персист на ребут, проверено снаружи (таймаут), `ai-bos.ru` и релей не затронуты. **Код Verstak (фолбэк + override):** verstak-gateway получил `fallbackBaseUrl` (прямой Амстердам) — при сетевом падении релея openai-compat авто-ретраит тем же ключом на прямой хост (только сетевой сбой, не HTTP-ошибки, не отмена); плюс override релея через настройку `verstak_gateway_baseurl` (kill-switch без релиза). +5 тестов (gateway-fallback), type ✓, ai+lib 703 зелёных. **Укрепление релея (сделано):** swap 2ГБ + nginx Restart=on-failure. **Постоянный домен (сделано):** добавил A-запись `api-ru.agi-iri.ru→194.87.187.234` в reg.ru (форма открылась со 2-го клика по типу), расширил серт на него, переключил Verstak baseUrl с IP-хоста sslip.io на `https://api-ru.agi-iri.ru/v1` — смена сервера теперь через DNS без релиза. **Остаток DEBT:** uptime-алёрт релея (нужен канал — UptimeRobot/TG); 9000-вебхук закрыть снаружи+сменить секрет (зона AI-BOS); пулы ключей `IRI_KEYS_*` на шлюзе (для масштаба).
- **🔴→🟢 Надёжность Verstak Gateway РЕШЕНА (корень + фикс, проверено вживую).** Симптом: агентные запросы из Verstak к `api.agi-iri.ru` (Амстердам) рвались «Connection error» на ~1 минуте. Диагноз (через /dev-hq + Workflow): gateway/nginx здоровы, серверный curl и S2S Москва→Амстердам тянут 100КБ за 0.3с — рвёт **РФ last-mile → NL на крупных телах** (16k токенов агентного контекста ≈ 100КБ), нестабильно (undici 408/drop, curl иногда проходит). Фикс — **РФ-релей**: nginx-reverse-proxy на сервере в Москве (`194.87.187.234`) терминирует юзера коротким стабильным хопом и форвардит S2S в Амстердам. Хост — magic-DNS `194-87-187-234.sslip.io` (reg.ru SPA не дал добавить запись под автоматизацией — обошли без reg.ru), LetsEncrypt-серт через HTTP-01. Verstak Gateway baseUrl → релей. **Проверено: 100КБ с ПК через релей 5/5 за <1.5с; живой запрос из приложения Verstak → 200 «Токио» за 2с** (в логе релея `OpenAI/JS` 200). Серверная часть (gateway): async-блокировка event-loop починена (run_in_threadpool+timeout), `#5` cost-pill meta-чанк сделан well-formed, пресеты `verstak/*` разведены на разные апстримы+fallback. **Остаток (DEBT, не блокирует):** sslip.io — бридж; постоянный поддомен `api-ru.agi-iri.ru` добавить когда Павел за компом; релей хардкодом в коде — позже вынести в настройку.
- **Распил `tool-handlers.ts`** (монолит 3156 → 120 строк, 15 модулей в `electron/ipc/tool-handlers/`): чистый рефакторинг, поведение байт-в-байт, `HANDLER_REGISTRY` единый диспетчер, публичный API/реэкспорты сохранены. type ✓ · 1253 теста ✓. Открыл тестируемость хендлеров (§5.3).
- **Verstak Gateway** как провайдер — первым в списке + инструкция подключения, ключи `vsk_live_` (legacy `sk-iri-` принимаются). Бэкенд `api.agi-iri.ru` живой.
- **Chat handoff** — сохранение диалога в Downloads (a22d028).
- **→ Релиз `1.5.22`** (всё выше + бренд Gateway).
- **Покрытие хендлеров (§5.3, после распила)** — +27 тестов на критичные рубежи: ядро DoD `attest_verification` (статус по exitCode, сверка claimed-vs-actual, 8), гейтинг записи `diffConfirmWrite` (block/auto/confirm, 6), гейтинг команд `run_command` + редакция секретов (6), `connector_query` + guard Я.Диск (7). Все side-effect-поверхности гейтятся протестированно.
- **Checkpoint-resume агентного цикла, Фаза 2 (§5.4 резилентность)** — прерванная крахом сессия возобновляется с НАКОПЛЕННЫМ контекстом, а не с turn 0. Миграция 26 (`agent_run_checkpoints`, один снапшот/прогон) + facade save/latest/clear; per-turn снапшот `currentMessages` рядом с tick, очистка на completed; `ai:send` грузит чекпойнт по `resumeFromRunId` и подаёт историю минуя пере-сборку system; `parseResumeCheckpoint` (строгая валидация → мягкий фоллбэк). Цепочка ResumeBanner→Chat→ai:send замкнута. **+20 тестов (storage 7, loop save/clear, parse 6). Backend под ключ; UI-glue resume — на живую проверку. Тестов: 1303.**

## ✅ Сделано (марафон 17–19.06)

- **Багфиксы:** 3 bug-hunt'а + 4-й по провайдерам — 28+ багов закрыто и запушено.
- **Тех-долг §5:** agent-loop тест-харнес · projectStore дедупликация (3 фазы) · CLI parity · покрытие критичных путей.
- **Pipeline Brief→Proof** (флагман, спек D1→D10): storage(миграция 22)+IPC+store+UI, 33 теста → **1.5.16**.
- **Merge Ильи:** дизайн (таймер ответа, markdown) + фикс установщика «9% install error / не скачивалась» → **1.5.17**.
- **Релизы:** 1.5.13 → 1.5.17, все проверены на скачиваемость.
- **Diagnostic Loop v2** (бэклог): авто-tsc после правок .ts/.tsx → ошибки в контекст агента (коммит 60edc11, в main, не зарелизено).
- **RU Workflow Pack** (бэклог): добавлен Ozon+WB снимок — итого 5 RU-сценариев (цель ≥3 перевыполнена; доки 1.5.3 устарели). Коммит 349283e.
- **Сортировка FilesView** (хвост): папки→файлы (sortFileTree). Коммит ce40ab7.
- **Skill Capture** (бэклог): кнопка «⭐ В скилл» в AgentRunsPanel → скаффолд в ~/.verstak/skills/. Коммит 636d276 (UI-клик — 1 живая проверка).

---

## 🚧 Удалённые проекты (SSH/Git) — в работе

Две модели: git-клон (A, как сейчас + push) + SSH-live (B, правки прямо на сервере, для agi-iri.ru). План #4 в Verstak.

- ✅ Фаза 0: парсер источника (0fec892) · ssh-fs примитивы (0abcd08)
- ✅ Фаза 1: storage-модель `project.kind/remote` миграция 23 (f4f67da)
- ✅ A: git-клон + add-remote IPC (546f4d7) — `addRemote(url)` клонирует репо; **A функционально готов** (нужен UI-вход)
- ✅ **B: роутинг tool-слоя на ssh** (4dd3587) — read/write/run/list/search идут на сервер для ssh-проектов; escape-guard + ssh-denylist + confirm. Локальные не затронуты. **Юнит-тесты вкл. security; реальный ssh-exec — нужна живая проверка на безопасном пути перед прод-сайтом.**
- ⬜ B: undo удалённых файлов (локальный undo не правит ssh-файлы) · degraded для ssh: project-map/user-layer читают локальную ФС (полиш)
- ⬜ UI: «Добавить проект» → выбор источника (папка/GitHub/SSH) — Илья + лайв-тест ssh

## 🔀 Гибридный оркестратор API↔CLI — в работе

Концепт: бесшовное переключение API↔CLI в одном чате. Сверка показала — **~75% уже было** (единый лог, `buildCliPrompt`, context-pack, ручное переключение, delegate_task смешивает API+CLI). Дизайн-док: `docs/hybrid-orchestrator.md`.

- ✅ **Фаза 1**: `detectCliWorthiness` в smart-router (детектор терминальных задач) + honest info-подсказка при API-провайдере. 7 тестов. Решение: подсказка, НЕ молчаливый свитч (контроль/прозрачность).
- ⬜ Фаза 2: UI-pill «Терминальная задача → Claude Code?» в один клик (Илья + живая проверка Сценария А end-to-end).
- ✅ **Фаза 3 (транспорт)**: delegate→CLI проверен и зафиксирован тестами — `buildSubCreateOptions` строит опции claude-cli (oauth+cwd), `claude-cli.send` сериализует через `buildCliPrompt`, `runSubAgentLoop` корректно ловит CLI-стиль (текст без tool-call → completed), usage учитывается в cost-guard. 3 регресс-теста `sub-agent-cli-delegate`. Остался только **живой прогон CLI-бинаря** (нужен сконфигурированный Claude Code).
- 🟡 Честность DoD: CLI обходит denylist Verstak (свой sandbox) — задокументировано, не обещаем обратное.

## 📋 Бэклог (стратегический — на отдельные сессии, по приоритету)

Источник: `verstak-donors-product-strategy` + `verstak_v5_review_and_ideas` (в Downloads).

| Приоритет | Задача | Эффект | Размер |
|-----------|--------|--------|--------|
| ✅ | ~~Diagnostic Loop v2~~ — СДЕЛАНО (60edc11) | — | — |
| ✅ | ~~RU Workflow Pack~~ — СДЕЛАНО (5 сценариев, 349283e) | — | — |
| ✅ | ~~Skill Capture~~ — СДЕЛАНО (636d276) | — | — |
| 🔴 нужна живая проверка | **Agent Registry UI** — инфра УЖЕ есть (AgentsPanel/MultiAgentPicker/role-tools); нужна UX-полировка + клик | multi-agent без хаоса | M |
| 🔴 нужна живая проверка | **Pipeline v1.1** — Agency-режим (через WorkflowsPanel + баннер) | hero для агентств | M |
| 🟠 Electron-coupled | **Proof Pack → PDF + Telegram** — printToPDF (нужен Electron) + отправка | B2B / agency sales | M |
| 🟠 большая инфра | **Remote Pulse** — TG-бот: статус run, approve write, доставка Proof Pack | контроль с телефона | L |
| ✅ | ~~DoD Commit Guard + mandatory DoD setting~~ — СДЕЛАНО и покрыто (dev-task `devtask:commit`, `dod_mode` warn/block/off + override + audit; F2-тесты) | надёжность | — |
| — | Heatmap файлов в FilesView · deep-interview (Gajae) | разное (UI → живая проверка) | S–L |

---

## 🚫 Решено НЕ делать (чтобы не возвращаться)

- Локальный RAG (ONNX в Electron), Docker-песочница, Swarm-дашборд — тяжело, не первыми (из 10 идей ревью).
- Полная миграция компонентов projectStore на map-селекторы — churn без багофикса (ценность §5#1 уже взята дедупом).
- «Русский Cursor» как позиционирование — размывает (controlled workspace + proof + RU ops).

---

*Правило ведения: после каждого закрытого блока — двигаю строку из «Открытые хвосты»/«Бэклог» в «Сделано», обновляю дату/версию сверху. Источники истины по фактам — память (`MEMORY.md`).*
