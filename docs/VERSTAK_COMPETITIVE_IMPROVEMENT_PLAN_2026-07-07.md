# Verstak competitive improvement plan

Дата: 2026-07-07

Основа:
- `docs/COMPETITOR_AUDIT_HERMES_OPENCLAW_2026-07-06.md`
- `STATUS.md`
- сравнение с `NousResearch/hermes-agent` и `openclaw/openclaw`

Цель: не копировать Hermes/OpenClaw целиком, а превратить их сильные стороны в маленькие проверяемые задачи, которые реально усиливают Verstak как desktop coding agent и operator runtime.

## Принципы

1. Каждая задача должна быть маленькой, обратимой и проверяемой.
2. Сначала фиксируем слабую поверхность тестом или smoke, потом правим код.
3. Не добавляем новых провайдеров и каналов ради ширины списка.
4. Любая "свобода агента" идет вместе с guardrail: лог, подтверждение, redaction, rollback или тест.
5. GUI, headless и CLI не должны расходиться по правилам доступа, recipe enforcement и safety.
6. Релизный критерий: targeted tests -> `npm run type` -> `npm run test:fast` -> `npm run build` -> installer smoke, если есть версия.

## Главный вывод

Verstak уже сильнее конкурентов как Windows desktop coding product: установка, GUI, провайдеры, модельная политика, recipes, review gate, proof/release loop.

Слабее мы не в моделях, а в операторском рантайме:
- длинные и фоновые процессы;
- lifecycle прогонов;
- managed worktrees;
- security regression culture;
- skill governance;
- единый контракт GUI/headless/CLI.

Поэтому план ниже идет не "больше фич", а "больше надежности агента".

## Release Map

| Версия | Фокус | Не тащить внутрь |
|---|---|---|
| 1.8.8 | Security regression pack + agent freedom hardening + Settings polish | новые провайдеры, новый UI-экран, большой sandbox |
| 1.8.9 | Background process manager v1 + managed worktree lifecycle foundation | полноценный daemon/gateway |
| 1.9.0 | Run lifecycle/wait contract + skill governance | marketplace/ClawHub clone |
| 1.9.x | Proof delivery, eval traces, remote operator controls | full OpenClaw channel matrix |

## Phase 0. Плановая гигиена

| ID | Задача | Зачем | Где | Готово, когда | Проверка |
|---|---|---|---|---|---|
| P0-01 | Зафиксировать competitor audit и этот план в docs | Чтобы не держать roadmap в чате | `docs/` | оба документа есть и видны в `git status` | readback файла |
| P0-02 | Обновить `STATUS.md` коротким блоком "следующий фокус" | Чтобы команда видела, почему делаем security/process/worktree | `STATUS.md` | top-блок отражает текущий план | readback top 30 строк |
| P0-03 | Сверить текущие тестовые команды | Не строить план на устаревших scripts | `package.json` | есть список команд для type/test/build/security | `npm run`/package read |
| P0-04 | Собрать known-risk список по agent freedom | Чтобы не потерять риски внешних путей/секретов | `docs/` или `STATUS.md` | 5-10 рисков с владельцем | doc readback |

## Phase 1. 1.8.8: Agent Freedom Without Chaos

### 1.1 Path и external roots

| ID | Задача | Зачем | Где | Готово, когда | Проверка |
|---|---|---|---|---|---|
| 188-PATH-01 | Добавить regression test: absolute read outside project allowed as read-only | Закрывает боль "прочитай явный путь" | `tests/ai/` | агент читает явный путь, но не пишет туда без разрешения | targeted vitest |
| 188-PATH-02 | Добавить regression test: write to allowed external root allowed | Проверяет новую механику настроек | `tests/ai/` | `write_file`/`apply_patch` проходят только в allow-root | targeted vitest |
| 188-PATH-03 | Добавить regression test: write outside project/downloads/allow-root blocked | Не дать свободе стать дырой | `tests/ai/` | попытка записи блокируется понятной причиной | targeted vitest |
| 188-PATH-04 | Добавить symlink escape test для external root | Самый опасный обход | `tests/ai/` | symlink наружу блокируется | targeted vitest |
| 188-PATH-05 | Проверить secret path guard во всех путях чтения/записи | `.env`, keys, ssh не должны утечь | `electron/ai/path-policy.ts`, tests | все secret-пути блокируются | targeted vitest |

### 1.2 Command approval binding

