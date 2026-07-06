# Verstak 1.8.7

Дата: 2026-07-06

## Что изменилось

- Подтянуты правки Ильи из ветки `codex/verstak-1.8.6-ui-model-fixes`.
- Восстановлены и объединены UI-правки выбора моделей, Settings и рабочего экрана.
- В ModelPicker и Settings видны состояние подключения, транспорт провайдера и подсказки agent-mode policy.
- Обновлены метаданные моделей: контекст, цена, gateway/Grok/DeepSeek/Qwen/Kimi/GLM/MiniMax-пресеты.
- Доработаны меню инструментов композера, worktree bar, восстановление окна и стили Shell Atelier.

## Проверка

- `npm run type` — pass.
- `npm run test:fast` — pass, 2102 tests / 7 skipped.

## Примечание

Это release-candidate сборка поверх `1.8.6`: цель — быстро выкатить правки UI/моделей без расширения scope.
