# Verstak Mobile Remote Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Реализовать локально проверяемый MVP мобильного доступа, где PWA управляет чатами и файлами через relay, а задачи выполняются настольным Verstak.

**Architecture:** Отдельный workspace `mobile/` содержит общий протокол, relay и PWA. Desktop bridge в `electron/mobile-bridge/` устанавливает только исходящее соединение и адаптирует белый список мобильных команд к существующим сервисам Verstak; desktop SQLite остаётся источником истины.

**Tech Stack:** TypeScript, React 19, Vite, Node HTTP/WebSocket, Vitest, Electron safeStorage.

## Global Constraints

- Экран компьютера не транслируется.
- Файлы, терминал, AI-провайдеры, секреты и SQLite остаются на desktop.
- Телефон видит только зарегистрированные проекты и явно разрешённые корни.
- Внешнее production-развёртывание не выполняется.
- Старые IPC-контракты не изменяются.
- Любой путь проверяется через capability `rootId` и desktop path policy.
- Повторная доставка `chat.send` не создаёт второй запуск.

---

### Task 1: Общий протокол и валидация

**Files:**
- Create: `mobile/shared/protocol.ts`
- Test: `tests/mobile/protocol.test.ts`

**Interfaces:**
- Produces: `MobileEnvelope`, `MobileCommand`, `MobileEvent`, `parseEnvelope(value): MobileEnvelope`.

- [ ] Написать падающие тесты на версию, обязательные поля, неизвестную команду и корректный envelope.
- [ ] Запустить `npx vitest run tests/mobile/protocol.test.ts`; ожидать FAIL из-за отсутствующего модуля.
- [ ] Реализовать discriminated unions команд/событий и строгий runtime parser без `any`.
- [ ] Повторить тест; ожидать PASS.
- [ ] Зафиксировать task отдельным коммитом.

### Task 2: Relay transport

**Files:**
- Create: `mobile/relay/server.ts`
- Create: `mobile/relay/router.ts`
- Create: `mobile/relay/auth.ts`
- Test: `tests/mobile/relay-router.test.ts`

**Interfaces:**
- Consumes: `MobileEnvelope`, `parseEnvelope`.
- Produces: `createRelayRouter()`, `registerConnection(identity, send)`, `route(envelope)`.

- [ ] Написать тесты: маршрутизация только совпадающему `accountId/deviceId`, offline error, replay id rejection и отсутствие payload в audit metadata.
- [ ] Запустить тест и подтвердить FAIL.
- [ ] Реализовать in-memory connection registry, bounded replay cache и HTTP health endpoint; transport не хранит prompts/files/tool results.
- [ ] Запустить тест; ожидать PASS.
- [ ] Зафиксировать task отдельным коммитом.

### Task 3: Desktop capability roots

**Files:**
- Create: `electron/mobile-bridge/roots.ts`
- Test: `tests/mobile/desktop-roots.test.ts`

**Interfaces:**
- Produces: `createRootCapabilities(projects)`, `resolveRootPath(rootId, relativePath)`.

- [ ] Написать тесты на стабильный opaque `rootId`, traversal, forbidden path и отсутствующий root.
- [ ] Запустить тест и подтвердить FAIL.
- [ ] Реализовать map rootId -> canonical root и разрешение относительного пути через существующие политики.
- [ ] Запустить тест; ожидать PASS.
- [ ] Зафиксировать task отдельным коммитом.

### Task 4: Desktop bridge session и idempotency

**Files:**
- Create: `electron/mobile-bridge/idempotency.ts`
- Create: `electron/mobile-bridge/session.ts`
- Create: `electron/mobile-bridge/types.ts`
- Test: `tests/mobile/desktop-session.test.ts`

**Interfaces:**
- Consumes: relay envelopes и root capabilities.
- Produces: `MobileBridgeSession.handle(envelope)`, `MobileBridgeSession.publish(event)`.

- [ ] Написать тесты на повторный `chat.send`, offline reconnect, unknown command и запрет replay approval.
- [ ] Запустить тест и подтвердить FAIL.
- [ ] Реализовать bounded TTL-cache результатов и белый список handler-ов.
- [ ] Запустить тест; ожидать PASS.
- [ ] Зафиксировать task отдельным коммитом.

### Task 5: Адаптер chats/files/runs

**Files:**
- Create: `electron/mobile-bridge/handlers.ts`
- Create: `electron/mobile-bridge/adapter.ts`
- Modify: `electron/main.ts`
- Test: `tests/mobile/desktop-adapter.test.ts`