| ID | Задача | Зачем | Где | Готово, когда | Проверка |
|---|---|---|---|---|---|
| 188-CMD-01 | Test: displayed command equals executed command | Защита от подмены между confirm и exec | `tests/ai/`/`tests/ipc/` | нельзя показать одно, выполнить другое | targeted test |
| 188-CMD-02 | Test: shell chaining не обходит allowlist | `cmd1 && badcmd` должен ловиться | command policy tests | bad chain blocked | targeted test |
| 188-CMD-03 | Test: env injection не уходит в логи | Секреты не печатаются через команду/trace | secret scanner tests | trace содержит redacted | targeted test |
| 188-CMD-04 | Свести текст ошибки dangerous command к понятному русскому сообщению | Пользователь должен понимать, что заблокировано | UI/tool result | ошибка объясняет путь решения | snapshot/smoke |

### 1.3 Web/browser safety

| ID | Задача | Зачем | Где | Готово, когда | Проверка |
|---|---|---|---|---|---|
| 188-WEB-01 | Test: private IP fetch blocked, если это не явно разрешенный локальный сценарий | SSRF guard | web/browser policy | `127.0.0.1`, `169.254.*`, private ranges handled | targeted test |
| 188-WEB-02 | Test: redirect to private IP blocked | Частый обход | web/browser policy | public -> private redirect не проходит | targeted test |
| 188-WEB-03 | Test: metadata endpoint blocked | Cloud credential safety | web/browser policy | metadata endpoint blocked | targeted test |
| 188-WEB-04 | Логировать только безопасный URL summary | Не светить query secrets | secret scanner/web logs | query/token redacted | targeted test |

### 1.4 Skill import/install guard

| ID | Задача | Зачем | Где | Готово, когда | Проверка |
|---|---|---|---|---|---|
| 188-SKILL-01 | Test: skill install не пишет вне skill roots | Защита от path traversal | skills loader/install tests | traversal blocked | targeted test |
| 188-SKILL-02 | Test: imported skill не может требовать опасные tools silently | Контроль capabilities | skills policy | dangerous tools require visible approval/policy | targeted test |
| 188-SKILL-03 | Skill provenance поле: built-in/user/imported/generated | Фундамент governance без большого UI | storage/skills | provenance сохраняется | unit/storage test |
| 188-SKILL-04 | Показать provenance в Settings/Skills или inspector минимумом | Чтобы не гадать, откуда skill | Settings | label виден | UI smoke/build |

### 1.5 Settings polish

| ID | Задача | Зачем | Где | Готово, когда | Проверка |
|---|---|---|---|---|---|
| 188-SET-01 | Проверить блок "Что разрешено" глазами пользователя | Настройки должны объяснять свободу агента | `src/components/Settings*` | external roots легко найти | screenshot/manual smoke |
| 188-SET-02 | Добавить короткий русский текст про read-only explicit paths | Убрать путаницу "почему читает, но не пишет" | Settings/Policy | формулировка видна | build/string search |
| 188-SET-03 | В ModelPicker/Settings оставить model policy заметной | Модель "барахлит" -> нужен видимый fallback | model picker/settings | default/fallback/reviewer видны | UI smoke |
| 188-SET-04 | Проверить "Найти CLI" в Settings | Пользователи ищут кнопку | providers settings | кнопка видна и работает | UI smoke |

### 1.6 Security command

| ID | Задача | Зачем | Где | Готово, когда | Проверка |
|---|---|---|---|---|---|
| 188-SEC-01 | Добавить `npm run test:security` или документированную targeted-команду | Один вход для safety pack | `package.json` | команда запускает path/cmd/web/skill tests | command pass |
| 188-SEC-02 | Добавить `docs/SECURITY_REGRESSION_PACK.md` | Чтобы правила не были рассыпаны | `docs/` | перечислены классы атак и tests | readback |
| 188-SEC-03 | Включить security pack в release checklist | Чтобы не забывать перед installer | `STATUS.md`/release docs | checklist обновлен | readback |

## Phase 2. 1.8.9: Background Process Manager v1

| ID | Задача | Зачем | Где | Готово, когда | Проверка |
|---|---|---|---|---|---|
| 189-PROC-01 | Аудит текущего `run_command` и terminal IPC | Не плодить второй рантайм | `electron/ai/tools.ts`, `electron/ipc/terminal.ts` | карта текущих путей | doc note |
| 189-PROC-02 | Описать process model: id/status/command/cwd/start/end/exit/log tail | Единый контракт | `docs/` или type file | тип согласован | typecheck |
| 189-PROC-03 | Main-process registry для background commands | Чтобы команда жила после yield | `electron/ai/`/`electron/ipc/` | process id возвращается | unit test |
| 189-PROC-04 | Tool `process_status` | Агент может проверить результат | tool defs/handlers | status возвращает exit/running/tail | targeted test |
| 189-PROC-05 | Tool `read_process` | Читать хвост без спама контекста | tool defs/handlers | tail bounded + redacted | targeted test |
| 189-PROC-06 | Tool `stop_process` | Безопасное завершение | tool defs/handlers | process tree остановлен | targeted test |
| 189-PROC-07 | TTL cleanup для завершенных процессов | Не копить мусор | process registry | старые записи чистятся | unit test |
| 189-PROC-08 | Timeline event on process exit | Пользователь видит исход | ai events/UI | exit отображается | UI smoke |
| 189-PROC-09 | No orphan test | Главный risk | tests | после stop/timeout нет живого дочернего процесса | integration test |
| 189-PROC-10 | Redaction test для stdout/stderr | Секреты не текут в trace | tests | keys заменены | targeted test |

