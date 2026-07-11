# Verstak Mobile MVP

Мобильный контур состоит из PWA (`mobile/app`), relay (`mobile/relay`) и desktop bridge (`electron/mobile-bridge`). Проекты, чаты, файлы, AI-провайдеры и выполнение остаются на компьютере.

## Локальный запуск

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
   npm run dev
   ```

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
