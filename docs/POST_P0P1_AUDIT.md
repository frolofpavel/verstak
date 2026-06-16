# Verstak Post-P0/P1 Competitive Audit

> Повторный аудит ПОСЛЕ реализации старого P0/P1 roadmap. Фичи Multi-agent Manager,
> Verification Artifact, Dev Task Flow, CLI parity, Crash-resume, Review V2 — уже
> сделаны. Вопрос не «сделать», а «насколько хорошо сделано и что это даёт продукту».
>
> Метод: 6 агентов-аудиторов прочитали реальный код каждой фичи (адверсариально), +
> синтез. Все находки привязаны к файлам/строкам — пригодно как backlog для Codex.
> Дата: 2026-06-16. Версия в проде: 1.5.1 (30 коннекторов).

---

## 1. Executive summary

V1 закрыл **вход** (сборка промпта, lifecycle прогонов, безопасность), но **не контроль и
доказуемость на главном сценарии**. Дифференциатор Verstak — «контроль + прозрачность +
мульти-провайдерность» — **выполняется на API-провайдерах и ломается на CLI-провайдерах**,
то есть ровно там, где у конкурентов (Claude Code, Codex CLI) их основной продукт.

**Сквозной системный разлом (а не 6 отдельных багов):** CLI-провайдеры идут через
`runPlainConversation` мимо `HANDLER_REGISTRY` с `supportsTools:false`. Из-за этого на CLI:
- Verification Artifact физически **не создаётся** (tools игнорируются);
- Crash-resume гард деструктива **слеп** → крашнутый Claude Code, записавший десятки
  файлов, получает зелёную кнопку «Возобновить» = **повтор разрушительной работы**;
- live-счётчики / `tick` / Timeline пустые → «ход 0», нулевой прогресс;
- verify-hint почти не выстреливает; attachments молча деградируют в текстовый хинт.

При этом **фундамент зрелый и местами сильнее конкурентов**: сырой git модели не даётся
(денилист + argv-форма), verify перепрогоняется по реальному `exitCode`, а не по словам
модели, undo переиспользуется без дублирования, pure-функции под тестами.

**Главный вывод:** следующий скачок — не новые фичи, а **(1) закрыть CLI-разлом
безопасности, (2) сделать прогресс/результат видимыми, (3) перестать терять ценность при
рестарте, (4) упаковать DoD и РФ-коннекторы в продаваемые сценарии.**

---

## 2. Что уже закрыто относительно Codex / Claude Code / Antigravity

| Отставание (старый roadmap) | Конкурент | Статус | Качество |
|---|---|---|---|
| Командный центр задач | Antigravity, Claude Code /agents | ✅ есть | каркас solid, но как «диспетчерская» недокручен (см. §4.1) |
| Сквозной dev/PR workflow | Claude Code | ⚠️ частично | branch→PR структурно мёртв из UI (см. §4.3) |
| Artifact = доказательство | Antigravity | ✅ сильная сторона | но опционален и не работает на CLI (см. §4.2) |
| CLI parity | Codex CLI | ⚠️ паритет сборки, не поведения | §4.4 |
| Crash-resume | Codex cloud | ✅ безопасный V1 | слеп на CLI (см. §4.4-resume) |
| Review плоский текст | code-review tools | ✅ структурирован | findings эфемерны, file:line галлюцинируются (§4.5) |

**По безопасности Verstak местами сильнее конкурентов:** git-денилист + argv без shell,
verify по реальному exitCode, secret-scanner на всех путях, path-policy с anti-symlink.

---

## 3. Какие конкурентные отставания остались

1. **Контроль на CLI-сценарии** — главный. У конкурентов их продукт = CLI; у нас на CLI
   не работают tools/verify/checkpoint/undo/mode-policy. «Контролируемая оболочка» пока
   контролирует только API-путь.
2. **Живой нарратив прогресса** — Claude Code /agents, Cursor/Antigravity background
   показывают стрим «что агент делает и думает». У нас — постфактумный реестр механических
   действий, нулевой прогресс у running-задачи.
3. **Review как цикл, а не список** — Cursor/Antigravity замыкают finding→patch→перепроверка.
   У нас петля разомкнута, findings эфемерны, file:line без кода под собой.
4. **Изоляция параллельных задач** (worktree) — есть у Antigravity/Cursor background, у нас нет.
5. **Доказательство = скриншоты/записи** — Antigravity показывает recordings действий; у нас
   только перепрогон проверок (но это честнее по сути).

