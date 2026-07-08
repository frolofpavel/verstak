# Verstak 1.9.1

Дата: 2026-07-08

## Что исправлено

- Закрыта утечка секретов в background process output: если ключ приходил двумя stdout/stderr chunks, Verstak теперь редактирует накопленный raw tail целиком, а не каждый chunk отдельно.
- В production включён sweeper реестра фоновых процессов; при выходе приложения он останавливается корректно.
- Осиротевшие `notifyOnExit` completion'ы завершённых процессов чистятся вместе с удаляемыми handles.
- Windows anti-orphan smoke стал устойчивее и не зависит только от медленного `tasklist`.
- Нестабильные Vitest timeout'ы на Windows снижены: добавлен глобальный `testTimeout` / `hookTimeout`, native-module тест больше не трогает несуществующий диск `Z:\`.

## Проверка

- Targeted audit-fix suite — pass, 3 files / 34 tests.
- Previously failing timeout set — pass, 8 files / 56 tests.
- `npm run type` — pass.
- `npm run test:fast` — pass, 281 files passed / 1 skipped, 2254 tests passed / 7 skipped.
- `npm run dist:win` — pass.
- Артефакты: `Verstak-Setup-1.9.1-x64.exe` 360,365,106 B; `Verstak-Portable-1.9.1-x64.exe` 209,567,882 B; `latest.yml` version 1.9.1, sha512/size verified.

## Ограничения

- `agi-iri.ru/verstak` пока требует отдельного серверного доступа для обновления fallback-ссылки.
- Smart-approval остаётся seed/inactive до отдельного product-включения.
