# Задача 9 — Open Design: разбор + что берём (исследование фонового агента)

Источник: `C:\Users\Pavel\dev\ai-platforms_ROOT_проверить\open-design` (read-only разбор).
Это сырьё под предложение Задачи 9 (в порядке — после 8). Синтез/финальное предложение
готовлю, когда дойду по очереди.

## Что это
pnpm-монорепо, local-first десктоп-студия дизайна, архитектурно близка Verstak, но
сильнее разбита на процессы: Next.js 16 UI (`apps/web`) ⇄ HTTP/SSE ⇄ локальный демон
`od` (Express 5 + better-sqlite3, вся persistence + СПАВН внешних CLI-агентов дочерними
процессами, НЕ SDK) ⇄ stdio ⇄ ~24 CLI-агента / AMR. Electron 41 (`apps/desktop`) —
тонкая оболочка, находит порт демона через sidecar-IPC (`packages/sidecar*`), не хардкодит.
Общие типы — `packages/contracts`. Verstak всё это схлопывает в Electron main + sqlite.

## Механики сильнее/иначе, чем у Verstak (с файлами)
- **Декларативный реестр CLI-агентов** `RuntimeAgentDef` (`apps/daemon/src/runtimes/defs/*.ts`
  + `registry.ts`): 24 агента как ДАННЫЕ (bin/buildArgs/streamFormat/listModels/
  mcp-injection/authProbe/resumesSessionViaCli/...). Добавить агента = файл данных, не код.
  `local-profiles.ts` — юзер задаёт свои профили на диске.
- **AMR (Agentic Model Router)** `runtimes/defs/amr.ts` — платный хостед-роутер как ещё
  один адаптер (гонит `vela` в ACP-stdio). «Интеллект» = нормализация model-id + порядок
  предпочтений + детект возможностей/авторизации, НЕ семантический роутинг задач.
- **Live-model validation cache** `runtimes/models.ts`: кэш последних живых model-id +
  `sanitizeCustomModel` — отклоняет неизвестные/флагоподобные id ДО спавна CLI.
- **Plugin runtime + подписанный registry-protocol** (`packages/plugin-runtime`,
  `registry-protocol/schemas.ts`): SKILL.md frontmatter → PluginManifest; trust-tiers
  (official/trusted/restricted), подписи (oidc/cosign/minisign), integrity, yank/doctor.
  Манифест богаче скиллов Verstak: пайплайны (stages/atoms/onFailure), GenUI-поверхности
  (form/choice/confirmation/oauth, persist-scope).
- **DESIGN.md — контракт дизайн-системы** (`design-systems/_schema/`): 4-слойная схема
  токенов + машинные гварды. Brand-contract-as-filesystem.
- **Live Artifacts** (`specs/2026-04-29-live-artifacts/spec.md`) — ЖЕМЧУЖИНА: обновляемые,
  data-backed, аудируемые артефакты. `template.html + data.json → рендер демоном → index.html`,
  крошечный `html_template_v1` binding (escaped {{data.path}} + data-od-repeat, БЕЗ JS/raw
  HTML). Refresh: per-artifact lock, монотонный refreshId, таймауты, `refreshes.jsonl`
  audit, снапшоты, fail-closed. Доступ агента — SKILL.md + `od tools` (НЕ MCP-first), gated
  run-scoped bearer `OD_TOOL_TOKEN` (binds runId+projectId). Коннекторы read-only-first,
  пере-классификация безопасности НА ИСПОЛНЕНИИ (каталог — не авторизация).
- **Манифест артефакта + entry-file** (`CONTEXT.md`): каждый артефакт = entry file +
  sidecar-манифест (kind/renderer/exports/entry). Единый роутинг превью/экспорта.
- **Песочница превью с мостами** (`apps/web/src/runtime/srcdoc.ts`): iframe
  sandbox=allow-scripts + postMessage-мосты (comment/inspect/manual-edit→source-path/
  palette/deck). Превью ИНТЕРАКТИВНО и возвращает правки в исходник.
- **Automation/workflows** (`routes/automation*.ts`, `routine.ts`): повторяемые процессы
  как proposals (create/apply/reject) + расписания.
