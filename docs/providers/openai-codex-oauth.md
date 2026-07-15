# Провайдер `openai-codex-oauth` — прямой OAuth Codex

**Статус:** Experimental, opt-in. Транспорт — API (наш agent-loop поверх подписки ChatGPT/Codex через direct-OAuth endpoint `chatgpt.com/backend-api/codex/responses`). Формат подтверждён live-смоуком (ground truth Codex 0.144.1).

Это НЕ официальный клиент Codex. Работает поверх внутреннего backend OpenAI; допустимость стороннего native loop явно не гарантирована. Поэтому — только явный opt-in и честный fallback.

## Граница безопасности и политики

- **Не маскируемся под Codex CLI.** `originator` честный (`verstak`), `User-Agent` и иные anti-abuse-признаки НЕ подделываются. Никаких обходов лимитов.
- **Experimental + opt-in.** Провайдер помечен экспериментальным; включается пользователем осознанно. Fallback — официальный `codex-cli` или OpenAI API-ключ.
- **OAuth JSON не хранится в приложении.** Токены живут только в `<CODEX_HOME>/auth.json` на диске (их пишет `codex login`). В SQLite/SafeStorage не копируются, в renderer/log/DTO не уходят.
- **Live-тесты — только opt-in через env, никогда в `test:fast`.**

## Изоляция аккаунтов (2.0.8-C)

`openai-codex-oauth` и `codex-cli` аутентифицируются одинаково: `codex login` пишет `<CODEX_HOME>/auth.json`. Поэтому нативный OAuth-loop использует **тот же активный Codex-аккаунт**, что и `codex-cli` — общий реестр подписочных аккаунтов.

- На старте run в main резолвится активный Codex-аккаунт (реестр `codex-cli`) → его `configDir` передаётся как `codexHome` в конкретный provider instance (`resolveCodexHome` в `electron/ipc/ai.ts`, предикат `isCodexAuthProvider` в `registry.ts`). Оба провайдера делят один активный Codex-аккаунт.
- **`process.env.CODEX_HOME` НИКОГДА не мутируется** — это состояние всего Electron и гонка между чатами. `codexHome` течёт аргументом.
- Credential store (`electron/ai/codex-oauth/credential-store.ts`) читает **только** `<codexHome>/auth.json`. Модульный стейт (single-flight, unpersisted, warnings) ключуется по ПУТИ → разные аккаунты полностью изолированы, cross-write невозможен.
- Нет активного Codex-аккаунта → `codexHome = null` → дефолтный `~/.codex/auth.json` (обратная совместимость с одиночным логином).

История: до 2.0.8-C `codexHome` резолвился только для `codex-cli`, а `openai-codex-oauth` всегда шёл в дефолтный `~/.codex/auth.json` — переключение аккаунтов на нём не действовало (наследие 2.0.4).

## Refresh и 401

- `access_token` рефрешится проактивно (за 5 мин до `exp`) и реактивно на 401.
- **Single-flight по аккаунту** (ключ — путь к `auth.json`): пять параллельных `ai:send` одного аккаунта → один network-refresh (иначе ротация одноразового `refresh_token` дала бы `refresh_token_reused`).
- **401 после refresh не зацикливается:** ровно один refresh + один retry, затем ошибка. Бесконечный retry-loop исключён.
- Если refresh прошёл, но записать `auth.json` не удалось — сессия продолжает работать на токенах в памяти, а пользователь получает предупреждение в Timeline (в упакованном `.exe` консоли нет).

## В run пишем только

Account ID/label + вид авторизации (auth kind). Никаких token claims, `access_token`, `refresh_token` или содержимого `auth.json`.

## Non-goals этого среза (сознательно отложено)

- **Отдельный от `codex-cli` реестр `openai-codex-oauth`-аккаунтов** (свой UI создания + `codex login`-маппинг). Сейчас оба провайдера делят один активный Codex-аккаунт — это тот же ChatGPT/Codex-логин, отдельный реестр пока незачем. Появится при необходимости отдельной сессией (тогда `resolveCodexHome` начнёт учитывать `openai-codex-oauth`-специфичный аккаунт).
- **Per-chat выбор Codex-аккаунта.** Сейчас резолвится глобально-активный аккаунт провайдера (как у `codex-cli` с 1.9.3). Привязка аккаунта к конкретному чату (`ChatSubscriptionBindingDTO`, введён в 2.0.8-B) в маршрутизацию ещё не включена — это зона **2.0.8-D (Route Policy)**. Два РАЗНЫХ Codex-аккаунта одновременно на разных чатах пока невозможны.
- **Шаг карточки 5 (label-only ошибка):** при битом/отсутствующем `auth.json` сейчас показывается путь + «залогинься: codex login», а не только label аккаунта + «Войти снова». Путь секретом не является (токенов не содержит), изоляция/no-leak не нарушены; аккуратный label-only канал — отдельно.
- **Шаг карточки 7 (позитив):** отрицательная половина выполнена (токен/claims в run не пишутся — покрыто тестом); запись `account ID/label + auth kind` в run/journal для observability — отложена.
- **Явный статус `login-required`** после исчерпанного 401-retry (шаг 6): сейчас отдаётся обычная ошибка (bounded, без петли — покрыто тестом); перевод аккаунта в `login-required` — зона 2.0.8-D.
