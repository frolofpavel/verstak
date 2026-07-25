# Verstak 2.2 — performance contract

Дата: 2026-07-26.

## Пользовательская цель

Verstak должен быстрее начинать ответ и оставаться плавным во время длинного
стрима. Оптимизация не меняет маршрутизацию моделей, approval policy, память или
семантику сообщений.

## Что изменено

1. `prepareParts()` запускает независимые чтения user layer, file rules и context
   pack параллельно.
2. CLI provider собирает prompt один раз и передаёт фактический payload в Debug
   Packet через безопасный callback.
3. Text/thought deltas одного send объединяются в один Zustand update на
   animation frame. `done`/`error` сначала синхронно сбрасывает хвост.
4. Вторичные экраны и правые панели загружаются при первом открытии.
5. `npm run check:performance` удерживает renderer entry в бюджете 1 600 000 байт.

## Измерение production build

| Метрика | До | После | Изменение |
|---|---:|---:|---:|
| Главный renderer JS | 1 772 517 B | 1 534 911 B | −237 606 B (−13,4%) |
| Сборок CLI prompt на запрос с Debug Packet | 2 | 1 | −50% локальной работы |
| Store updates для N text-deltas в одном кадре | N | 1 | coalesced |

Размер измерен после `npm run build` по `out/renderer/assets/index-*.js`.
Время ответа внешней модели и сети этим контрактом не подменяется.

## Проверка

```powershell
npm run type
npm run test:fast
npm run build
npm run check:performance
```

Публикация установщика и GitHub Release остаются отдельным release-gate.