---

## 4. UX-аудит реализованных V1-фич

### 4.1 Multi-agent Manager — `partial`
**Вердикт:** solid lifecycle-каркас, но как поверхность видимости недокручен — «рабочий V1
учёта прогонов, а не диспетчерская мультиагента, какой её продаёт название».

Сильное: идемпотентный `finish` (`WHERE ended_at IS NULL`, agent-runs.ts:267), реальный stop
с каскадом в суб-сессии (ipc/agent-runs.ts:79), безопасный crash-гард.

Слабое (по коду):
- **`incr()` не вызывается НИГДЕ** (grep по electron = 0) → счётчики 🤖0 🔧0 📄0 у активной
  задачи, значения пишутся разом только в `finish()`.
- **Мёртвые типы Timeline:** UI рисует иконки для `user_msg/assistant_msg/todo/status/error`
  (AgentRunsPanel.tsx:53-66), но **ни одно не пишется**. В ленте только механика, нет запроса
  и результата.
- Живой прогресс (`turnIndex/lastToolName`) пишется `tick()`, но в панели **не показывается**
  (читает только crash-баннер) → «где он сейчас?» без ответа.
- **3 перекрывающихся инспектора** в сайдбаре: «Инспектор»/«Задачи»/«Агенты» — пользователь
  не поймёт куда смотреть.
- `waiting_review` — вычисляемый костыль, вторая ветка из roadmap осталась TODO (ipc:54-60).

UX-дыры: «где результат?» (нет финального ответа в карточке), кнопка ↻ «Переотправить» = рестарт
с нуля (теряет частичную работу, обещает продолжение).

### 4.2 Verification Artifact — `partial` (сильная сторона ядра)
**Вердикт:** доктрина «не верь модели — перепрогони по exitCode» реализована честно и это
сильнее Cursor/Claude Code. Но недокручена до продукта.

Сильное: статус ставит хендлер по `r.exitCode` (модельный `status` игнорируется), денилист
перед перепрогоном, сверка claimed vs actual файлов (`runFilesTouched`), самодостаточный
`.json`+`.html` с XSS-экранированием.

Слабое (по коду):
- **НЕТ ПРИНУЖДЕНИЯ.** `attest_verification` вызывается только если модель сама решит.
  `compose-system.ts`/`system-layer.ts` его не упоминают, agent-loop на завершении не
  проверяет аттестацию. Для «обязательного DoD на dev-task» — **ни одного хука**.
- **CLI физически не может создать артефакт** (tools игнорируются) — а конкуренты именно CLI.
- `verifications.list` — **мёртвый API** (пишется в SQLite, ни один UI не читает).
- **Парити-баг:** ReviewButton кладёт `verifications.latest` в payload, а
  ComposerToolsMenu.tsx:150 зовёт `composeReviewPayload(messages)` **без verification** — DoD
  молча теряется.
- `writeVerificationArtifact` slug без суффикса уникальности → повторная аттестация **молча
  затирает** прежний `.json`/`.html` (а он объявлен источником истины).
- `not_run` и `partial` одного цвета бейджа → «не проверено» неотличимо от «частично».

### 4.3 Dev Task Flow — `no` (демо-каркас, не продукт; зрелость 5/10)
Сильное: git-write безопасен образцово (единый `runGit`→`assertGitAllowed`, денилист
push/force/reset/clean/--no-verify, argv без shell, scanText на выводе); откат переиспользует
undo-стек; commit-planner — чистая тестируемая функция.

Слабое (по коду) — **флагманский путь branch→PR структурно мёртв**:
- `openFromPreflight` хардкодит `workBranch:null`; кнопка «Создать ветку» создаёт git-ветку,
  но **никогда не пишет `work_branch` назад** в dev_task (нет IPC) → `devTask.workBranch`
  навсегда null → кнопка «Создать PR» (гейт на workBranch, стр.331) **никогда не появляется**.
- `commit` берёт `readDiffStat` **без base** (worktree diff), а `buildPackage` берёт
  `base..HEAD` → **разный diff**: в branch-режиме commit коммитит пустоту.
- **fail-проверки не блокируют** commit/упаковку — прямо противоречит «высокому контролю».
- Мёртвые состояния `paused/branching/review_ready` (в CHECK есть, не присваиваются), нет
  валидации переходов (можно commit из draft).
- Нет worktree → параллельные задачи делят дерево, DevTaskBadge считает git diff глобально.

