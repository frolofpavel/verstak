# Verstak v1.8.6

Горячее исправление поверх v1.8.5.

## Что исправлено

- Установщик Windows теперь работает с payload-файлами через Electron `original-fs`.
- Silent install / автообновление больше не воспринимает `resources/app.asar` как виртуальный asar-архив и не падает с ложной ошибкой, что файл пустой.
- Self-extract wrapper корректно передаёт `--silent --install-dir` во внутренний установщик.

## Проверка

- `npm run type`
- targeted installer tests
- `npm run test:fast`
- `npm run build`
- `npm run dist:win`
- self-extract silent install поверх существующей локальной установки