- **Handoff** (`handoff-design.ts`): сжать диалог в самодостаточное «первое сообщение»
  для свежей сессии/код-агента (read-only, BYOK, без хранения кред).

## Рекомендации (приоритет)
| # | Идея | На Verstak | Вердикт |
|---|------|-----------|---------|
| 1 | Декларативный реестр агентов (RuntimeAgentDef) | 18 провайдеров → одна типизированная таблица данных; 5 режимов сверху | **БЕРЁМ** — крупнейший выигрыш поддерживаемости |
| 2 | Live-model cache + sanitizeCustomModel | к per-chat picker; хардит спавн CLI от инъекции `--flag` в model | **БЕРЁМ** — малый, чистый, security |
| 3 | Live Artifacts (refresh + аудит) | поверх 31 read-only RU-коннектора + embedded preview + checkpoints; аудит=ДНК proof-pack | **БЕРЁМ (фазами)** — высшая ПРОДУКТОВАЯ ценность, ложится на edge Verstak |
| 4 | Run-scoped tool token | к PTC + коннекторам: агент не выйдет за свой chat/project | **БЕРЁМ** — дёшево, control-first |
| 5 | Интерактивные мосты превью (edit→source) | к webview/artifact preview; правки↔исходник пара к per-file undo | **БЕРЁМ** — превью → поверхность правок |
| 6 | Манифест артефакта + entry-file | единый манифест артефактов | **АДАПТ** — легче, чем у OD |
| 7 | Skill→manifest, пайплайны + GenUI | у Verstak уже skills-as-md; взять пайплайны (многостадийные скиллы) + confirmation-поверхности | **АДАПТ** — без marketplace-обёртки |
| 8 | Подписанный registry с trust-tiers | только если открываем marketplace скиллов/коннекторов | **АДАПТ (позже)** — преждевременно |
| 9 | DESIGN.md 4-слойные токены | Verstak не дизайн-тул; максимум идея машинно-валидируемого project-context файла для «мозга» | **ПРОПУСК (в осн.)** |
| 10 | AMR облачный роутер | Verstak BYOK, control, RU-рынок; чужой хостед-брокер — риск | **ПРОПУСК** — берём паттерн адаптера (#1), не сервис |
| 11 | Раскол daemon/sidecar | у Verstak логика в Electron main+sqlite; вынос демона — крупный рерайт | **ПРОПУСК (пока)** — только если понадобится headless (а это уже строится отдельной линией!) |
| 12 | Синтез диалога в handoff-seed | «передать этот чат» → портируемое seed-сообщение | **АДАПТ** — мал, к делегации/инспектору |
| 13 | Automation proposals + расписания | слой «сохрани workflow / запусти по расписанию» над мультиагентом | **АДАПТ (позже)** — после live artifacts + реестра |

### Скептик
- AMR не магия: нормализация id + детект возможностей, не семантический роутинг. Брать
  #2 (validation cache), не бренд.
- read-only-first коннекторы совпадают с 31 RU-коннектором Verstak — НЕ тащить OAuth-write
  roadmap без правила «пере-классификация на исполнении, каталог ≠ авторизация».
- Всё ценное едет на CLI-spawn-архитектуре, которая у Verstak уже есть. Лучший value/effort:
  **реестр агентов (#1)** и **Live Artifacts на существующих коннекторах (#3)**.
- ПЕРЕСЕЧЕНИЕ С ТЕКУЩЕЙ РАБОТОЙ: #11 (daemon/headless) — ровно то, что строит параллельная
  headless-линия Verstak. #3 Live Artifacts стоит свести с их работой.

Ключевые файлы: `apps/daemon/src/runtimes/{types,models,registry}.ts` + `defs/*.ts`;
`specs/2026-04-29-live-artifacts/spec.md`; `apps/web/src/runtime/srcdoc.ts`; `CONTEXT.md`;
`packages/contracts/src/plugins/manifest.ts`; `packages/registry-protocol/src/schemas.ts`;
`apps/daemon/src/handoff-design.ts`.
