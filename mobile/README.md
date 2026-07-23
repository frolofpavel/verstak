# Verstak Mobile MVP

Мобильный контур состоит из PWA (`mobile/app`), relay (`mobile/relay`) и desktop bridge (`electron/mobile-bridge`). Проекты, чаты, файлы, AI-провайдеры и выполнение остаются на компьютере.

## Быстрый локальный запуск для проверки

Откройте двойным кликом:

```text
mobile\start-local-mobile.cmd
```

Скрипт сам:

- найдёт IP компьютера в локальной сети;
- выберет свободные порты для relay и мобильной страницы;
- соберёт и запустит relay;
- запустит dev-версию desktop Verstak с mobile bridge;
- запустит мобильную PWA;
- покажет готовую ссылку для телефона.

На телефоне в той же Wi-Fi сети откройте показанную ссылку. Поля подключения уже будут заполнены, страница попробует подключиться сама. Если автоподключение не сработало, нажмите «Подключиться».

Последняя ссылка также сохраняется в `mobile/last-local-mobile-link.txt`. Это runtime-файл с временным токеном, он добавлен в `.gitignore`.

Если установленный Verstak уже открыт, dev-версия запустится с отдельным временным профилем `verstak-mobile-smoke-profile` и не тронет рабочую SQLite.

## Ручной локальный запуск

1. Соберите relay и запустите его с временным dev-токеном:

   ```powershell
   npm run mobile:relay:build
   $env:VERSTAK_MOBILE_RELAY_TOKEN='<local-dev-token>'
   npm run mobile:relay:start
   ```

2. В другом PowerShell запустите desktop Verstak с тем же relay:

   ```powershell
   $env:VERSTAK_MOBILE_RELAY_URL='http://localhost:8787'
   $env:VERSTAK_MOBILE_RELAY_TOKEN='<local-dev-token>'
   $env:VERSTAK_MOBILE_ACCOUNT_ID='local'
   $env:VERSTAK_MOBILE_DEVICE_ID='desktop'
   $env:VERSTAK_DEV_USER_DATA_DIR="$env:TEMP\verstak-mobile-smoke-profile"
   npm run dev
   ```

   `VERSTAK_DEV_USER_DATA_DIR` нужен для параллельного smoke, если установленный Verstak уже открыт. Он создаёт отдельную временную SQLite и не трогает рабочий профиль.

3. В третьем PowerShell запустите PWA:

   ```powershell
   npm run mobile:dev -- --host 0.0.0.0
   ```

4. На телефоне в одной Wi-Fi сети откройте `http://<IP-компьютера>:5173`, укажите relay URL с тем же IP, токен, `accountId=local`, `deviceId=desktop` и нажмите «Подключиться».

Для проверки через интернет relay должен быть развёрнут за HTTPS. Production-развёртывание, домен и OAuth в этот MVP не включены; токен нельзя коммитить или писать в `.env` проекта.

## Что работает

- подключение телефона к desktop через исходящее соединение;
- список зарегистрированных и не скрытых проектов;
- создание и продолжение чатов;
- отправка задачи в обычный desktop `ai:send` с текущими режимами и политиками;
- чтение истории и обновление ответа во время выполнения;
- остановка запуска на уровне протокола/desktop adapter;
- capability-based доступ к файлам без передачи абсолютных путей телефону;
- одноразовые pairing primitives и проверка attachment staging.

## Ограничения локального MVP

- PWA использует ручную dev-конфигурацию вместо production OAuth/QR UI;
- внешний relay не развёрнут;
- approvals и unified diff представлены в протоколе, но отдельные мобильные экраны будут следующим срезом после проверки базового сценария на реальном телефоне;
- компьютер и desktop Verstak должны быть включены.
