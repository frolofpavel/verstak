// Пакет 2.1.13, событие `pre-compress`.
//
// Смысл события: часть диалога уходит под сжатие и больше не попадёт модели. До этого
// момента из неё надо забрать то, что изменит следующую работу — и НЕ превратить память
// в свалку. Поэтому проверяем не «что-то записалось», а границы:
// сколько, какой длины, без секретов, без дублей, в свой проект и без права уронить
// компакцию.
import { describe, it, expect, vi } from 'vitest'
import {
  buildPreCompressPrompt,
  parseMemoryCandidates,
  normalizeMemoryBatch,
  capturePreCompressMemories,
  memoryKey,
  MEMORY_BATCH_LIMIT,
  MEMORY_CONTENT_LIMIT,
  PRE_COMPRESS_TAG,
  type MemoryCandidate,
} from '../../electron/ai/memory-lifecycle'

const msg = (role: string, content: string) => ({ role, content })

describe('buildPreCompressPrompt', () => {
  it('несёт запрет на пересказ и требование строгого JSON', () => {
    const p = buildPreCompressPrompt({ messages: [msg('user', 'привет')] })
    expect(p.system).toMatch(/НЕ пересказ/i)
    expect(p.system).toContain('JSON')
    expect(p.system).toContain(String(MEMORY_BATCH_LIMIT))
    expect(p.system).toContain(String(MEMORY_CONTENT_LIMIT))
  })

  it('предыдущий итог отдаётся явно с запретом повторной записи', () => {
    const p = buildPreCompressPrompt({
      messages: [msg('user', 'дальше')],
      previousSummary: 'ранее договорились про SQLite',
    })
    expect(p.user).toContain('ранее договорились про SQLite')
    expect(p.user).toMatch(/повторно НЕ сохранять/i)
  })

  it('без предыдущего итога блок не появляется вовсе', () => {
    const p = buildPreCompressPrompt({ messages: [msg('user', 'дальше')] })
    expect(p.user).not.toMatch(/Уже сжато ранее/i)
  })

  it('хвост последних ходов показан отдельно — иначе не видно, какая нить открыта', () => {
    const messages = Array.from({ length: 12 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `ход ${i}`))
    const p = buildPreCompressPrompt({ messages, tailMessages: 3 })
    expect(p.user).toMatch(/Текущая нить/i)
    const tailBlock = p.user.slice(p.user.indexOf('Текущая нить'))
    expect(tailBlock).toContain('ход 11')
    expect(tailBlock).not.toContain('ход 0')
  })
})

describe('parseMemoryCandidates — терпимость к обёрткам, но не к мусору', () => {
  it('чистый JSON-массив', () => {
    const out = parseMemoryCandidates('[{"type":"decision","content":"взяли SQLite","tags":["db"]}]')
    expect(out).toEqual([{ type: 'decision', content: 'взяли SQLite', tags: ['db'] }])
  })

  it('в ```json-заборе', () => {
    const out = parseMemoryCandidates('Вот факты:\n```json\n[{"type":"fact","content":"порт 5173"}]\n```\nготово')
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe('порт 5173')
    expect(out[0].tags).toEqual([])
  })

  it('неизвестный type схлопывается в fact, а не теряет запись', () => {
    const out = parseMemoryCandidates('[{"type":"нечто","content":"важный факт"}]')
    expect(out[0].type).toBe('fact')
  })

  it('мусор, пустой ответ и не-массив дают пустую пачку, а не исключение', () => {
    expect(parseMemoryCandidates('извини, не могу')).toEqual([])
    expect(parseMemoryCandidates('')).toEqual([])
    expect(parseMemoryCandidates('{"content":"объект вместо массива"}')).toEqual([])
    expect(parseMemoryCandidates('[]')).toEqual([])
  })

  it('элементы без content отбрасываются поштучно', () => {
    const out = parseMemoryCandidates('[{"type":"fact"},{"type":"fact","content":"годный"},{"content":"   "}]')
    expect(out.map(c => c.content)).toEqual(['годный'])
  })
})

describe('normalizeMemoryBatch — границы ДО записи', () => {
  const cand = (content: string, tags: string[] = []): MemoryCandidate => ({ type: 'fact', content, tags })

  it('секрет редактируется ДО записи и попадает в память только как [REDACTED]', () => {
    const batch = normalizeMemoryBatch([cand('ключ проекта sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA живёт в .env')])
    expect(batch.redactedCount).toBe(1)
    expect(batch.accepted).toHaveLength(1)
    expect(batch.accepted[0].content).not.toContain('sk-ant-api03')
    expect(batch.accepted[0].content).toContain('REDACTED')
  })

  it('слишком длинная запись обрезается по лимиту', () => {
    const batch = normalizeMemoryBatch([cand('ф'.repeat(MEMORY_CONTENT_LIMIT + 200))])
    expect(batch.accepted[0].content.length).toBeLessThanOrEqual(MEMORY_CONTENT_LIMIT)
    expect(batch.accepted[0].content.endsWith('…')).toBe(true)
  })

  it('огрызки («ок», «сделано») в память не идут', () => {
    const batch = normalizeMemoryBatch([cand('ок'), cand('сделано')])
    expect(batch.accepted).toHaveLength(0)
    expect(batch.skipped.every(s => s.reason === 'too-short')).toBe(true)
  })

  it('пачка режется по количеству — память не журнал', () => {
    const many = Array.from({ length: MEMORY_BATCH_LIMIT + 4 }, (_, i) => cand(`устойчивый факт номер ${i} про проект`))
    const batch = normalizeMemoryBatch(many)
    expect(batch.accepted).toHaveLength(MEMORY_BATCH_LIMIT)
    expect(batch.skipped.filter(s => s.reason === 'over-limit')).toHaveLength(4)
  })

  it('дубли внутри пачки схлопываются, различия в регистре и пунктуации не спасают', () => {
    const batch = normalizeMemoryBatch([
      cand('Решили хранить снапшоты в SQLite.'),
      cand('решили хранить снапшоты в sqlite'),
    ])
    expect(batch.accepted).toHaveLength(1)
    expect(batch.skipped[0].reason).toBe('duplicate-in-batch')
  })

  it('дубли против уже сохранённого — повторное событие не плодит близнецов', () => {
    const batch = normalizeMemoryBatch([cand('Решили хранить снапшоты в SQLite')], {
      existing: ['решили хранить снапшоты в sqlite!'],
    })
    expect(batch.accepted).toHaveLength(0)
    expect(batch.skipped[0].reason).toBe('duplicate-existing')
  })

  it('каждая запись помечается тегом события, теги кандидата ограничены', () => {
    const batch = normalizeMemoryBatch([cand('устойчивый факт про структуру проекта', ['a', 'b', 'c', 'd', 'e'])])
    expect(batch.accepted[0].tags).toContain(PRE_COMPRESS_TAG)
    expect(batch.accepted[0].tags).toHaveLength(4)  // 3 кандидатских + тег события
  })

  it('memoryKey одинаков для одного факта в разной огранке', () => {
    expect(memoryKey('Порт  5173, dev-сервер!')).toBe(memoryKey('порт 5173 dev сервер'))
  })
})

