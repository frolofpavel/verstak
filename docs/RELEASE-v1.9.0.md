# Verstak 1.9.0

Дата: 2026-07-08

## Что изменилось

- Agent run теперь не может висеть бесконечно: добавлен timeout policy, статус `timed_out`, корректный abort и единая синхронизация с `ai:wait`, timeline и Telegram notify.
- Планировщик стал наблюдаемым: heartbeat каждые 60 секунд, UI показывает возраст heartbeat и stalled-состояние, задачи claim-ятся по минутному слоту до выполнения.
- Scheduled tasks fail-closed для lifecycle-команд: запросы остановить/перезапустить Verstak, scheduler или машину отклоняются до запуска.
- Память run замораживается на старте: core/recall snapshot стабилен для API/CLI веток, а в логах остаются только counts/fingerprint без содержимого.
- Proof Delivery усилен: ручные PDF/Telegram proof-действия сохранены, длинные успешные прогоны могут opt-in отправлять Proof report в Telegram.
- Зафиксирован threat model для inbound mutations: внешние входящие команды не получают тихий write/run/control канал без локального approval.

## Проверка

- Targeted 1.9 suite — pass, 5 files / 36 tests.
- `npm run type` — pass.
- `npm run test:fast` — pass, 281 files passed / 1 skipped, 2252 tests passed / 7 skipped.
- `npm run build` — pass.
- `npm run dist:win` — pass.
- Артефакты: `Verstak-Setup-1.9.0-x64.exe` 360,365,761 B; `Verstak-Portable-1.9.0-x64.exe` 209,570,588 B; `latest.yml` version 1.9.0, sha512/size verified.

## Ограничения

- Полный remote control / inbound mutation bridge не включён в 1.9.0.
- Cron heartbeat закрывает liveness и at-most-once claim, но отдельный daemon/multi-channel gateway остаётся дальнейшей задачей.
- Proof auto-send выключен по умолчанию и требует явных Telegram settings.
