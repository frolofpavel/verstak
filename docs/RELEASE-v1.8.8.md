# Verstak 1.8.8

Дата: 2026-07-08

## Что изменилось

- Добавлен Security Regression Pack: каталог правил, markdown-реестр и отдельная команда `npm run test:security`.
- Усилен детектор опасных команд: destructive shell, credential access, shell-pipe installers, force push, RCE-паттерны и часть обфускаций.
- Добавлен smart-approval seed: LLM guard contract, XML-wrapping команды, строгий verdict parser, deterministic deny для известных опасных команд.

## Проверка

- `npm run test:security` — pass, 7 files / 24 tests.
- Targeted safety suite — pass.

## Ограничения

- Smart approval включается политикой/окружением и остаётся seed-слоем, не заменяет ручной approval для неоднозначных команд.
- Большой sandbox/container scope не входит в 1.8.8.