**Interfaces:**
- Consumes: существующие `Projects`, `ChatSessions`, `Chats`, AI send/abort facade.
- Produces: handlers для `roots.list`, `files.list`, `chats.list`, `chat.create`, `chat.history`, `chat.send`, `run.stop`, `approval.resolve`, `changes.list`.

- [ ] Написать integration-style тесты на вызовы существующих сервисов и отсутствие raw path в публичном ответе.
- [ ] Запустить тест и подтвердить FAIL.
- [ ] Реализовать узкий adapter; не вызывать IPC из main и не менять renderer contracts.
- [ ] Подключить bridge lifecycle в `electron/main.ts` за выключенным по умолчанию feature flag.
- [ ] Запустить тест и `npm run type`; ожидать PASS.
- [ ] Зафиксировать task отдельным коммитом.

### Task 6: PWA shell и навигация

**Files:**
- Create: `mobile/app/index.html`
- Create: `mobile/app/src/main.tsx`
- Create: `mobile/app/src/App.tsx`
- Create: `mobile/app/src/mobile.css`
- Create: `mobile/app/public/manifest.webmanifest`
- Create: `mobile/app/vite.config.ts`
- Test: `tests/mobile/mobile-state.test.ts`

**Interfaces:**
- Produces: device -> root -> chat state machine и mobile client facade.

- [ ] Написать pure-state тест переходов и offline draft.
- [ ] Запустить тест и подтвердить FAIL.
- [ ] Реализовать mobile-first screens и installable manifest без desktop imports.
- [ ] Запустить тест и отдельный mobile build; ожидать PASS.
- [ ] Зафиксировать task отдельным коммитом.

### Task 7: Чат, stream, approvals и changes

**Files:**
- Create: `mobile/app/src/client.ts`
- Create: `mobile/app/src/screens/ChatScreen.tsx`
- Create: `mobile/app/src/components/ApprovalCard.tsx`
- Create: `mobile/app/src/components/ChangesView.tsx`
- Test: `tests/mobile/mobile-client.test.ts`

**Interfaces:**
- Consumes: versioned relay protocol.
- Produces: reconnecting client, chat send/stop, approval resolution и read-only unified diff.

- [ ] Написать тесты на reconnect snapshot, duplicate event suppression, stop и approval commands.
- [ ] Запустить тест и подтвердить FAIL.
- [ ] Реализовать exponential reconnect с jitter и domain command methods.
- [ ] Реализовать chat/approval/changes UI; диктовку оставить browser capability с текстовым fallback.
- [ ] Запустить тест, mobile build и `npm run type`; ожидать PASS.
- [ ] Зафиксировать task отдельным коммитом.

### Task 8: Pairing и attachment staging

**Files:**
- Create: `mobile/relay/pairing.ts`
- Create: `electron/mobile-bridge/pairing.ts`
- Create: `electron/mobile-bridge/attachments.ts`
- Test: `tests/mobile/pairing-attachments.test.ts`

**Interfaces:**
- Produces: одноразовый pairing TTL 10 минут, revocable device credential, staged attachment validator.

- [ ] Написать тесты на expiry, replay, revoke, traversal, forbidden extension/path и size limit.
- [ ] Запустить тест и подтвердить FAIL.
- [ ] Реализовать pairing state machine и attachment staging без логирования содержимого.
- [ ] Запустить тест; ожидать PASS.
- [ ] Зафиксировать task отдельным коммитом.

### Task 9: Сквозная проверка и документация запуска

**Files:**
- Create: `mobile/README.md`
- Create: `tests/mobile/e2e-flow.test.ts`

**Interfaces:**
- Consumes: relay, bridge и PWA client.
- Produces: воспроизводимый локальный smoke device -> root -> chat -> send -> event -> stop.

- [ ] Написать e2e-flow с in-memory transport и fake desktop adapter.
- [ ] Запустить тест и подтвердить, что он ловит разрыв одного звена.
- [ ] Добавить точные локальные команды запуска relay/PWA/desktop feature flag и ограничения production.
- [ ] Запустить `npm run type`, `npm run test:fast` и mobile build.
- [ ] Просмотреть `git diff --check` и убедиться, что пользовательские изменения `CHANGELOG.md`/`package.json` не перезаписаны.
- [ ] Зафиксировать итог реализации отдельным коммитом.
