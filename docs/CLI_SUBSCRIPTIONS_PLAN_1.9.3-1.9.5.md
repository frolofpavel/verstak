# План 1.9.3 → 1.9.5 — гибкая работа с CLI/подписочными провайдерами

**Дата:** 2026-07-09 · **Тема:** сделать работу с подписками (Claude Max, Gemini, Codex, Grok + coding-endpoint'ы Kimi/Z.ai) гибкой: несколько аккаунтов, видимость лимитов, авто-переключение при исчерпании.

---

## 1. Как сейчас (заземлено в коде)

| Факт | file:line |
|---|---|
| 4 CLI-провайдера (claude/gemini/grok/codex), **по одному аккаунту** — фикс путь creds-файла | `electron/ai/cli-auth.ts:46` DESCRIPTORS |
| Auth: детект creds-файла + relogin **открывает терминал** (не в приложении) | `cli-auth.ts:208` reloginCli |
| claude-cli уже умеет **один** OAuth-токен через env `CLAUDE_CODE_OAUTH_TOKEN` | `claude-cli.ts:130` |
| Спавн: `env = {...process.env, TOKEN}` — аккаунт биндится через env | `claude-cli.ts:134` |
| Kimi/Z.ai = подписочные coding-endpoint'ы (OpenAI-совм. API-key), **не** терминальные CLI | `registry.ts:286` |
| Мультиаккаунт / ротация / квота / rate-limit awareness | **нет нигде** (grep пустой) |

**Разрыв:** ядро ценности Verstak — «аккаунт упал → переключился, не теряя работу». Для API-ключей это есть (18 провайдеров + smart-fallback). **Для подписок — нет.** Claude Max бьёт 5-часовой лимит → прогон просто падает, второго аккаунта нет, видимости «сколько осталось» нет.

## 2. Идея: единый слой «Subscription Accounts»

Унифицировать ДВА вида подписочного доступа под одну абстракцию:
- **Терминальные CLI** (Claude Max/Gemini/Codex/Grok): аккаунт = токен (Claude) или изолированный config-dir (`CLAUDE_CONFIG_DIR`/`CODEX_HOME`/gemini-config per-account).
- **Coding-endpoint'ы** (Kimi/Z.ai): аккаунт = API-ключ + base-url.

Один реестр аккаунтов → выбор активного → биндинг env при спавне → видимость состояния → авто-переключение при лимите.

---

## Фаза 1.9.3 — Фундамент: реестр аккаунтов + Kimi/Z.ai smoke

**Цель:** несколько аккаунтов на провайдера + ручное переключение. Плюс закрыть зависший smoke Kimi/Z.ai.

- **DB (миграция 44):** `cli_accounts(id, provider_id, label, cred_ref, config_dir, state, added_at, last_used_at)`. Секреты (токены/ключи) — в SafeStorage по `cred_ref`, не в таблице.
- **Account model** `electron/ai/subscription-accounts.ts`: add/list/remove/setActive/getActive(providerId). Для Claude: N токенов. Для Gemini/Codex/Grok: per-account `config_dir` (изоляция creds). Для Kimi/Z.ai: N (ключ+baseUrl).
- **Runtime:** `createProvider` берёт активный аккаунт → биндит env (токен ИЛИ `*_CONFIG_DIR`/HOME). Точка: `registry.ts:238` + `claude-cli.ts:130`.
- **UI:** Settings → провайдер → список аккаунтов (добавить/переименовать/удалить/сделать активным). Reuse `cli-auth:status-all`.
- **Kimi/Z.ai smoke:** дождаться ключей Павла → прогнать coding-endpoint через recipe bugfix → зафиксировать в реестре как первые не-CLI подписки. *(Зависимость: ключи Павла — см. §5.)*
- **Контракт-инвариант:** секреты только SafeStorage + `scanText` в логах; один аккаунт = один env-биндинг, без гонок между чатами.

**Done:** можно завести 2 Claude-аккаунта, переключить активный кнопкой, прогон идёт под выбранным. Kimi/Z.ai завелись.

## Фаза 1.9.4 — Гибкость: видимость лимитов + переключение

**Цель:** видеть, когда подписка исчерпана, и переключаться (руками и авто).

- **Детектор лимита:** парсер вывода CLI/endpoint на признаки rate-limit/quota (Claude «5-hour limit reached» + reset ETA, Gemini quota, 429 у Kimi/Z.ai) → помечает аккаунт `cooling` с ETA сброса. Файл `electron/ai/subscription-limits.ts`, покрыть тестами на реальных строках.
- **Статус-панель:** per-account состояние (активен / остывает до HH:MM / разлогинен / исчерпан) + last-used. Расширить статус-бар (рядом с cost-controller).
- **Авто-переключение (opt-in):** при детекте исчерпания активного аккаунта → взять следующий доступный того же провайдера, БЕЗ потери прогона. Переиспользовать `attemptProviderFallback` (уже вынесен в аудите 1.5.50 — провайдеры yield error, fallback подключён) на уровне аккаунта.
- **Per-chat биндинг:** чат может закрепить конкретный аккаунт (как per-chat провайдер/модель уже есть).

**Done:** Claude Max #1 бьёт лимит в середине прогона → Verstak переключается на #2 и продолжает; в UI видно «#1 остывает до 14:30».

## Фаза 1.9.5 — Оркестрация: цепочки failover + учёт + in-app auth

**Цель:** политики переключения + учёт расхода подписки + меньше «уходить в терминал».

- **Цепочка failover (политика):** упорядоченный список на роль/режим — напр. `Claude Max A → Claude Max B → Claude API → deepseek`. Расширить `agent-model-policy`.
- **Учёт расхода подписки:** сколько токенов/запросов съедено за день на аккаунт (Claude CLI отдаёт usage в stream — `claude-cli.ts:56`). Витрина рядом с cost-controller.
- **Round-robin / least-recently-limited:** выбор аккаунта не «первый», а наименее недавно лимитированный — размазать нагрузку по пулу подписок.
- **In-app auth (по возможности):** встроенный OAuth-флоу где реально, иначе — направляемый гид вместо голого «открыли терминал». Оценить лифт по каждому CLI (Claude `setup-token` уже headless-friendly).

**Done:** пул из N подписок работает как один устойчивый ресурс с политикой и учётом.

---

## 3. Что НЕ делаем (анти-scope)

- Не автоматизируем создание аккаунтов подписок (это против ToS провайдеров) — только управление уже имеющимися у Павла.
- Не храним пароли — только OAuth-токены/API-ключи в SafeStorage.
- Не строим свой прокси-агрегатор поверх подписок (это Gateway, отдельный продукт).

## 4. Развилка (нужен твой steer — одной фразой)

**Что болит сильнее:**
- **(A) Много аккаунтов ОДНОГО CLI** (пул Claude Max, обходить 5-часовой лимит ротацией) — это спина плана выше, совпадает с ДНК «аккаунт упал → переключился».
- **(B) Гибкое смешение РАЗНЫХ подписок** (Claude + Gemini + Kimi + Z.ai) с умным роутингом по задаче.

План выше собран под **(A)** как приоритет (фундамент один и тот же, но 1.9.3 фокусируется на ротации одного провайдера). Если твой приоритет **(B)** — 1.9.3 сместится на unified-routing поверх разных подписок. Скажи A / B / оба-с-A-первым.

## 5. Зависимости

- **Kimi/Z.ai smoke блокирован ключами Павла** (память `verstak-subscription-providers-2026-07-09`). Без ключей — фундамент 1.9.3 делаем на Claude/Codex, Kimi/Z.ai добавляем когда придут ключи.

### Разведка config-dir механизмов CLI (09.07, проверено — не догадка)

| CLI | Механизм мультиаккаунта | Статус |
|---|---|---|
| **Claude Code** | `CLAUDE_CODE_OAUTH_TOKEN` (токен) ИЛИ `CLAUDE_CONFIG_DIR` | ✅ сделано (token-режим, 1.9.3) |
| **Codex CLI** | `CODEX_HOME` — хирургично весь стейт (auth/config/history) | ✅ сделано (dir-режим, 1.9.3) |
| **Gemini CLI** | config-dir env **НЕ поддерживает** — хардкод `~/.gemini`; открытый FR google-gemini/gemini-cli#2815; только HOME-override (инвазивно) | ❌ заблокировано апстримом |
| **Grok CLI** | нет config-dir override; `~/.grok` + API-key env (`GROK_CODE_XAI_API_KEY`/`XAI_API_KEY`) — токен-путь для headless, не подписка-OAuth | ⚠️ отложено (можно token-режимом, менее проверено) |

**Вывод:** Claude (token) + Codex (CODEX_HOME) — чистые, сделаны. Gemini ждёт апстрим-FR. Grok — опционально токен-режимом.

## Статус реализации (09.07)

- **1.9.3 фаза 1 (реестр + Claude token):** ✅ в main (`919b699`).
- **1.9.3 Codex (CODEX_HOME dir):** ✅ в main.
- **1.9.4 (детектор лимита + авто-переключение аккаунта):** ✅ в main (`aec6cfb`).
- Осталось: Kimi/Z.ai (ключи Павла) → smoke; релиз 1.9.3; **устранение «укороченности» (ниже, §6)**.

---

# §6. Устранение «укороченности» CLI-подписок (план работ, 10.07)

## Проблема (заземлено в коде + разведке Hermes/OpenClaw)

Мы подключаем CLI на **самом слабом из 3 уровней** — one-shot headless (`claude --print`, `codex exec`, `grok -p`). Отсюда ощущение «просто окно ввода текста»:
1. **Без живой сессии** — спавн заново + пере-сериализация истории на каждое сообщение (`cli-prompt.ts`); нет multi-turn/кэша CLI.
2. **Подписка второсортна** — `claude --print` НЕ использует Max OAuth (нужен setup-token; `claude-cli.ts:80`).
3. **Нет родного агентского UX CLI** — CLI отрабатывает одним закрытым выстрелом.

**3 уровня интеграции (разведка конкурентов):**

| Уровень | Механизм | Verstak | Hermes | OpenClaw |
|---|---|---|---|---|
| 1. One-shot headless | `--print`/`exec`, спавн на сообщение | ✅ все CLI | Copilot | fallback |
| 2. Живая сессия + родной runtime | ACP-протокол / `codex app-server` JSON-RPC / `claude --resume --session-id` | ❌ | Codex app-server | ACP (claude/codex/gemini) |
| 3. Direct-API на подписочном OAuth | OAuth-токен из `~/.claude/.credentials.json` → `api.anthropic.com` Bearer + хедеры `anthropic-beta: oauth-2025-04-20`, `user-agent: claude-cli/<ver>` | ❌ | ✅ | ✅ |

## Путь A — Direct-API на OAuth подписки (РЕКОМЕНДОВАН, малый лифт)

**Идея:** для Claude Max не гонять `--print`, а взять OAuth-токен подписки и звать Anthropic Messages API **напрямую** через НАШ агентский цикл. Подписка first-class, все наши тулзы/undo/checkpoints/review-gate/мультиагент композятся, контроль-DNA сохранён.

**Лифт подтверждён малым:** `claude.ts` строит `new Anthropic({ apiKey })`; SDK ^0.97 поддерживает `authToken` (Bearer) + `defaultHeaders`.

### Фаза A1 — OAuth-транспорт в claude-провайдере (S/M)
- `electron/ai/claude.ts`: опц. `authToken` → `new Anthropic({ authToken })` + `defaultHeaders` (`anthropic-beta: oauth-2025-04-20`, `user-agent: claude-cli/<ver>`). Приоритет authToken над apiKey.
- Новый provider-режим (варианты — решить): (a) новый id `claude-max`; ИЛИ (b) когда активен claude-cli аккаунт — роутить на direct-API вместо `--print`. **Рекомендация: (b)** — реестр аккаунтов 1.9.3 уже хранит токен, меньше новых сущностей.
- **TDD:** claude.ts с authToken ставит Bearer + beta-хедеры (не x-api-key); роутинг выбирает direct при наличии аккаунта.
- **Done:** прогон Claude под Max-токеном идёт через наш loop (наши тулзы работают), не через `--print`.

### Фаза A2 — токен-менеджмент + рефреш (M)
- Источник OAuth: из аккаунт-реестра (token-режим) ИЛИ чтение `~/.claude/.credentials.json`.
- **Рефреш:** Max OAuth-токен протухает (~часы) — нужен refresh-flow (competitors рефрешат из `.credentials.json`). Реализовать авто-рефреш по 401/протуханию.
- **Done:** долгая сессия не падает на протухшем токене (авто-рефреш).

### Фаза A3 — роутинг + UX (S)
- Per-chat выбор: Claude Max (OAuth-direct) vs Claude API (ключ). Композит с 1.9.4 авто-свитчем аккаунтов (лимит одного Max-аккаунта → следующий из пула, теперь на direct-API пути).
- **Done:** юзер видит богатый агентский поток Verstak на Max-подписке, не «окно текста».

## ⚠️ Развилка/риск для решения Павла — ToS Anthropic

Прямое использование Max OAuth-токена вне официального Claude Code может **нарушать ToS Anthropic** (Max рассчитан на официальные интерфейсы). Hermes/OpenClaw это делают на свой риск (маскируются под `user-agent: claude-cli`). **Нужно решение Павла:** идём на этот риск (как конкуренты) или держим Max только через официальный `--print`/setup-token путь. Без этого решения A1 не стартуем.

## Путь B — Живая сессия + родной runtime (отложено, большой лифт)

Codex через `codex app-server` (JSON-RPC сессия, как Hermes: persistent, `thread/start`+`turn/start`, проекция событий), Claude через `claude --resume --session-id`. Даёт буквальный «родной чат CLI». Минусы: большая интеграция (протокол сессии/lifecycle/event-projection) + **уступка контроля циклу CLI** (против нашей ДНК). Отдельная ставка после Пути A, если захотим.

## Порядок работ (предложение)

1. **Решение по ToS-риску** (Павел) — гейт для A1.
2. Доделка «полых» фич (уведомления-матрица, PTC+smart-approve тумблеры, README-overclaim) — отдельная пачка (обсуждали, делаем «завтра»).
3. Kimi/Z.ai smoke (ключи Павла).
4. **Путь A: A1 → A2 → A3** (Claude Max first-class через наш loop).
5. Релиз 1.9.3 (весь накопленный пласт).
6. Путь B — по желанию, отдельной большой ставкой.

---
*2026-07-10. Разведка Hermes/OpenClaw (verstak-competitor-audit) проверена по коду: Hermes codex_app_server_session.py + transports/anthropic.py (OAuth-direct); OpenClaw ACP-harness + cli-shared.ts. Лифт Пути A проверен в claude.ts + SDK. Ждёт решения Павла по ToS-развилке.*
