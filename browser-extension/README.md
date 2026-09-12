# Verstak — расширение Chrome (v0.2.0 Connected Eyes + Approved Click)

Расширение — **глаза и первичное действие Verstak**: по прозрачному каналу Native Messaging передаёт проверенный snapshot видимого текста и исполняет предварительно одобренные пользователем действия (click) с контролем `observationVersion`.

> Поддерживаемые задачи: `VSK-EXT-B1` / `VSK-EXT-C1` — Native Messaging Protocol v1.

---

## Архитектура подключения (Connected Eyes v0.2.0)

1. **Native Messaging Host** (`ru.verstak.browser_bridge`):
   - Прямой двухсторонний канал (stdin/stdout JSON lines) между Chrome ServiceWorker и десктопом Verstak.
   - Никаких серверов на публичных портах, никаких вещаний в локальную сеть.
2. **Pairing**:
   - Одноразовый 8-символьный код pairing с десктопа (генерация по нажатию «Подключить браузер»).
   - Успешный pair сохраняет нескрываемый persistent token в `chrome.storage.local`.
3. **Attach / Detach**:
   - Прикрепление только к конкретной активной вкладке по желанию пользователя.
   - Запрашивается ограниченный `host_permission` только для домена прикреплённой вкладки (`https://domain.com/*`).
4. **Observe (R0)**:
   - Автоматический запрос снимка от десктопного run (`observe_request`).
   - Собирает безопасный структурированный snapshot (`extractor.mjs`) с версионированием `observationVersion`.
5. **Approved Click (C1)**:
   - Выполнение клика (`click_request`) **только** по opaque `elementRef` и с подлинным `observationVersion`.
   - Защита от stale/cross-tab кликов (`lastObsByTab` проверка версии и origin).

---

## Единый Privacy-фильтр (Privacy-first)

Единый privacy-фильтр отсекает целиком поддеревья, у которых хотя бы один предок (включая корневой `body`) помечен как приватный:

- `<script>`, `<style>`, `<noscript>`, `<template>`;
- `<form>` и всё, что внутри формы, включая `<input>`, `<textarea>`, `<select>`, `<option>`, `<button>` (значения форм отсекаются в R0/C1);
- `contenteditable` в любых значениях;
- `hidden` (булевый атрибут);
- `aria-hidden="true"`;
- inline и computed `display:none`, `visibility:hidden`, `content-visibility:hidden`.

Никакие пароли, куки, токены авторизации или закрытые поля ввода **никогда не читаются и не передаются в лог**.

---

## Установка и привязка (Unpacked)

1. Откройте `chrome://extensions`.
2. Включите **Developer mode**.
3. Нажмите **Load unpacked**.
4. Выберите папку **`browser-extension`**.
5. Запустите Verstak, откройте боковую панель расширения, нажмите **Pair с Verstak** (введите код из десктопа).
6. Перейдите на целевую вкладку и нажмите **Attach вкладку**.
