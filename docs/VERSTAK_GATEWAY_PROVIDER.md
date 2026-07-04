# Verstak Gateway — провайдер

**Что это.** Единый AI-баланс Verstak через AGI IRI Gateway: рубли, без чужих карт и VPN, один ключ → понятные пресеты вместо сотни моделей. BYOK-провайдеры (свои ключи OpenAI/Claude/DeepSeek/…) остаются доступны — Gateway это дополнительный режим.

## Как подключить
1. Настройки → Провайдеры → **Verstak Gateway**.
2. Вставить ключ `vsk_live_...` (получить + пополнить баланс: https://agi-iri.ru/gateway/).
3. В селекторе модели выбрать модель или пресет. Для agent/coding задач дефолт с 2026-07-04 — `kimi-k2.7-code`.

## Пресеты (в API уходит `id`, в UI — русское имя)
| id | UI | для чего |
|---|---|---|
| `verstak/economy` | Эконом | черновики, суммаризация, массовые операции |
| `kimi-k2.7-code` | Kimi K2.7 Code - default | рекомендуемый coding/planner/reviewer default по Stage 11 matrix |
| `deepseek-chat` | DeepSeek Chat - fallback | coding fallback, быстрые bugfix/test-fix/typescript-error |
| `qwen3-coder` | Qwen3 Coder - allowed | usable fallback, не default для required-review bugfix |
| `verstak/balanced` | Баланс | совместимый preset; для agent defaults рекомендуется remap на `kimi-k2.7-code` |
| `verstak/coder` | Кодинг | разработка, правки, агентские задачи |
| `verstak/long` | Длинный контекст | большие файлы/документы |
| `verstak/fast` | Быстро | не использовать как agent default до remap; Stage 11: 1/5 strict pass |
| `verstak/private` | Приватно | приватные/локальные модели |

Fusion-пресеты (`verstak/fusion-*`, «Коллегия моделей») — Phase 4.

## Agent Model Policy

Текущая policy зафиксирована по 45-run live matrix от 2026-07-04 (`docs/cheap-model-eval-2026-07-04.md`):

- default coding / planner / reviewer: `kimi-k2.7-code`;
- fallback coding: `deepseek-chat`;
- `qwen3-coder`: allowed/fallback, но не default для gate-heavy bugfix;
- `verstak/fast` и `verstak/coder/fast`: not recommended for agent mode до server-side remap;
- `verstak/balanced` и `verstak/coder/balanced`: совместимость сохранена, рекомендованный target — `kimi-k2.7-code`;
- пользовательский явный выбор модели сохраняется и не блокируется.

## Стоимость в ответе
Если Gateway вернул метадату — под ответом плашка: `Verstak · 0.84 ₽ · Баланс 923.10 ₽ · Кэш 42%`.

## Ошибки (человеко-читаемые)
- **401/403** — ключ неверный/отключён → проверь ключ в Настройках;
- **402** — нет баланса → пополни на agi-iri.ru/gateway;
- **429** — превышен лимит → позже или увеличь лимит;
- **503** — модель/провайдер недоступны (Gateway пробовал резерв).

## Безопасность
Ключ хранится зашифрованно (safeStorage), не логируется, не уходит в prompt/tool output — как все provider-ключи.

## Тех-детали
- OpenAI-совместимый: `POST {baseUrl}/chat/completions`, `baseUrl=https://api.agi-iri.ru/v1`.
- Реализация: `electron/ai/extra-providers.ts` (spec + `GATEWAY_PRESET_LABELS`), `gateway-meta.ts` (метадата/ошибки), `openai-compat.ts` (общий клиент). Зеркало UI — `Settings.tsx` + `useProvider.ts` + `ModelPicker.tsx`.
- Чтобы пресеты реально маршрутизировались — бэкенд AGI IRI Gateway маппит `verstak/*` → реальный upstream (Track B на сервере).
