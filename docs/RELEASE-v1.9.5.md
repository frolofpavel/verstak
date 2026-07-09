# Verstak 1.9.5

Дата: 2026-07-10

**Статус: в `main`, публикация GitHub Release ожидает Павла** (см. «Перед публикацией» ниже).

Бандл трёх блоков:
1. **Подписочный реестр аккаунтов (1.9.3)** — пул аккаунтов на провайдера + ручное переключение (Claude token, Codex CODEX_HOME).
2. **Авто-переключение аккаунта на лимите (1.9.4)** — активный аккаунт бьёт лимит → Verstak сам переключается на следующий готовый, не теряя историю.
3. **Глубокая интеграция CLI-подписок (ночной автономный спринт, 5 срезов)** — ниже.

Мотив спринта: Павел ощущал, что при подключённом CLI-провайдере (Claude/Grok/Codex) получается «просто окно ввода текста», а не полноценный контролируемый чат как у Hermes/OpenClaw. Разбор показал: все CLI у нас — one-shot headless, а родной tool-таймлайн CLI выбрасывался парсером. Спринт закрывает разрыв честно, без фейковых заглушек.

Clean-by-default: ToS-серый direct-OAuth (Mode C) и рискованный Codex-native протокол (Mode B) осознанно НЕ трогали в автономном ночном режиме.

## Что нового (CLI-глубокая-интеграция)

### Срез 1-2 — Проекция родного tool-таймлайна (`d0e7f9c`, `d69b036`)
Claude Code и Codex выполняют инструменты ВНУТРИ бинаря. Раньше эти события молча выбрасывались, и в Timeline виднелся только финальный текст ответа. Теперь:
- **Claude:** `tool_use`-блоки (`Read`/`Edit`/`Bash`/…) проецируются как tool-call события.
- **Codex:** `command_execution`/`local_shell_call`/`file_change`/`patch`/`mcp_tool_call`/`web_search` item'ы.

Проекция **информационная** — наш executor их не переисполняет (CLI уже выполнил); `runPlainConversation` релеит их как tool-activity. Grok отложен: streaming-shape его tool-событий не подтверждён на fake-fixture — не тащим непроверенное.

### Срез 3 — Честные runtime-ярлыки контроля (`625de3b`)
Уровень контроля теперь считается из **provider+transport**, а не из одного transport:
- **API** → «Полный контроль» (инструменты гейтит и исполняет сам Verstak).
- **claude-cli / codex-cli** → «Наблюдаемый» (таймлайн виден благодаря срезам 1-2, но исполнение/проверка/откат вне Verstak).
- **grok-cli / gemini-cli** → «Урезанный» (даже таймлайн не виден).

Ни один CLI не показывается как full control. Бейджи в ModelPicker (строка модели) и Инспекторе запусков (прошлый прогон), i18n ru/en. Чистый модуль `src/lib/runtime-capability.ts`.

### Срез 4 — Control Envelope: git-якорь отката (`72c5cef`)
CLI пишет файлы мимо undo-стека Verstak, поэтому «checkpoint над undo-стеком» для CLI был бы полой фичей. Честный якорь — git: перед каждым CLI-прогоном снимается HEAD + недеструктивный `git stash create` снапшот грязных tracked-правок (рабочее дерево и stash-список не трогаются). Событие «🛟 Контрольная точка» видно в Timeline + пишется в journal + agent-run event. Ставится даже на one-shot. Provenance без секретов (`electron/ai/control-envelope.ts`).

### Срез 5 — permission-mode + guard секретов для claude-cli (`476a73d`)
Режим агента зеркалится в документированный claude `--permission-mode`:
`ask→default`, `accept-edits/auto→acceptEdits`, `plan→plan`, `bypass→bypassPermissions`.
Без этого headless `--print` не давал агенту писать — корень ощущения «CLI = окно ввода».

Включив запись, закрыли секреты и в CLI: `--disallowedTools 'Read(**/.env)'`… для `.env`/`.ssh`/ключей/creds для Read/Edit/Write (зеркало `isForbiddenPath`; раньше guard жил ТОЛЬКО на API-пути). Guard передаётся даже в bypass (best-effort). Grok отложен: research не подтвердил permission-аналог и синтаксис path-deny у grok-cli.

## Проверка
- `npm run type` — pass (0 ошибок) на каждом срезе.
- `npm run test:fast` — pass, 0 failed. Полный pre-commit хук (type + vitest) прогонялся на каждом коммите.
- TDD на каждый срез: `claude-cli-tool-projection` (2), `codex-stream` (+1 проекция), `runtime-capability` (6), `control-envelope` (10), `claude-cli-permission` (8).

## Известные ограничения
- **Bash-эксфильтрация** секретов из CLI (`cat .env`) флагами надёжно не режется (inherent-лимит headless CLI). Сеть безопасности — Control Envelope (git-якорь) + осознанный выбор режима.
- **Runtime-enforcement** claude-guard опирается на документированную deny-семантику Claude Code, а не на живой OAuth-прогон (ночью его не сматчить автоматом).
- **Grok** — проекция tool-таймлайна и permission-mode отложены до подтверждения формата/флагов на живом grok.
- **RuntimeAdapter-контракт** (срез 6) сознательно не делали: спекулятивная абстракция без потребителей (против §6 CLAUDE.md).

## Перед публикацией (для Павла)
1. **Живой smoke claude-cli в accept-edits:** убедиться, что claude реально пишет файл и НЕ читает `.env` (guard работает на живом бинаре, а не только на уровне args). Это ключевая непроверенная точка — я не мог сматчить OAuth-прогон ночью.
2. Проверить подписочные провайдеры (Kimi/Z.ai) на ключах — гейт релиза 1.9.3 из STATUS.
3. Ритуал релиза: `npm run dist:win` → tag/push → GitHub Release (REST API) → `latest.yml` последним. Версия в `package.json` уже 1.9.5.
4. Если публикуем — обновить страницу загрузки и (зона Codex/dev-hq) `agi-iri.ru/verstak`.