## Phase 3. 1.8.9: Managed Worktree Lifecycle

| ID | Задача | Зачем | Где | Готово, когда | Проверка |
|---|---|---|---|---|---|
| 189-WT-01 | Аудит текущей изоляции сессий/worktree | Понять, что уже есть | `electron/`, `src/` | doc-карта путей | readback |
| 189-WT-02 | Registry model: worktree id/path/base branch/chat/status | Основа lifecycle | storage/types | тип/миграция готовы | type/storage test |
| 189-WT-03 | Dirty/unpushed detector | Не терять работу | git helper | status reliable | integration test on temp git |
| 189-WT-04 | Snapshot before delete | Удаление должно быть обратимым | git helper/storage | patch bundle/ref сохраняется | integration test |
| 189-WT-05 | Restore snapshot | Реальное восстановление | git helper | удаленный worktree восстановлен | integration test |
| 189-WT-06 | GC policy | Не удалять dirty/unpushed | worktree service | unsafe delete blocked | targeted test |
| 189-WT-07 | Settings/Project list worktrees | Пользователь видит ресурсы | UI | список, статус, действия | UI smoke |
| 189-WT-08 | Apply-to-main remains local, no push | Safety | merge helper | push не вызывается | test/mock |
| 189-WT-09 | STATUS checklist для worktree release | Не выпускать без smoke | docs | checklist добавлен | readback |

**Status 2026-07-07:** `189-WT-01..06` + `189-WT-08` foundation closed in current implementation pass:
worktree audit/readback done, lifecycle registry metadata added via migration `38`,
storage model exposes `touch`/`setRefs`/`markRemoved`, and `detectWorktreeState`
covers clean/dirty/unpushed/all-three/non-git on real temp git repos.
Snapshot-before-remove, restore-from-snapshot, lossless remove, and no-push regression are implemented.
Remaining managed-worktree scope starts at snapshot retention prune, registry UI/actions, and release checklist (`189-WT-07`, `189-WT-09`).

**Status 2026-07-07 WT update:** `189-WT-07`/`189-WT-09` closed as a compact v1.
Added worktree registry/actions IPC (`list`, `snapshot`, `restore`, `delete`), preload/types, storage `getLatest`/`listProject`,
and a visible `Снимок` action in the existing WorktreeBar. Release checklist is now recorded in `STATUS.md`.
Large standalone WorktreePanel remains optional polish, not a blocker for the v1 lifecycle.

**Status 2026-07-07 PROC:** process manager foundation closed for `189-PROC-01..07`, plus owner-bound completion routing into the next agent turn and real OS anti-orphan smoke.
Added `ProcessRegistry`, background tools `spawn_process`/`process_status`/`read_process`/`stop_process`,
bounded redacted output tail, TTL prune/sweeper API, PID-reuse guard, command gating before spawn,
and a redacted owner-filtered `drainCompletions()` queue for `notifyOnExit` processes. `runApiConversation`
injects only current-`sendId` completions into the next turn; cross-chat leakage is covered by agent-loop tests.
`tests/ai/process-anti-orphan.test.ts` caught and locked a Windows race where async `taskkill` + immediate `child.kill()` could orphan the real Node child; `treeKill` now runs `taskkill /T /F` synchronously.
Process exits are now dedicated `process` run timeline events and render in Runs panel with a gear icon.
Remaining process scope: none for process-manager v1; `189-PROC-10` covered by targeted tests.

## Phase 4. 1.9.0: Run Lifecycle / Wait Contract

