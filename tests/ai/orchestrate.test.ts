import { describe, it, expect, vi } from 'vitest'
import { parseDecomposition, decomposeGoal, dedupeTaskIds } from '../../electron/ipc/tool-handlers'
import { estimateComplexity, recommendModel } from '../../electron/ai/smart-router'
import { createCostGuard } from '../../electron/ai/cost-guard'
import type { ToolContext } from '../../electron/ipc/tool-handlers'

// Partial mock registry: подменяем ТОЛЬКО createProvider (его динамически
// импортит decomposeGoal), сохраняя PROVIDERS и прочее для smart-router тестов.
vi.mock('../../electron/ai/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/ai/registry')>()
  return {
    ...actual,
    createProvider: () => ({
      async *send() {
        yield { type: 'text', text: '[{"id":"a","prompt":"p","role":"executor"}]' }
        yield { type: 'usage', usage: { inputTokens: 500_000, outputTokens: 100_000 } }
        yield { type: 'done' }
      }
    })
  }
})

// Фаза 3, Идея 5 — Smart Orchestrator: декомпозиция цели на подзадачи + умный
// выбор модели на каждую. Тестируем чистые части (parseDecomposition + smart-router),
// сетевой вызов модели не трогаем.

describe('parseDecomposition — разбор ответа планировщика', () => {
  it('парсит чистый JSON-массив подзадач с ролями', () => {
    const text = '[{"id":"a","prompt":"найти конфиг","role":"researcher"},{"id":"b","prompt":"починить баг","role":"executor"}]'
    const tasks = parseDecomposition(text, 'goal', 5)
    expect(tasks).toHaveLength(2)
    expect(tasks[0]).toEqual({ id: 'a', prompt: 'найти конфиг', role: 'researcher' })
    expect(tasks[1].role).toBe('executor')
  })

  it('вырезает JSON из обёртки (```json + болтовня модели)', () => {
    const text = 'Вот декомпозиция:\n```json\n[{"id":"x","prompt":"проверить типы","role":"verifier"}]\n```\nГотово.'
    const tasks = parseDecomposition(text, 'goal', 5)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].role).toBe('verifier')
  })

  it('невалидную роль заменяет на executor', () => {
    const tasks = parseDecomposition('[{"prompt":"сделать","role":"hacker"}]', 'goal', 5)
    expect(tasks[0].role).toBe('executor')
  })

  it('режет до max_subtasks', () => {
    const arr = Array.from({ length: 10 }, (_, i) => `{"id":"t${i}","prompt":"p${i}","role":"executor"}`)
    const tasks = parseDecomposition(`[${arr.join(',')}]`, 'goal', 3)
    expect(tasks).toHaveLength(3)
  })

  it('пропускает пункты без prompt', () => {
    const tasks = parseDecomposition('[{"id":"a","role":"executor"},{"prompt":"ok","role":"executor"}]', 'goal', 5)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].prompt).toBe('ok')
  })

  it('фоллбэк при невалидном JSON: одна executor-подзадача = вся цель', () => {
    const tasks = parseDecomposition('модель ответила прозой без json', 'почини сборку', 5)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toEqual({ id: 'task-1', prompt: 'почини сборку', role: 'executor' })
  })

  it('фоллбэк при пустом массиве', () => {
    const tasks = parseDecomposition('[]', 'цель', 5)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].role).toBe('executor')
  })
})