describe('capturePreCompressMemories — событие целиком', () => {
  const base = {
    projectPath: '/proj',
    messages: [msg('user', 'давай решим'), msg('assistant', 'решили')],
    existingContents: () => [],
  }

  it('счастливый путь: одна атомарная запись пачки в проект чата', async () => {
    const saveBatch = vi.fn()
    const res = await capturePreCompressMemories({
      ...base,
      extract: async () => '[{"type":"decision","content":"снапшоты храним в SQLite","tags":["db"]}]',
      saveBatch,
    })
    expect(res).toMatchObject({ ok: true, saved: 1 })
    expect(saveBatch).toHaveBeenCalledTimes(1)
    expect(saveBatch.mock.calls[0][0]).toBe('/proj')
    expect(saveBatch.mock.calls[0][1]).toHaveLength(1)
  })

  it('сбой извлечения — пустой результат с причиной, БЕЗ исключения наружу', async () => {
    const saveBatch = vi.fn()
    const res = await capturePreCompressMemories({
      ...base,
      extract: async () => { throw new Error('провайдер лёг') },
      saveBatch,
    })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('extract-failed')
    expect(res.detail).toContain('провайдер лёг')
    expect(saveBatch, 'ничего не пишем, если извлечение не состоялось').not.toHaveBeenCalled()
  })

  it('сбой записи пачки: saved=0 и честная причина — полупачки не бывает', async () => {
    const res = await capturePreCompressMemories({
      ...base,
      extract: async () => '[{"type":"fact","content":"устойчивый факт про проект"}]',
      saveBatch: () => { throw new Error('db locked') },
    })
    expect(res).toMatchObject({ ok: false, saved: 0, reason: 'save-failed' })
  })

  it('нет проекта — писать некуда, границу памяти не нарушаем', async () => {
    const saveBatch = vi.fn()
    const extract = vi.fn()
    const res = await capturePreCompressMemories({ ...base, projectPath: null, extract, saveBatch })
    expect(res.reason).toBe('no-project')
    expect(extract, 'без проекта даже модель дёргать незачем').not.toHaveBeenCalled()
    expect(saveBatch).not.toHaveBeenCalled()
  })

  it('выключено настройкой — событие не идёт в модель', async () => {
    const extract = vi.fn()
    const res = await capturePreCompressMemories({ ...base, enabled: false, extract, saveBatch: vi.fn() })
    expect(res.reason).toBe('disabled')
    expect(extract).not.toHaveBeenCalled()
  })

  it('модель ответила «нечего сохранять» — пустая пачка, записи нет', async () => {
    const saveBatch = vi.fn()
    const res = await capturePreCompressMemories({ ...base, extract: async () => '[]', saveBatch })
    expect(res).toMatchObject({ ok: true, saved: 0, reason: 'nothing-to-extract' })
    expect(saveBatch).not.toHaveBeenCalled()
  })

  it('повторное событие на том же чате: всё уже в памяти → записи нет', async () => {
    const saveBatch = vi.fn()
    const extract = async () => '[{"type":"decision","content":"снапшоты храним в SQLite"}]'
    const res = await capturePreCompressMemories({
      ...base,
      existingContents: () => ['Снапшоты храним в SQLite.'],
      extract,
      saveBatch,
    })
    expect(res.saved).toBe(0)
    expect(res.skipped).toBe(1)
    expect(saveBatch).not.toHaveBeenCalled()
  })

  it('сбой чтения существующей памяти не отменяет событие — дедуп best-effort', async () => {
    const saveBatch = vi.fn()
    const res = await capturePreCompressMemories({
      ...base,
      existingContents: () => { throw new Error('нет таблицы') },
      extract: async () => '[{"type":"fact","content":"устойчивый факт про проект"}]',
      saveBatch,
    })
    expect(res.saved).toBe(1)
  })

  it('extract получает и сжимаемую часть, и предыдущий итог', async () => {
    const extract = vi.fn(async (_prompt: { system: string; user: string }) => '[]')
    await capturePreCompressMemories({
      ...base,
      previousSummary: 'ранее: выбрали better-sqlite3',
      extract,
      saveBatch: vi.fn(),
    })
    const prompt = extract.mock.calls[0][0]
    expect(prompt.user).toContain('давай решим')
    expect(prompt.user).toContain('ранее: выбрали better-sqlite3')
  })
})