### 4.4 CLI parity — `partial` (паритет сборки, не поведения)
Сильное: `history-serializer` вынесен и покрыт тестами, char-budget walk вместо `slice(-10)`,
`formatToolResult` учитывает `r.error`, единый `buildCliPrompt` для всех 4 CLI + API.

Слабое: **provider.send(messages, []) всегда пустые tools** → CLI идёт одношагово, tools
выполняет чужой агент в субпроцессе; `appendVerifyHint` практически мёртв (детект по
`toolCalls` истории, которых у CLI нет); attachments → текстовый хинт (деградация, не паритет);
несимметрия argv (grok капает payload, остальные шлют в stdin без капа); хрупкий dedup-ключ в
claude-cli (`JSON.stringify.slice(0,32)`).

### 4.4-resume Crash-resume — `partial` (безопасный re-send, но слеп на CLI)
Сильное: pure `isAutoResumable` под тестами, `reconciledAt` до `reconcileStale` (не эвристика
времени), идемпотентность finish/tick.

Слабое — **КРИТИЧНО по безопасности:**
- **`tick()` вызывается только в `runApiConversation` (ai.ts:1258), на CLI-пути — нет.** Для
  крашнутого CLI-прогона `turn_index=0`, `last_tool_name=NULL` → `isAutoResumable`=TRUE →
  крашнутый Claude Code, записавший десятки файлов, получает **авто re-send = повтор
  деструктива**. Гард для главного сценария полностью обойдён.
- `ResumeBanner.resume()` **не переключает чат на `run.chatId`** (в отличие от
  AgentRunsPanel) → re-send уходит в чужой активный чат.