describe('dedupeTaskIds — уникальные subCallId для карточек субагентов (регресс)', () => {
  it('дублирующиеся id различаются суффиксом #N', () => {
    const items = [{ id: 'a' }, { id: 'a' }, { id: 'a' }, { id: 'b' }]
    dedupeTaskIds(items)
    expect(items.map(i => i.id)).toEqual(['a', 'a#2', 'a#3', 'b'])
  })

  it('пустой/пробельный id заменяется на prefix-N', () => {
    const items = [{ id: '' }, { id: '   ' }, { id: 'x' }]
    dedupeTaskIds(items)
    expect(items.map(i => i.id)).toEqual(['task-1', 'task-2', 'x'])
  })

  it('кастомный prefix для роя', () => {
    const items = [{ id: '' }, { id: '' }]
    dedupeTaskIds(items, 'member')
    expect(items.map(i => i.id)).toEqual(['member-1', 'member-2'])
  })

  it('уже уникальные id не трогаются', () => {
    const items = [{ id: 'scout' }, { id: 'solver-1' }, { id: 'critic' }]
    dedupeTaskIds(items)
    expect(items.map(i => i.id)).toEqual(['scout', 'solver-1', 'critic'])
  })
})

describe('decomposeGoal — токены планировщика учитываются в cost guard (регресс)', () => {
  it('usage-событие планировщика инкрементирует session cost guard', async () => {
    const guard = createCostGuard(20)  // активный cap
    const ctx = { subCostGuard: guard, projectPath: '/tmp', getSecretForDelegate: () => null } as unknown as ToolContext
    const ac = new AbortController()
    // claude-sonnet-4-6: 500K in ($1.5) + 100K out ($1.5) = $3 → 300¢
    const tasks = await decomposeGoal('цель', 5, 'claude', 'key', 'claude-sonnet-4-6', ctx, ac.signal)
    expect(tasks).toHaveLength(1)
    // Раньше usage отбрасывался → current() оставался 0. Теперь растёт.
    expect(guard.current()).toBe(300)
  })
})

describe('smart-router per-subtask — выбор модели по сложности подзадачи', () => {
  it('простую короткую подзадачу → дешёвая модель (gemini-3-flash)', () => {
    const complexity = estimateComplexity([{ role: 'user', content: 'list files' }], [])
    expect(complexity).toBe('simple')
    expect(recommendModel('gemini-api', complexity)).toBe('gemini-3-flash')
  })

  it('сложную подзадачу (несколько сигналов) → мощная модель (gemini-3-pro)', () => {
    const complexity = estimateComplexity([{ role: 'user', content: 'refactor and rewrite the build system and migrate config' }], [])
    expect(complexity).toBe('complex')
    expect(recommendModel('gemini-api', complexity)).toBe('gemini-3-pro')
  })

  it('moderate подзадача → сбалансированная модель (gemini-3.5-flash)', () => {
    const complexity = estimateComplexity([{ role: 'user', content: 'implement a small helper function for date parsing' }], [])
    expect(complexity).toBe('moderate')
    expect(recommendModel('gemini-api', complexity)).toBe('gemini-3.5-flash')
  })

  // toolHistory в ai.ts передаётся как [] — сложность должна учитывать реальную
  // активность из toolCalls в истории сообщений (короткий промпт, но >5 вызовов).
  it('много tool-вызовов в истории → complex даже при коротком промпте', () => {
    const messages = [
      { role: 'user' as const, content: 'go on' },
      { role: 'assistant' as const, content: '', toolCalls: Array.from({ length: 6 }, (_v, i) => ({ id: 't' + i, name: 'read_file', args: {} })) },
    ]
    expect(estimateComplexity(messages, [])).toBe('complex')
  })

  it('другой провайдер (claude): простая → haiku, сложная → opus', () => {
    expect(recommendModel('claude', 'simple')).toBe('claude-haiku-4-5')
    expect(recommendModel('claude', 'complex')).toBe('claude-opus-4-5')
  })

  it('verstak-gateway routes recipe-agent subtasks to the Stage 12 coding default', () => {
    expect(recommendModel('verstak-gateway', 'simple')).toBe('kimi-k2.7-code')
    expect(recommendModel('verstak-gateway', 'complex')).toBe('kimi-k2.7-code')
  })

  it('неизвестный провайдер → null (фоллбэк на defaultModel в оркестраторе)', () => {
    expect(recommendModel('unknown-provider', 'complex')).toBeNull()
  })
})
