# Документация Verstak

В этой папке хранятся только действующие контракты продукта и активные планы.
История изменений находится в `CHANGELOG.md`, выпущенные сборки — в GitHub
Releases, а завершённые планы и отчёты доступны в истории Git.

## Продукт и архитектура

- `PROJECT_BRAIN.md` — долговременный контекст проекта.
- `RUN_LIFECYCLE.md` — состояния и ожидание агентного запуска.
- `PROVIDER_CAPABILITIES.md` — границы контроля API- и CLI-провайдеров.
- `providers/openai-codex-oauth.md` — контракт экспериментального Codex OAuth.
- `UI_DESIGN_GUIDE.md` — обязательные правила интерфейса.

## Безопасность

- `SECURITY_MODEL.md` — защитные слои приложения.
- `SECURITY_REGRESSION_PACK.md` — исполняемый каталог security-тестов.
- `INBOUND_MUTATION_THREAT_MODEL.md` — политика внешних изменяющих запросов.

## Model Gym

- `cheap-model-eval-v0-contract.md` — стабильный набор проверочных задач.
- `model-gym-policy.md` — правила назначения моделей на роли.
- `model-gym-arena-methodology.md` — воспроизводимое сравнение Verstak/Codex/OpenCode без ложного рейтинга.

## Активная разработка

- `PERCHATSTATE-PLAN-2026-07-25.md` — оставшаяся миграция состояния чатов.
- `2.0.9-A-chat-map.md` — characterization-карта исходного Chat.
- `superpowers/specs/2026-07-11-mobile-remote-access-design.md` — контракт Mobile Remote.
- `superpowers/plans/2026-07-11-mobile-remote-access.md` — план Mobile Remote.

## Правила порядка

1. Не добавлять сюда журналы работы, handoff-файлы, черновики релиза и отчёты
   исполнителей.
2. Один действующий контракт на одну тему; устаревший документ удаляется, а не
   остаётся рядом с новым.
3. Завершённый план удаляется после отражения результата в `CHANGELOG.md`.
4. Датированный документ допустим только пока работа по нему активна.
5. Любая ссылка из README или теста должна вести на существующий документ.
