# Competitor Audit: Hermes Agent / OpenClaw / Verstak

Дата: 2026-07-06

Источники:
- `C:\Users\Pavel\Downloads\verstak-competitor-audit\hermes-agent` — NousResearch/hermes-agent, rev `7426c09`
- `C:\Users\Pavel\Downloads\verstak-competitor-audit\openclaw` — openclaw/openclaw, rev `5b06eba9`
- `C:\Users\Pavel\Progetc\Проекты\verstak` — текущий Verstak `main`, после 1.8.8 external write roots

## Короткий вывод

Verstak не должен копировать ни Hermes, ни OpenClaw целиком. Они решают другие задачи:

- Hermes сильнее как удалённый самообучающийся agent runtime: TUI, gateway, cron, memory/skills curation, terminal backends, session resume, trajectory tooling.
- OpenClaw сильнее как личный always-on gateway/assistant platform: каналы, устройства, pairing/security, sandbox profiles, lifecycle streams, managed worktrees, огромная security-test культура.
- Verstak сильнее как Windows desktop coding agent: GUI, release/install/update, provider/model policy, recipe enforcement, review gate, Proof Pack, controlled editing UX, локальный продукт для разработки.

Главная зона, где мы хуже: не модельная часть, а operator runtime: долгие/фоновые процессы, session lifecycle, managed worktrees, sandbox matrix, security regression harness.

## Сравнение

| Зона | Hermes | OpenClaw | Verstak сейчас | Кто сильнее |
|---|---|---|---|---|
| Desktop coding UX | TUI/CLI + gateway, desktop есть, но не главный фокус | Control UI/Hub, но фокус personal assistant | Electron desktop, Settings, Runs, Proof, installer | Verstak |
| Coding enforcement | Есть tools/approval/checkpoints, но меньше recipe-specific release hardening | Очень сильные tool policy/sandbox/approval surfaces | Recipes, auto-baseline, review gate, fail-closed, model eval | Verstak по coding flow |
| Gateway/channels | Telegram/Discord/Slack/WhatsApp/Signal/Email | Огромный channel matrix: Telegram/WhatsApp/Slack/Discord/Matrix/iMessage/etc. | Коннекторы есть, но не unified live gateway | OpenClaw/Hermes |
| Memory | Closed learning loop, session search FTS5, skill curation | Много memory docs/SDK/active memory | Core/project memory, FTS, governance, but less autonomous | Hermes |
| Skills | Skills Hub, skill usage/provenance, curator/archive/restore | ClawHub, workspace skills, skill install verify | First-class skills + recipes, but no full skill marketplace/curator | Hermes/OpenClaw |
| Worktrees | Session/branch concepts | Managed worktrees: create/remove/restore/snapshot/gc | Isolated chat/worktree exists, simpler lifecycle | OpenClaw |
| Long-running/background | terminal backends, cron, gateway, remote sessions | process tool, background exec, queue/wait/lifecycle | terminal + scheduled/autonomous, weaker process manager | OpenClaw/Hermes |
| Security regression culture | path security, approvals, safety tools | Very strong: opengrep/GHSA-style rules, pairing, scoped auth | path-policy/secret scanner/mode policy, tests growing | OpenClaw |
| Installer/release | install scripts, less Windows product polish | npm/daemon/hub, many surfaces | NSIS, latest.yml, direct download, smoke/install checks | Verstak |
| Research/eval | trajectory generation/compression | benchmark/maturity docs | cheap model eval matrix + smoke | Hermes/Verstak tie |

## Что принять в рабочий протокол

1. Security regression pack по опасным поверхностям

OpenClaw держит security/opengrep правила под прошлые семейства уязвимостей: approval binding, workspace dotenv guard, browser navigation/SSRF, sandbox path guards, config mutation, skill install target guards. Для Verstak это надо адаптировать как `scripts/security-audit.mjs` или `tests/security/*.test.ts`, не как тяжёлый внешний opengrep dependency на первом шаге.

Минимальный набор для Verstak:
- path/write roots: absolute read, allowed external write roots, symlink escape;
- command approval binding: показываемая команда должна совпадать с исполняемой;
- browser/web fetch SSRF: redirects, private IP, metadata endpoints;
- skill install/import: запрет записи вне skill root, no env/secret exfiltration;
- gateway/provider config mutation: опасные флаги только через явное подтверждение.

2. Managed worktree lifecycle

OpenClaw сильнее нас тем, что worktree — это ресурс с registry, snapshot, restore, gc и lossless-delete правилами. У Verstak уже есть изолированные чаты/worktree, но не хватает операторской зрелости.

Нужно взять:
- список worktree в Settings/Project;
- restore удалённого/старого worktree;
- cleanup policy: не удалять dirty/unpushed;
- snapshot before delete;
- понятный статус “чисто / dirty / unpushed / restorable”.

3. Session lifecycle / queue semantics

OpenClaw документирует agent loop как lifecycle stream: accepted → queued/running → tool/assistant streams → lifecycle end/error → wait. У Verstak есть timeline/events, но для внешнего/headless/long-run режима это надо стандартизировать.

Нужно взять:
- `runId` как основной ключ;
- `agent.wait`-подобный IPC/CLI contract;
- session lane queue per chat/session;
- stuck-session diagnostics;
- terminal/process outcome as structured event.

4. Skill usage/provenance/curation

Hermes сильнее в жизненном цикле skills: usage counters, agent-created provenance, protected built-ins, hub-installed read-only, archive/restore. У Verstak есть skills, но нет зрелой гигиены библиотеки.