| ID | Задача | Зачем | Где | Готово, когда | Проверка |
|---|---|---|---|---|---|
| 190-RUN-01 | Описать state machine: accepted/queued/running/tool/review/ended/error/cancelled/timeout | Единый язык GUI/headless | docs/types | схема согласована | typecheck |
| 190-RUN-02 | Проверить текущие `runId`/events | Не ломать существующий timeline | `electron/ipc/ai.ts`, storage | карта событий | doc note |
| 190-RUN-03 | Persist run lifecycle events | Stuck diagnostics и resume | storage migration | events сохраняются | storage test |
| 190-RUN-04 | `ai:wait` или CLI wait для headless | CI/eval без GUI | IPC/CLI | wait returns final status | integration test |
| 190-RUN-05 | Per-chat lane queue | Не смешивать прогон с прогоном | send registry/store | concurrent sends deterministic | test |
| 190-RUN-06 | Stuck-session diagnostics | Пользователь понимает "зависло или работает" | Runs panel | видно last event + age | UI smoke |
| 190-RUN-07 | Cancel semantics | Отмена должна иметь final event | agent loop | cancel -> cancelled | test |
| 190-RUN-08 | Timeout semantics | Fail-closed, не silent hang | agent loop | timeout -> non-zero/headless fail | test |
| 190-RUN-09 | Headless trace aligns with GUI events | CLI parity | scripts/runner | same lifecycle fields | trace test |

**Status 2026-07-07 RUN update:** `190-RUN-01` and the compact `190-RUN-04` wait primitive are closed.
Added `electron/ai/run-lifecycle.ts`, `docs/RUN_LIFECYCLE.md`, IPC `ai:wait`, preload/types `window.api.ai.wait`, and explicit CLI `--wait` compatibility.
Targeted verification: `npx vitest run tests/ai/run-lifecycle.test.ts tests/storage/agent-runs.test.ts tests/ipc/agent-runs-wait.test.ts` -> green, 3 files / 37 tests; `npm run type` -> green.

**Status 2026-07-07 RUN diagnostics update:** `190-RUN-06` compact v1 is closed.
`agent_runs` DTO exposes `lastEventAt`, Runs panel shows last activity age for active runs, and warns when a running/queued run has no events for 5+ minutes.
Targeted verification: `npx vitest run tests/storage/agent-runs.test.ts tests/ai/run-lifecycle.test.ts tests/ipc/agent-runs-wait.test.ts` -> green, 3 files / 37 tests; `npm run type` -> green.

**Status 2026-07-08 RUN hardening update:** `190-RUN-05`, compact `190-RUN-07`, and `190-RUN-09` are closed; `190-RUN-08` stays open for a configurable timeout policy engine.
Added per-chat/help lane generations in the renderer store, stale chat owners are ignored before event routing, same-lane concurrent sends queue deterministically, `agent_runs.finish()` writes one terminal status event, and headless recipe traces now expose lifecycle events, counters, status, duration, and error classification without secrets.
Targeted verification: `npx vitest run tests/store/project-store-routing.test.ts tests/storage/agent-runs.test.ts tests/scripts/verstak-cli-recipe.test.ts tests/ai/run-lifecycle.test.ts` -> green, 4 files / 66 tests; `npm run type` -> green.

## Phase 5. 1.9.0: Skill Governance

| ID | Задача | Зачем | Где | Готово, когда | Проверка |
|---|---|---|---|---|---|
| 190-SG-01 | Аудит skill loader/import/built-ins | Не делать вторую систему skills | `electron/ai/skills/` | doc-карта | readback |
| 190-SG-02 | `skill_usage` storage | Понимать, чем реально пользуются | storage migration | usage increments | storage test |
| 190-SG-03 | Protected built-ins | Нельзя случайно удалить базовые skills | skills service | delete blocked/archive only | targeted test |
| 190-SG-04 | Archive/restore вместо delete | Безопасная библиотека | skills service/UI | skill можно вернуть | test/UI smoke |
| 190-SG-05 | Generated skill candidates | Агент предлагает улучшения, но не пишет silently | skill governance | candidates visible, apply gated | targeted test |
| 190-SG-06 | Settings: Skills grouped by provenance | Понятность | UI | built-in/user/imported/generated видны | UI smoke |
| 190-SG-07 | Usage/provenance in prompt context only when needed | Не раздувать контекст | compose-system/skills | no noisy injection | snapshot test |

**Status 2026-07-08 SG seed:** `190-SG-01` and `190-SG-02` are closed as a compact governance foundation.
Added `docs/SKILL_GOVERNANCE_AUDIT_2026-07-08.md`, append-only migration 40 for `skill_usage`, storage facade `electron/storage/skill-usage.ts`, IPC `skills:usage` / `skills:record-use`, and best-effort usage counting from `setActiveSkill(id)`.
Targeted verification: `npx vitest run tests/storage/skill-usage.test.ts tests/store/skill-store.test.ts tests/ai/skills-frontmatter.test.ts tests/ai/skills-loaders.test.ts tests/ai/skills-server-load.test.ts` -> green, 5 files / 24 tests; `npm run type` -> green.

