# STATUS — Verstak

Обновлено: 2026-07-25.

## Текущее состояние

- Версия приложения в исходниках: `2.0.12`.
- Основная ветка: `main`; до текущей уборки синхронизирована с `origin/main`.
- Последний опубликованный тег: `v2.0.12`.
- 2.1.2 Durable Agent Control Plane закрыт, включая модульный runtime делегирования.
- 2.1.3 управление подписками, аккаунтами, fallback lineage и расходом находится
  в `main`.
- 2.1.4 Model Gym закрыт: 30 детерминированных fixture-задач, role policy,
  адаптеры Verstak/Codex/OpenCode, воспроизводимый Arena-отчёт и release gate.
- PerChatState: срезы 4.1–4.3 завершены; активный остаток 4.4 описан в
  `docs/PERCHATSTATE-PLAN-2026-07-25.md`.

## Отдельная линия

Browser Employee / Connected Eyes развивается отдельно в worktree
`verstak-extension` на ветке `codex/browser-extension-readonly-mvp`. Не смешивать
с `main` до живой приёмки расширения.

## Источники истины

- Возможности и установка: `README.md`.
- История изменений: `CHANGELOG.md`.
- Текущая документация: `docs/README.md`.
- Активный код и тесты важнее этого снимка.

## Следующий продуктовый шаг

Следующий продуктовый пакет — 2.1.5 Outcome Mode GA. Новый релиз готовить только
после зелёного type/test/build gate.
