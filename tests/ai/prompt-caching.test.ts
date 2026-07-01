import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { composeSystemPrompt, CACHE_BREAKPOINT, stripCacheBreakpoint, systemForProvider } from '../../electron/ai/compose-prompt'
import { prepareSystemContext } from '../../electron/ai/compose-system'
import { createCompactedHistory } from '../../electron/ai/compact-history'
import type { ChatMessage } from '../../electron/ai/types'

const PACK = '<context_pack generated="auto">git status: clean · recent: a.ts</context_pack>'
const SKILL = 'Ты — ревьюер UI.'

describe('prompt-caching — разделение stable/volatile', () => {
  it('стабильное (system+user+skill) ИДЁТ ДО маркера, изменчивый pack — ПОСЛЕ', () => {
    const { system } = composeSystemPrompt({ path: 'CLAUDE.md', content: 'правило' }, PACK, SKILL)
    const bp = system.indexOf(CACHE_BREAKPOINT)
    expect(bp).toBeGreaterThan(0)
    const stable = system.slice(0, bp)
    const volatile = system.slice(bp + CACHE_BREAKPOINT.length)
    // стабильная часть: протокол + user + skill (не меняются между ходами)
    expect(stable).toContain('verstak_system_layer')
    expect(stable).toContain('правило')
    expect(stable).toContain(SKILL)
    // проверяем по УНИКАЛЬНОМУ контенту pack'а (слово 'context_pack' встречается в
    // тексте immutable system-layer, который его документирует — по нему нельзя)
    expect(stable).not.toContain('git status: clean')
    // изменчивая часть: только context-pack
    expect(volatile).toContain('git status: clean')
    expect(volatile).not.toContain(SKILL)
  })

  it('без context-pack → нет маркера (весь system стабилен, кэшируется целиком)', () => {
    const { system } = composeSystemPrompt({ path: null, content: '' }, '', SKILL)
    expect(system).not.toContain(CACHE_BREAKPOINT)
    expect(system).toContain(SKILL)
  })

  it('stripCacheBreakpoint убирает маркер', () => {
    const { system } = composeSystemPrompt({ path: 'CLAUDE.md', content: 'x' }, PACK, SKILL)
    const stripped = stripCacheBreakpoint(system)
    expect(stripped).not.toContain(CACHE_BREAKPOINT)
    // порядок сохранён: стабильное всё ещё до реального pack-тега
    expect(stripped.indexOf('<skill_layer>')).toBeLessThan(stripped.indexOf('<context_pack generated='))
  })

  it('systemForProvider: claude сохраняет маркер, прочие снимают', () => {
    const { system } = composeSystemPrompt({ path: 'CLAUDE.md', content: 'x' }, PACK, SKILL)
    expect(systemForProvider(system, 'claude')).toContain(CACHE_BREAKPOINT)
    expect(systemForProvider(system, 'openai')).not.toContain(CACHE_BREAKPOINT)
    expect(systemForProvider(system, 'deepseek')).not.toContain(CACHE_BREAKPOINT)
    expect(systemForProvider(system, 'gemini-api')).not.toContain(CACHE_BREAKPOINT)
  })

  it('содержимое эквивалентно старому (без потери секций) — только реордер + маркер', () => {
    const { system } = composeSystemPrompt({ path: 'CLAUDE.md', content: 'правило' }, PACK, SKILL)
    const flat = stripCacheBreakpoint(system)
    // все слои на месте
    expect(flat).toContain('verstak_system_layer')
    expect(flat).toContain('правило')
    expect(flat).toContain(SKILL)
    expect(flat).toContain('context_pack')
    expect(flat).toContain('preflight_hint')
  })
})

describe('prompt-caching — file-scoped rules в VOLATILE (ревью money-waster)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-frules-'))
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"vitest"}}')
    mkdirSync(join(dir, '.verstak', 'rules'), { recursive: true })
    writeFileSync(join(dir, '.verstak', 'rules', 'src.mdc'),
      `---\nglobs: src/**\n---\nПРАВИЛО_ДЛЯ_SRC: всегда типизируй.`)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('активное file-scoped правило идёт ПОСЛЕ маркера (volatile), не в стабильный префикс', async () => {
    const composed = await prepareSystemContext({
      projectPath: dir,
      messages: [{ role: 'user', content: 'правь' }],
      recentWrites: [{ filePath: 'src/a.ts', createdAt: 1 }]  // матчит glob src/**
    })
    const bp = composed.system.indexOf(CACHE_BREAKPOINT)
    expect(bp).toBeGreaterThan(0)
    const stable = composed.system.slice(0, bp)
    const volatile = composed.system.slice(bp)
    // правило зависит от recentWrites → должно быть в volatile, НЕ в стабильном (кэш-мисс)
    expect(stable).not.toContain('ПРАВИЛО_ДЛЯ_SRC')
    expect(volatile).toContain('ПРАВИЛО_ДЛЯ_SRC')
  })
})

describe('prompt-caching — авто-компакция сохраняет базовый system + маркер (ревью)', () => {
  const base = composeSystemPrompt({ path: 'CLAUDE.md', content: 'правило проекта' }, PACK, SKILL).system
  // Длинная история (как при реальной компакции на 95% окна): >3 user-turns, чтобы
  // recentTurns (последние 3 пары) не дотягивался до базового system-сообщения.
  const history: ChatMessage[] = [
    { role: 'system', content: base },
    ...Array.from({ length: 5 }, (_v, i) => ([
      { role: 'user' as const, content: `задача ${i}` },
      { role: 'assistant' as const, content: `ответ ${i}` },
    ])).flat(),
  ]

  it('claude (с маркером): результат несёт стабильный протокол + маркер (не off-policy, кэш жив)', () => {
    const compacted = createCompactedHistory('РЕЗЮМЕ', history, null, base)
    const firstSys = compacted.find(m => m.role === 'system')!
    expect(firstSys.content).toContain('verstak_system_layer')  // протокол сохранён
    expect(firstSys.content).toContain(CACHE_BREAKPOINT)         // маркер сохранён → кэш попадает
    // резюме — отдельным system-сообщением (уйдёт в volatile после маркера)
    const joined = compacted.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
    const bp = joined.indexOf(CACHE_BREAKPOINT)
    expect(joined.slice(bp)).toContain('РЕЗЮМЕ')
    expect(joined.slice(0, bp)).toContain('verstak_system_layer')
  })

  it('не-claude (маркер снят): базовый протокол сохранён, маркер НЕ добавляется (не протекает)', () => {
    const strippedBase = stripCacheBreakpoint(base)
    const compacted = createCompactedHistory('РЕЗЮМЕ', history, null, strippedBase)
    const joined = compacted.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
    expect(joined).toContain('verstak_system_layer')  // протокол сохранён
    expect(joined).not.toContain(CACHE_BREAKPOINT)     // маркер не просочился
  })
})
