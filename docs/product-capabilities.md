# Verstak — возможности (источник истины)

> Канонический список того, что Verstak реально умеет. README, CLAUDE.md и маркетинг
> сверяются с этим файлом, а не друг с другом. Обновлять здесь при добавлении фич.
> Последняя сверка: 2026-06-06.

---

## Провайдеры моделей

Verstak — мульти-провайдерный: per-chat выбор, горячее переключение, fallback при ошибке.

**API-провайдеры (свой ключ):**
- Gemini API · Claude API · Grok API · OpenAI API
- 🇷🇺 YandexGPT · GigaChat (152-ФЗ контур — приватные данные/RU-текст; не основной движок кодинга)

**CLI-провайдеры (через установленный CLI + подписку):**
- Claude Code · Gemini CLI · Grok Build · Codex CLI

**OpenAI-совместимые (extra, один паттерн):**
- OpenRouter (один ключ → все модели)
- DeepSeek (V4) · Moonshot/Kimi (K2.6) · Qwen3 — дешёвый китайский ярус
- Mistral · Groq
- **Ollama (локальный)** — бесплатно, приватно, без интернета
- Custom — любой OpenAI-совместимый endpoint (vLLM, LM Studio, корп-шлюз)

→ Корректная формулировка для README: **«15+ способов запуска (API + CLI + локальные), любой OpenAI-совместимый endpoint»**, НЕ «8 провайдеров».

## Режимы агента (5)
`ask` (подтверждение на всё) · `accept-edits` (правки авто, команды через подтверждение) · `plan` (только чтение) · `auto` (всё авто) · `bypass` (без диалогов). Переключение Shift+Tab.

## Маршрутизация моделей
- **tier-router** — по сложности задачи: рутина → дешёвый ярус, сложное → frontier, приватное → RU.
- **smart-fallback** — при 429/5xx/сети пробует следующего провайдера.
- **doctor** — health-check ключей/коннекторов/моделей одной кнопкой.

## Инструменты агента (~40)
read/write/apply_patch · run_command · search/grep/find · project_map · **read_spreadsheet / read_document / edit_spreadsheet** (Office) · generate_html/docx · render_chart · connector_query · delegate_task · diagnostics · memory · и др.

## Скиллы
Markdown-файлы с frontmatter → system prompt + tools_allow + provider. Авто-импорт из `~/.claude/skills/`, `~/.codex/skills/`, `~/.verstak/skills/`. **Скилл наслаивается ПОВЕРХ базового протокола** (system → user → context → skill), не заменяет его. Built-in пак включает agency-runbook'и: Ночная смена / Заявки / Дебиторка.

## Память (Hermes-уровень)
Core Memory (MEMORY.md + USER.md всегда в промпте) · Archival (FTS5-поиск) · Conversation search · авто-capture · handoff-генератор между сессиями.

## Коннекторы (11)
GitHub · Google Sheets · Telegram · SSH (с denylist + classifyCommand) · Битрикс24 · Я.Директ · Я.Диск · 1С OData · HTTP API · соцсети-публикация.

## MCP
Клиент JSON-RPC 2.0 over stdio. Подключение внешних MCP-серверов.

## Артефакты
generate_html / generate_docx / render_chart (SVG). Embedded preview.

## Контроль и прозрачность (главный moat)
checkpoint + per-file undo · session undo · audit-log (CSV-экспорт) · cost controller · Explicit Review (кросс-провайдерное — Grok ревьюит Claude) · secret-scanner · path-policy.

## Что НЕ умеет (честно)
- Не IDE: нет редактора кода / autocomplete / семантической индексации репо.
- RU-модели — не для агентного кодинга (слабее frontier, лимиты контекста).
- Нет облачных async-агентов на часы (это поляна Anthropic/OpenAI).
- Computer use / управление десктопом — не реализовано.
