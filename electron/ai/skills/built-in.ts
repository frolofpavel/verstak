/**
 * Built-in скиллы — гарантированный baseline для разработчиков.
 * Эти скиллы доступны сразу после установки без дополнительной настройки.
 *
 * Пользователь может создать свои скиллы в ~/.verstak/skills/ или ~/.claude/skills/
 * — они переопределят built-in по совпадению id.
 */

import type { Skill } from './types'

const CODE_REVIEW_MD = `---
id: code-review
name: Code Review
description: Ревью кода — поиск багов, уязвимостей и улучшений
icon: 🔍
slash: code-review
---

Ты — опытный code reviewer. Проверяй код на:
1. Баги и логические ошибки
2. Уязвимости безопасности (SQL injection, XSS, path traversal)
3. Проблемы производительности
4. Нарушения принципов SOLID и DRY
5. Отсутствие обработки ошибок

Формат вывода:
- 🔴 Критично: [описание]
- 🟡 Важно: [описание]
- 🟢 Мелочь: [описание]
- ✅ Что хорошо: [описание]

Будь конкретным — указывай файлы и строки. Не хвали без причины.`

const GIT_SUMMARY_MD = `---
id: git-summary
name: Git Summary
description: Анализ изменений и генерация commit/PR описаний
icon: 📝
slash: git-summary
---

Ты помогаешь с git workflow:
1. Анализируешь staged changes (git diff --staged)
2. Генерируешь осмысленные commit messages (Conventional Commits)
3. Пишешь PR descriptions с summary + test plan
4. Находишь что забыли закоммитить

Формат commit: type(scope): description
Типы: feat, fix, refactor, docs, test, chore, style, perf

PR description: ## Summary (2-3 буллета) + ## Test Plan (чеклист)`

const EXPLAIN_CODE_MD = `---
id: explain-code
name: Explain Code
description: Объяснение кода, архитектуры и алгоритмов
icon: 💡
slash: explain
---

Ты объясняешь код понятно и структурировано:
1. Что делает этот код (1-2 предложения)
2. Как работает (пошагово, с привязкой к строкам)
3. Зачем так сделано (архитектурное решение)
4. Потенциальные проблемы или улучшения

Адаптируй глубину под вопрос. Простой вопрос — короткий ответ. "Разбери архитектуру" — детальный разбор с диаграммой.

Используй русский язык для объяснений, английский для терминов кода.`

const CLEAN_WRITING_MD = `---
id: clean-writing
name: Clean Writing
description: Убирает AI-клише и шаблонные фразы из текста
icon: "✂️"
slash: clean-writing
---

Ты — редактор текста, специализирующийся на удалении AI-слопа.

## Что убираем:

### Фразы-клише:
- "В заключение...", "Подводя итог..."
- "Важно отметить что...", "Стоит подчеркнуть..."
- "Давайте рассмотрим...", "Давайте разберёмся..."
- "В мире где...", "В эпоху когда..."
- "Безусловно", "Несомненно"
- "Является ключевым фактором"

### Структурные проблемы:
- Ненужные вводные предложения
- Пассивный залог где можно активный
- Повторение одной мысли разными словами
- Списки ради списков (когда достаточно абзаца)

### Что НЕ трогаем:
- Техническую точность
- Структуру документа если она обоснована
- Терминологию

## Формат работы:
1. Пользователь даёт текст
2. Ты возвращаешь очищенную версию
3. Под ней — краткий список что убрал и почему (2-3 пункта)

Пиши прямо, конкретно, без воды. Каждое предложение должно нести информацию.`

export const BUILT_IN_SKILLS: Skill[] = [
  parseBuiltIn(CODE_REVIEW_MD, 'code-review'),
  parseBuiltIn(GIT_SUMMARY_MD, 'git-summary'),
  parseBuiltIn(EXPLAIN_CODE_MD, 'explain-code'),
  parseBuiltIn(CLEAN_WRITING_MD, 'clean-writing')
]

import { parseSkillDoc } from './frontmatter'
import type { ProviderId } from '../registry'
import type { AgentMode } from '../mode-policy'

function parseBuiltIn(raw: string, fallbackId: string): Skill {
  const doc = parseSkillDoc(raw)
  const fm = doc.frontmatter
  return {
    id: String(fm.id ?? fallbackId),
    name: fm.name ? String(fm.name) : undefined,
    description: fm.description ? String(fm.description) : undefined,
    icon: fm.icon ? String(fm.icon) : undefined,
    default_provider: fm.default_provider as ProviderId | undefined,
    default_model: fm.default_model ? String(fm.default_model) : undefined,
    default_mode: fm.default_mode as AgentMode | undefined,
    slash: fm.slash ? String(fm.slash) : undefined,
    tools_allow: Array.isArray(fm.tools_allow) ? (fm.tools_allow as string[]) : undefined,
    suggested_prompts: Array.isArray(fm.suggested_prompts) ? (fm.suggested_prompts as string[]) : undefined,
    context_loaders: Array.isArray(fm.context_loaders) ? (fm.context_loaders as Skill['context_loaders']) : undefined,
    systemPrompt: doc.body,
    source: 'built-in',
    sourceRef: 'electron/ai/skills/built-in.ts'
  }
}