**Status 2026-07-08 SG archive update:** `190-SG-03` and compact `190-SG-04` are closed.
Archived skills are hidden by `skill_usage.state='archived'` instead of deleting built-ins, local `~/.verstak/skills/*.md` files move to `.archive/`, restore moves matching archived markdown back, and IPC/bridge/types expose `skills.archive` / `skills.restore` for the future Settings controls.
Targeted verification: `npx vitest run tests/storage/skill-usage.test.ts tests/ai/skill-archive.test.ts tests/ai/skill-registry-governance.test.ts tests/store/skill-store.test.ts tests/ai/skills-frontmatter.test.ts tests/ai/skills-loaders.test.ts tests/ai/skills-server-load.test.ts` -> green, 7 files / 28 tests; `npm run type` -> green.

## Phase 6. 1.9.x: Eval / Trajectory / Proof

| ID | Задача | Зачем | Где | Готово, когда | Проверка |
|---|---|---|---|---|---|
| 19X-EVAL-01 | Normalize recipe trace schema | Сравнивать модели честно | headless runner | stable JSON fields | trace test |
| 19X-EVAL-02 | Export small eval pack | Проверять дешевые модели повторяемо | scripts/docs | one-command eval | dry run |
| 19X-EVAL-03 | Trace secret scanner | Нельзя утечек ключей | secret scanner | trace clean | targeted test |
| 19X-EVAL-04 | Store eval result summary in docs/status | Decisions survive sessions | docs/STATUS | latest matrix visible | readback |
| 19X-EVAL-05 | Proof Pack links run lifecycle + artifacts | Клиентский результат, не только dev-log | Proof/Runs | proof includes model/run/verify/review | smoke |

## Phase 7. 1.9.x: Controlled Remote Operator

Это не full OpenClaw gateway. Только полезные куски, которые усиливают Verstak.

| ID | Задача | Зачем | Где | Готово, когда | Проверка |
|---|---|---|---|---|---|
| 19X-REM-01 | Proof delivery hardening: Telegram/Bitrix/Downloads | Доставка результата без GUI | connectors/proof | safe opt-in delivery | targeted smoke |
| 19X-REM-02 | Scheduled proof report | Агент может отчитаться по долгой работе | scheduler/proof | opt-in report sent | local fake connector test |
| 19X-REM-03 | Remote command inbox: design only | Не лезть в опасный full control | docs | threat model готов | review |
| 19X-REM-04 | Approval required for any inbound mutation | Safety | policy | no inbound write without approve | tests before code |

## Первые 10 задач, которые стоит делать прямо сейчас

1. `P0-01`: зафиксировать audit + этот план в docs.
2. `P0-02`: добавить в `STATUS.md` строку текущего фокуса: security/process/worktree.
3. `188-PATH-01`: тест явного absolute read outside project.
4. `188-PATH-02`: тест записи в allowed external root.
5. `188-PATH-04`: symlink escape для allowed root.
6. `188-CMD-01`: command approval binding test.
7. `188-CMD-02`: shell chaining/allowlist bypass test.
8. `188-SKILL-01`: skill install path traversal guard.
9. `188-SEC-01`: один вход `test:security` или документированная targeted-команда.
10. `188-SET-01`: UI smoke настроек "Что разрешено" и "Найти CLI".

## Не делать сейчас

- Не добавлять новые providers/connectors ради сравнения с конкурентами.
- Не строить full marketplace/ClawHub clone.
- Не делать большой sandbox/container rewrite в 1.8.8.
- Не делать полный messaging gateway.
- Не трогать production/server без отдельного явного разрешения.
- Не расширять README маркетингом вместо инженерного hardening.
- Не выпускать installer без `type`, `test:fast`, `build` и install/update smoke.

## Definition of Done для каждого мини-спринта

1. Есть короткий scope в `STATUS.md` или docs.
2. Есть targeted test/smoke на главный риск.
3. GUI и headless не расходятся по safety-правилу.
4. Секреты не попадают в logs/trace.
5. `npm run type` зеленый.
6. `npm run test:fast` зеленый, если менялся runtime.
7. `npm run build` зеленый перед релизной сборкой.
8. Для release: installer build + clean install/update smoke + public download check.

## Рекомендация

Следующий реальный спринт: **1.8.8 security regression pack**.

Он маленький, дает максимальный прирост доверия и прямо поддерживает то, что Павел просил: дать агенту больше свободы с явными путями и Downloads, но не получить хаос с секретами, symlink-escape, command injection и чужими папками.
