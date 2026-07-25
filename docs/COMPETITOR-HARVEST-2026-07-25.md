# Verstak — selective harvest OpenClaw, Hermes Agent и OpenCode

Дата проверки: 2026-07-25.

## Что проверено

Проверены актуальные исходники и локально установленные версии без чтения
credentials, токенов и session-файлов:

| Система | Локальная версия | Проверенный upstream |
|---|---:|---|
| OpenClaw | 2026.7.1 | `e2790760102aee5d99504bce640a5b3160df5331` |
| Hermes Agent | 0.19.0 | `07e97d2f5dc3d2092cfe693ef07b2527a36cd2d8` |
| OpenCode | 1.17.18 | `7534d23551f665e65080809975b4ca5c7d63807b` |

Изучались не интерфейсы, а production-механизмы:

- OpenClaw: порядок auth profiles, eligibility, cooldown и причины отказов;
- Hermes Agent: memory lifecycle, batch-операции памяти, credential pools,
  permanent failures и reset timers;
- OpenCode: auth storage и compaction с сохранением последних ходов и уже
  созданных summary.

## Что реализовано в Verstak сейчас

### 1. Атомарное обновление core memory

Добавлен `core_memory_update`: агент может одним вызовом выполнить до 50
операций `add`, `replace`, `remove`.

Инварианты:

- сначала весь batch применяется к рабочей копии;
- при ошибке одной операции не записывается ничего;
- бюджет проверяется по финальному состоянию, поэтому `remove + add` работает
  даже при заполненном блоке;
- секреты редактируются до записи;
- файл сохраняется через временный файл и атомарный rename.

Это переносит полезную механику Hermes batch memory, но оставляет память
локальной и управляемой внутри проекта Verstak.

### 2. Permanent auth state для подписок

Ранее отозванный refresh token мог снова и снова попадать в охлаждение и
повторные попытки. Теперь:

- `invalid_grant`, revoked/invalidated token, `unauthorized_client` и
  `refresh_token_reused` классифицируются как permanent auth failure;
- аккаунт переходит в `invalid`, а не в временный cooldown;
- `invalid` исключён из автоматической ротации;
- pre-flight останавливает запуск с понятным `login-required`;
- Doctor прямо сообщает, что нужен повторный вход;
- обычный 401 без доказательства permanent failure остаётся восстановимым и
  получает короткий cooldown;
- parser понимает составные и дробные интервалы, например `4hr 5min` и
  `1.5 seconds`.

Это сочетает сильные стороны OpenClaw failure reasons и Hermes credential
pool, сохраняя durable `accountId` и строгий pre-flight Verstak.

## Что в Verstak уже было и не переписывалось

- hybrid recall и RRF-ранжирование памяти;
- core + archival memory и эвакуация переполнения;
- secret redaction;
- snapshots памяти;
- pre-flight выбор subscription account;
- cooldown scopes;
- durable account lineage на протяжении run и fallback.

Полный перенос чужих memory/provider frameworks дал бы дублирование и
увеличил поверхность ошибок.

## Что можно взять следующим пакетом

1. Lifecycle памяти: `pre-compress` и `session-end` hooks с ограниченным
   фоновым sync.
2. Compaction, которая учитывает предыдущие summary и сохраняет гарантированный
   хвост последних пользовательских ходов.
3. Счётчики failure/success и usage probe для credential pool.
4. Явные стратегии выбора аккаунта: sticky, round-robin, least-used.

Каждый пункт должен идти отдельным срезом с production-path тестом, без
переписывания работающего memory/subscription ядра.

## Что сознательно не переносим

- внешние SaaS memory providers по умолчанию;
- автоматический захват всего prompt/tool/session потока;
- чтение или перенос чужих credential stores;
- полный provider-plugin rewrite;
- сложность gateway OpenClaw и архитектуру OpenCode целиком.

Причина: это увеличивает зависимость, риск утечки и стоимость сопровождения,
не усиливая текущие ключевые сценарии Verstak.

## Источники

- OpenClaw: `src/agents/auth-profiles/order.ts`,
  `src/agents/auth-profiles/usage.ts`, configuration reference и releases.
- Hermes Agent: `agent/memory_provider.py`, `agent/memory_manager.py`,
  `agent/credential_pool.py`, memory providers, credential pools и releases.
- OpenCode: `packages/opencode/src/auth/index.ts`,
  `packages/opencode/src/session/compaction.ts`, CLI auth documentation.
