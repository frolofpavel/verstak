# CURRENT_STATE.md — честный снимок состояния Verstak

> Единый источник правды: что реально готово, что урезано, что не сделано.
> Обновлять при значимых изменениях. Последняя сверка: 2026-06-17 (релиз 1.5.7).

Цель файла — не дать «эффекту завершённости»: roadmap может показывать ✅, а
ценность на пользователе не материализоваться. Здесь — без приукрашивания.

---

## Что реально работает (shipped)

**Провайдеры (18):** база — Gemini API/CLI, Claude API/Code, Grok API/CLI, OpenAI
API, Codex CLI, GigaChat, YandexGPT; + 8 OpenAI-совместимых. Per-chat выбор,
горячее переключение, smart-fallback на 429/5xx (с правкой: fallback теперь
сохраняет capability-фильтр и verification).

**Коннекторы (31, read-only):** база (1С/HTTP/Sheets/SSH/Telegram/Битрикс24
read-only/Я.Директ/Я.Диск/GitHub/Social) + RU-стек (DaData/Контур/Метрика/GA4/
Ozon/WB/MPSTATS/Avito/amoCRM/МойСклад/ЮКасса/SendPulse/UniSender/VK/Jira/Trello/
Notion). 30-сек таймаут на каждом, scanText на выводе.

**Агентный цикл (API-путь):** 20+ tools, мульти-агент (delegate/orchestrate/
swarm), agent_runs с live-tick, crash-resume (НЕ авто-доигрывает деструктив),
verification artifact (DoD по exit-кодам), 5 режимов, per-file undo, checkpoint,
context sliding window, exponential backoff, loop-detection.

**Dev Task Flow:** task → branch (setBranch пишет work_branch) → diff → checks →
commit (**DoD-гейт: блок при красных проверках, обход только overrideReason →
audit**) → PR (github). Покрыт интеграционными тестами.

**Ревью → План (F8):** Explicit Review (другой провайдер) → находки → кнопка
«В план» (persist как План со статусом/прогоном/верификацией).

**Workflow-каталог (4):** marketing-audit + RU-пак (Директ+Метрика / Битрикс
зависшие сделки / 1С↔Sheets). Рецепты-инструкции, агент дёргает connector_query.

**Proof Pack (V1):** 🔏 в карточке прогона → proof.json + proof.html (изменённые
файлы, DoD-бейдж, стоимость, таймлайн, решения), embedded-preview.

**Безопасность:** см. `SECURITY_MODEL.md` (10 слоёв). Capability-матрица — см.
`PROVIDER_CAPABILITIES.md`. 951 тест, type чист.

---

## Что урезано (честные лимиты)

- **CLI-провайдеры** (Claude Code/Codex/Gemini CLI/Grok Build): инструменты,
  verification, live-timeline, crash-guard работают ВНУТРИ бинаря — Verstak их
  не видит. Помечено «урезанный контроль» в model-picker. Полный контроль — API.
- **RU-модели** (GigaChat/YandexGPT) — для приватности/152-ФЗ и простых правок,
  НЕ как основной coding-движок (контекст/reasoning слабее frontier). Маркетинг
  обязан быть честным.
- **GigaChat TLS** по умолчанию без проверки CA (Sber CA не в trust store);
  opt-in через `gigachat_tls_verify`. Бандл Russian Trusted Root CA — TODO.
- **Generic HTTP SSRF**: блокирует 3 metadata-IP, нет loopback/private (риск
  низкий, ограничено allow-list).
- **CLI headless** (`scripts/verstak-cli.mjs`): без yandexgpt/gigachat (GUI-only),
  bounded doctor/status/models есть.

---

## Что НЕ сделано (бэклог, по убыванию рычага)

- **Proof Pack V1.2+** — PDF-экспорт, авто-proof в конце прогона (по настройке),
  generate_proof_pack как tool.
- **Mandatory DoD mode** — ГОТОВ: гейт (настройка `dod_mode`: off/warn/block,
  дефолт warn; block запрещает обход) + UI-тумблер (Настройки → «Что разрешено»).
  TODO: per-project область вместо глобальной.
- **Tier-router цены** — авто-маршрут дешёвый/frontier/RU по сложности (есть
  recommendTier-инфра, нет авто).
- **Tasks 2.0** — полный 3→1 редизайн экранов задач (F15 сделал срез имён).
- **Worktree task mode** / scheduled (cron) агенты / Run Playback (VCR).
- **First Win 2.0** (гайд-онбординг), collaborative .verstak/tasks.json,
  mock parity harness, RU-платежи (ЮKassa).

---

## Стратегический контекст (из рыночного штурма 17.06)

Позиционирование: «Control-first агент, который ДОКАЗЫВАЕТ результат» (не
«русский Cursor»). TAM: RU-агентства (услуга), не соло-девы. Герой: Proof Pack.
**Условие штурма: провалидировать направление с 2-3 агентствами ПЕРЕД
углублением** — это бизнес-ход Павла, не код.

Связано: `SECURITY_MODEL.md`, `PROVIDER_CAPABILITIES.md`, `COMPETITIVE_ROADMAP.md`.
