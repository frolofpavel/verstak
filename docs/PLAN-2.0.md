# Verstak — план до 2.0.5

> Заземлён на аудит 11.07.2026 (discovery-воркфлоу, 96 агентов, 86 находок → **70 подтверждено** адверсариально, 16 отклонено). Планка: быть сильнее OpenClaw/Hermes, не хуже Cursor/Codex/китайских агентов по надёжности агентного цикла. Каждый срез — TDD → `npm run type` 0 → задетые тесты зелёные → коммит → push. Никаких фейковых заглушек.

## 2.0.0 — Security Hardening (13 находок)
Приоритет №1 — доверие/безопасность (позиционирование Verstak).
- **[HIGH] telegram send_document — path-guard.** `document_path` читает ЛЮБОЙ локальный файл и выгружает в Telegram → эксфильтрация `.env`/`.ssh`/creds мимо path-policy. Fix: `safeRealJoin(projectPath)` + `isForbiddenPath` + отказ без проекта (как yandex_disk).
- **[HIGH] core_memory_append/replace — scanText.** Пишут агентский content в MEMORY.md/USER.md без редакции, а core-memory инжектится в system prompt КАЖДЫЙ turn → секрет утекает во все будущие сессии. Fix: `scanText().redacted` в `saveCoreMemoryBlock`.
- **[MED] connector_query — маркер недоверенного контента.** Вывод коннекторов идёт в контекст без untrusted-маркера (асимметрия с web_fetch) → prompt-injection через данные. Fix: обрамить `CONNECTOR_UNTRUSTED_HEADER` + scanText.
- **[MED] 1C OData SSRF.** `onec.ts` — raw fetch с default-redirect без ip-guard. Fix: паттерн http.ts (manual redirect + isBlockedHost + срез Authorization при смене хоста).
- **[MED] telegram fail-open.** Пустой whitelist → отправка в ЛЮБОЙ chat_id. Fix: fail-closed.
- **[MED] skills override.** Server-скиллы перебивают built-in по id без https/подписи. Fix: форсить https + запрет override reserved built-in id / неймспейс.
- **[MED] webview guard.** webviewTag без will-attach-webview. Fix: `web-contents-created` → форсить nodeIntegration=false/contextIsolation=true, снять preload.
- **[LOW] ×5:** run_command redact в UI, save_decision scanText, subagent system-layer, web-policy egress-redact, web_fetch IP-pin (DNS-rebinding).

## 2.0.1 — Bug Sweep (25 находок)
- **[MED]** compact-history turn-counter mismatch · loop-детектор ложно срабатывает на идемпотентных read/verify · plain-path без withInitialRetry/smart-fallback · project-purge не чистит scheduled_tasks/reminders (вечный cron осиротевшего проекта) · Bitrix/Ozon пагинация (молча неверные цифры) · gsheets append без заголовков (потеря данных) · newChatSession протекает previewArtifactId/openedReviewId · фоновый стрим свёрнутого проекта портит активный чат · SideChat отправка до сидирования истории.
- **[LOW] ×14:** connector-фиксы (token-cache по client_id, res.ok, URL-encode, редиректы), store (рост карт lane/sendOwners, stale-замыкания help), reminders-дубли, fork теряет applied_skills.

## 2.0.2 — Dead Code Purge (24 находки)
Явное разрешение Павла «почисти мёртвый код». Удалить неиспользуемые экспорты (autoupdate/ paths+payload, installer/ paths, model-registry, proof-frames, subscription-accounts, agent-model-policy) + внутренние сделать не-export (hashLine, isMutatingTool, defaultDownloadsDir, ensureRemindersSchema, native-modules) + мёртвые компоненты (OnboardingWizard, TierRecommendation, ReviewButton, StubView) + мёртвые lib-константы. Каждое удаление гейтится type+test.

## 2.0.3 — Reliability Parity (competitive: не хуже Cursor/Codex/китайцев)
- **plain-path retry/fallback** (пересекается с bug) — CLI/one-shot путь получает withInitialRetry + smart-fallback на транзиентах.
- **apply_patch fuzzy fallback** — индент-агностичный матч при промахе exact (меньше лишних ходов агента).
- **recall RU-морфология** — префиксные термы/snowball в FTS (парафраз и падежи матчатся) без эмбеддингов.
- **loop-детектор** — затухание + исключение идемпотентных read/verify.

## 2.0.4 — Debate + автономность (сильнее OpenClaw/Hermes)
- **Итеративный adversarial debate** поверх swarm (тезис↔критика↔синтез, max_rounds/cost-cap) — closes 1.9.9 hero-гэп.
- **CLI Control Envelope → checkpoint**: post-run git-diff наполняет per-file undo/checkpoint для CLI (откат из UI работает и для CLI-провайдеров) — часть Mode C, НЕ требующая live-claude.

## 2.0.5 — Polish + re-review
- Оставшиеся medium/low, финальное адверсариальное ре-ревью изменений, docs-truth (CLAUDE.md §2/§5), CHANGELOG.

## Заблокировано на Павле (честно, НЕ паяю вслепую)
- **Mode C session-continuity (`--resume`/session-id)** — нужен залогиненный claude для верификации.
- **Unattended-execution с write в worktree** — продуктовое решение (против «контроль»-позиционирования), нужен явный opt-in Павла.
- **Семантический embedding-индекс** — против стратегии «без векторов» (осознанно не берём).

_Источник находок: `discovery wf_611cdad2` (11.07). Обновляется по мере реализации._