Нужно взять:
- `skill_usage` table or JSON setting в SQLite;
- provenance: built-in / user / imported / generated / marketplace;
- protected built-ins;
- архивирование вместо удаления;
- “кандидаты на улучшение” только для user/generated skills, не для чужих.

5. Background process manager

OpenClaw лучше формализовал long-running exec: foreground/background, yield, process tool, notify on exit, cleanup TTL. У Verstak есть терминал и run_command, но как агентный фон это слабее.

Нужно взять:
- background command handles;
- `read_process`, `stop_process`, `process_status`;
- notification on exit;
- TTL cleanup;
- запрет silent orphan процессов.

## Что можно адаптировать позже

1. Messaging gateway

Hermes/OpenClaw сильны в Telegram/Discord/Slack/WhatsApp/etc. Для Verstak это не должно стать ядром 1.8.8. Правильнее идти через Proof delivery, reminders, agency reports, Telegram/Bitrix/Sheets connectors. Полный multi-channel gateway — позже, если Verstak становится always-on office agent.

2. Mobile/nodes/canvas

OpenClaw devices/nodes/canvas/talk mode впечатляют, но это другой продукт. Для Verstak сейчас ROI низкий.

3. ACP/agent runtime bridge

OpenClaw глубоко интегрирует ACP/Codex runtime. У Verstak уже есть CLI/API providers и headless recipe runner. Можно взять идеи permission profile для external CLI, но не тащить весь ACP слой.

4. Trajectory research tooling

Hermes умеет trajectory generation/compression. У нас есть cheap model eval и traces. Можно позже сделать Proof/eval traces пригодными для training/eval, но это не блокер продукта.

## Что не брать

- Не превращать Verstak в OpenClaw-style personal assistant gateway прямо сейчас.
- Не добавлять десятки каналов и companion apps до стабилизации core coding agent.
- Не переносить чужие skill marketplace/ClawHub/Skills Hub целиком.
- Не вводить большую sandbox/container архитектуру в 1.8.8 без маленького proof path.
- Не расширять провайдеры ради “догнать списком”.

## Где Verstak хуже прямо сейчас

1. Worktree/resource lifecycle

У нас есть полезная изоляция, но нет полноценного lifecycle: registry, snapshot, restore, GC, dirty/unpushed protection как продуктовая поверхность.

2. Background exec/process control

Agent loop умеет команды, но не имеет достаточно удобного process manager для долгих задач: запустить, отпустить, проверить, остановить, получить outcome.

3. Security regression harness

У нас есть точечные tests и path-policy, но нет “каталога прошлых классов атак” как у OpenClaw.

4. Skill governance

Skills в Verstak рабочие, но библиотека не управляется как живой актив: нет usage/provenance/archive/curation UI.

5. Remote/always-on surface

Hermes/OpenClaw лучше для сценария “агент живёт на сервере/в телефоне/в мессенджере”. Verstak сильнее как desktop coding app, но слабее как постоянно работающий remote operator.

## Где Verstak лучше

1. Coding release loop

Recipe protocol, baseline-aware verification, mandatory review gate, fail-closed max-turns, Proof Pack и cheap model eval дают более жёсткий coding workflow, чем generic assistant loop.

2. Windows desktop/product packaging

NSIS installer, portable exe, latest.yml, install smoke, direct download UX — это сильнее, чем у них в контуре “обычному пользователю скачать и поставить”.

3. Provider economics for Павел/РФ

Verstak Gateway + модельная политика + Kimi/DeepSeek/Qwen eval лучше заточены под дешёвый controlled coding.

4. User-visible control

Settings/ModelPicker/Policy Center/Runs/Proof делают контроль видимым. У конкурентов много силы в config/docs/CLI, но меньше “простого desktop объяснения”.

## Рекомендация по roadmap

### 1.8.8

Цель: закрыть “agent freedom without chaos”.

- Уже сделано: allowed external write roots.
- Следом: UI-smoke + small Settings polish.
- Добавить security regression pack для path/write/approval/browser/skill install.
- Добавить process tool v1: background command handles.

### 1.8.9

Цель: worktree lifecycle.

- Worktree registry page.
- Restore/snapshot before delete.
- Dirty/unpushed guard.
- Session/worktree status in Runs.

### 1.9

Цель: agent operator maturity.

- Standard run lifecycle contract: accepted/running/tool/end/error/wait.
- Stuck-session diagnostics.
- Skill usage/provenance/archive.
- Optional Telegram delivery/control for proof/results, not full OpenClaw channel sprawl.

## Топ-5 backlog после аудита

1. Security regression pack inspired by OpenClaw GHSA/opengrep rules.
2. Managed worktree lifecycle with snapshot/restore/GC.
3. Background process manager for long-running agent commands.
4. Skill governance: usage/provenance/archive/curator candidates.
5. Run lifecycle/wait contract for GUI + headless parity.

## Итоговая оценка

Если сравнивать как “coding agent для Павла/команды на Windows”, Verstak уже лучше и практичнее.

Если сравнивать как “always-on remote personal agent”, Hermes/OpenClaw впереди.

Если сравнивать как “безопасная операторская платформа с многими каналами и sandbox policy”, OpenClaw впереди.

Если сравнивать как “самообучающийся agent с живой памятью/skills”, Hermes впереди.

Правильный ход: не догонять по ширине, а взять из них 4 инженерные привычки: security regression catalog, managed lifecycle, process manager, skill governance.