- Гард смотрит на `last_tool_name` (хвост turn'а): `write→run→read` в одном turn → last=read →
  ложный autoResumable=true.

### 4.5 Review V2 — `partial` («текстовое ревью с красивым оверлеем»)
Сильное: `parseReviewFindings` надёжен (best-effort, не бросает, fallback json→legacy→пустой,
плотные тесты); `composeFixPrompt` дисциплинирует модель; guard против двойного placeholder.

Слабое — **КРИТИЧНО:**
- **findings эфемерны:** `review.content` не пишется в chats («живёт только в памяти до
  перезапуска») → после рестарта pill раскрывается **пустым** («фантомный» ревью).
- **file:line без кода под собой:** `composeReviewPayload` отдаёт ревьюеру только прозу
  ассистента (truncate 8000), НЕ diff и НЕ содержимое файлов → номера строк **галлюцинируются**;
  `revealFinding` открывает файл в проводнике, не на строке.
- Петля finding→patch→verification **не замкнута**: fix уходит обычным user-message, нет
  resolved-флагов, нет авто-перепроверки.
- Двойная шкала severity (high/medium/low в тексте + P0–P3 в json) → риск рассинхрона.

---

## 5. Архитектурный аудит

- **Дублирование/перекрытие:** 3 инспектора (AgentRunInspector / AgentRunsPanel / AgentsPanel)
  на классе `gg-run-card` перекрываются по смыслу. Свести к одному первичному экрану.
- **`projectStore.ts`** (~800+ строк) продолжает расти; поллинг-логика панелей независимая
  (2–3с в каждой). План рефактора (ChatSessionLifecycle / PerChatState) из CLAUDE.md §5 не
  начат — не блокер, но техдолг растёт.
- **Storage / IPC / renderer разведены правильно:** новые таблицы только append-миграцией
  (16–20), фасады storage чистые/параметризованные, IPC handler→preload→api.d.ts соблюдён.
  Замечание: есть мёртвые IPC (`verifications.list`) — либо оживить, либо убрать.
- **git-write безопасен** (денилист + argv без shell + top-frame guard + scanText) — образцово.
- **resume guard корректен по логике, но слеп на CLI** (см. §4.4-resume) — это дыра
  безопасности, не стиля.
- **Project rules не нарушены:** system-layer не тронут, миграции append-only, секреты через
  safeStorage, path-policy/secret-scanner на местах. Замечание: CLAUDE.md §1 говорит
  «8 коннекторов» — устарело (теперь 30), обновить.

---

## 6. Новый roadmap (после реализации старого P0/P1)

### P0 — безопасность и видимость (всё S, один корень `runPlainConversation`+панель)
1. **`agentRuns.tick` в `runPlainConversation`** + форс `autoResumable=false` для всех
   CLI-крашей. Закрывает риск повтора деструктива. (HARDENING)
2. **`ResumeBanner.resume()` → переключение на `run.chatId`** перед re-send. (HARDENING)
3. **Live-счётчики:** `incr()` из tool-handlers + `turnIndex/turnsBudget` («ход 4/8») +
   `lastToolName` в AgentRunsPanel. (POLISH)
4. **`user_msg` + финальный итог в Timeline** — запрос и результат в ленте. (POLISH)

### P1 — вернуть ценность и оживить флагман
5. **Персист `review.content`+findings** в БД (POLISH M) — иначе pill пустой после рестарта.
6. **Diff/код ревьюеру** в `composeReviewPayload` (POLISH M) — иначе file:line выдумка.
7. **Write-back `work_branch`** после branchCreate + **синхронизация diff commit/пакета**
   (POLISH S+M) — оживить мёртвый branch→PR.
8. **DoD-принуждение:** в agent-loop на `completed` проверять аттестацию; если файлы менялись —
   авто-инжект финального тёрна (1 retry) либо `overall=not_run` с подсветкой. (HARDENING M)
9. **Блокировать/предупреждать commit при fail-проверках** (HARDENING S).
10. Парити Review (`verifications.latest` в ComposerToolsMenu), уникализация slug артефакта,
    переименование «Возобновить»→«Запустить заново», бейдж возможностей провайдера. (S каждый)

### P2 — новое / большое
11. **Замкнуть петлю Review** (finding→patch→авто-verify→«закрыто N из M»). (L)
12. **Реальный CLI tool-parity:** перепрогон verify-команд силами хендлера после CLI-прогона —
    системно закрывает корневой разлом. (L)
13. **Worktree sandbox** для изоляции параллельных задач. (L)
14. **РФ workflow-шаблоны** поверх 30 коннекторов (см. §9). (M)
15. Навигация к строке, push-обновления вместо поллинга, история DoD-панель. (M)

### P3 — после фундамента
16. **checkpoint-resume V2** — только после CLI-дыры + идемпотентности tool-replay (см. §8).

---

## 7. Что делать с Telegram failing test — ✅ УЖЕ СДЕЛАНО

Codex видел падение `tests/connectors/telegram.test.ts > пустой whitelist — timeout 5000ms`.
**Корень был не сеть, а протечка `vi.stubGlobal('fetch')` между тест-файлами:** connector-тесты
стабили глобальный fetch и не снимали после последнего `it()` файла; telegram-тест (делавший
реальный fetch) в общем прогоне наследовал чужой стаб/таймаут.

**Фикс (в проде, коммит при merge 1.5.1):** глобальный `afterEach(() => vi.unstubAllGlobals())`
в `tests/setup.ts` + перенос module-level `vi.stubGlobal('window')` в `project-store-routing`
в `beforeEach` (иначе глобальная очистка его сносила). **Полный прогон сейчас 868/868 зелёный.**
Рекомендация Codex «замокать fetch, сделать детерминированным» по сути выполнена системно (один
источник правды вместо правки 30 connector-тестов).

---

## 8. checkpoint-resume V2 или оставить безопасный re-send?

**Оставить honest re-send сейчас. checkpoint-resume V2 — отложить (P3), и только после двух
предусловий.** Honest re-send — разумный безопасный MVP, лучше конкурентов (Codex/Cursor молча
теряют сессию после краха). Настоящее возобновление agent loop требует решить **идемпотентность
tool-replay**: `apply_patch` не наложится на уже изменённый файл, повторный `run_command` может
навредить. Браться за V2 **только после**: (1) закрыта CLI-дыра гарда (P0 #1) — иначе V2 строится
над слепым местом; (2) есть детерминированный replay с ручным подтверждением каждого мутирующего
шага. Иначе риск повтора деструктива выше, чем у текущего re-send.

---

## 9. Что реально монетизирует Verstak

Прямую монетизацию даёт не агентная инфраструктура (её закрывают и бесплатные CLI), а
**уникальная связка контроля + РФ-интеграций**:

1. **DoD-артефакт как продаваемая ценность.** «Не верю модели — перепрогнал по exitCode» +
   экспорт `.html` «доказательство выполнения» для отчёта заказчику/клиенту. Оживить мёртвый
   `verifications.list` в панель истории. Уникально для аутсорса/агентств.
2. **РФ workflow-шаблоны поверх 30 коннекторов** (фундамент уже построен сегодня): «отчёт из
   1С → DOCX клиенту», «Я.Директ → SVG-чарт → Я.Диск-шеринг», «лиды Битрикс24 → сводка»,
   «сверка 1С↔Google Sheets», «правка сайта клиента + verify + git». Превращает коннекторы из
   tech-демо в продаваемые сценарии. **← единственный прямо монетизируемый трек.**
3. **Бейдж возможностей провайдера** (CLI = без undo/checkpoint/mode) — честность = доверие =
   причина платить за оболочку, а не за голый CLI.

> Открытая развилка (из ШТУРМ): «продукт на продажу vs внутренний станок агентства». До её
> решения §9.2 строить как внутренний инструмент, упаковку на продажу — отдельным решением.

---

## 10. Задачи для Codex (реализационный backlog)

Порядок = рекомендация синтеза «CLI-спайк безопасности и видимости» первым (всё S, один корень),
затем восстановление ценности, затем большие камни. Каждая самодостаточна, `type+test` между.

| # | Задача | Файлы | Размер | Трек |
|---|---|---|---|---|
| 1 | `agentRuns.tick` в `runPlainConversation` + форс `autoResumable=false` для CLI | electron/ipc/ai.ts, storage/agent-runs.ts | S | HARDENING P0 |
| 2 | `ResumeBanner.resume()` → `switchChatSession(run.chatId)` перед re-send | src/components/ResumeBanner.tsx | S | HARDENING P0 |
| 3 | Вызывать `incr()` из tool-handlers; показать `turn N/M` + `lastToolName` в панели | ipc/tool-handlers.ts, src/components/AgentRunsPanel.tsx | S | POLISH P0 |
| 4 | Писать `user_msg` (create) + финальный итог (finish) в Timeline | electron/ipc/ai.ts, storage/agent-runs.ts | S | POLISH P0 |
| 5 | Персист `review.content`+findings при finalizeReview | storage/chat-sessions.ts, src/store/projectStore.ts | M | POLISH P0 |
| 6 | Diff/содержимое файлов ревьюеру в `composeReviewPayload` | src/lib/compose-review-payload.ts | M | POLISH P0 |
| 7 | Write-back `work_branch` (новый `devtask:setBranch`) + синхронизация diff commit/пакета | ipc/dev-task.ts, src/components/DevTaskPanel.tsx | S+M | POLISH P0 |
| 8 | DoD-принуждение в agent-loop на `completed` (авто-инжект attest или `not_run`+подсветка) | electron/ipc/ai.ts, ai/compose-system.ts | M | HARDENING P1 |
| 9 | Блок/предупреждение commit при fail-проверках | src/components/DevTaskPanel.tsx, ipc/dev-task.ts | S | HARDENING P1 |
| 10 | Парити Review (verifications.latest в ComposerToolsMenu) + уникализация slug артефакта | src/components/ComposerToolsMenu.tsx, ai/verification.ts | S | POLISH P1 |
| 11 | Гард деструктива по любому мутирующему tool в turn (не только last_tool_name) | storage/agent-runs.ts, ipc/ai.ts | M | HARDENING P1 |
| 12 | Бейдж возможностей провайдера (CLI без undo/checkpoint/mode) + предупреждение attachments→CLI | src/components/Chat.tsx, hooks/useProvider | M | MONETIZABLE P1 |
| 13 | Замкнуть петлю Review (finding→patch→авто-verify→resolved) | src/lib/review-findings.ts, ReviewPills.tsx | L | P2 |
| 14 | Реальный CLI tool-parity (перепрогон verify хендлером после CLI) | electron/ipc/ai.ts | L | P2 |
| 15 | Worktree sandbox для изоляции параллельных задач | ipc/dev-task.ts, ipc/git.ts | L | P2 |
| 16 | РФ workflow-шаблоны поверх 30 коннекторов | electron/ai/skills/, connectors/ | M | MONETIZABLE P2 |
| 17 | checkpoint-resume V2 (только после #1 + идемпотентный replay) | storage/agent-runs.ts, ipc/ai.ts | L | P3 |

**Брать первым: #1→#2→#3→#4** (CLI-спайк, всё S, один путь). Снимает единственный риск порчи
данных + сразу даёт видимый прогресс. Затем #5–#7 (вернуть ценность + оживить Dev Task). Большие
L-камни (#13–#17) — строго после закрытия CLI-дыры безопасности.

---

*Аудит проведён 6 параллельными агентами по реальному коду (~730K токенов, 129 чтений) +
синтез. Находки привязаны к файлам/строкам для прямой передачи в Codex.*
