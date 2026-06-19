import { describe, it, expect, vi } from 'vitest'
import {
  isExcludedPath, selectImportantFiles, summarizeFileStub, buildContextPack, estimateTokens, runWarmup, pickPackType,
} from '../../electron/ai/project-brain/warmup'
import type { ProjectBrainStore, FileSummary, ContextPack } from '../../electron/storage/project-brain'

describe('warmup — выбор файлов', () => {
  it('исключает мусор (node_modules/.git/dist/lock/бинарники)', () => {
    expect(isExcludedPath('node_modules/x/index.js')).toBe(true)
    expect(isExcludedPath('.git/config')).toBe(true)
    expect(isExcludedPath('dist/bundle.js')).toBe(true)
    expect(isExcludedPath('package-lock.json')).toBe(true)
    expect(isExcludedPath('icon.png')).toBe(true)
    expect(isExcludedPath('src/index.ts')).toBe(false)
  })

  it('selectImportantFiles: важные раньше, мусор/тесты вниз, cap', () => {
    const files = [
      'node_modules/a/b.js', 'README.md', 'package.json', 'src/store/projectStore.ts',
      'src/components/Foo.test.tsx', 'src/index.ts', 'dist/x.js', 'random.txt', 'docs/guide.md',
    ]
    const sel = selectImportantFiles(files, 5)
    expect(sel).not.toContain('node_modules/a/b.js')
    expect(sel).not.toContain('dist/x.js')
    expect(sel[0]).toBe('README.md')        // высший score
    expect(sel).toContain('package.json')
    expect(sel.length).toBeLessThanOrEqual(5)
  })
})

describe('warmup — summary + packs', () => {
  it('summarizeFileStub: берёт doc-строку, экспорты, локальные зависимости', () => {
    const content = `// Делает важную вещь X\nimport { a } from './a'\nimport b from 'pkg'\nexport function foo() {}\nexport const bar = 1`
    const s = summarizeFileStub('src/x.ts', content)
    expect(s.summary).toMatch(/важную вещь X/)
    expect(s.keyExports).toEqual(expect.arrayContaining(['foo', 'bar']))
    expect(s.keyDependencies).toContain('./a')   // локальная
    expect(s.keyDependencies).not.toContain('pkg') // внешняя — отброшена
  })

  it('buildContextPack: short короче long, в бюджете, sourceFiles заполнены', () => {
    const sums: FileSummary[] = Array.from({ length: 30 }, (_, i) => ({
      filePath: `src/f${i}.ts`, fileHash: null, summary: 'делает что-то полезное и важное для проекта',
      keyExports: ['expA', 'expB'], keyDependencies: ['./dep'], risks: null, tokenEstimate: 100,
    }))
    const short = buildContextPack('short', 'Обзор', sums)
    const long = buildContextPack('long', 'Обзор', sums)
    expect(short.type).toBe('short')
    expect(estimateTokens(short.content)).toBeLessThanOrEqual(2000)
    expect(short.content.length).toBeLessThan(long.content.length) // long детальнее
    expect(short.sourceFiles.length).toBeGreaterThan(0)
    expect(long.content).toMatch(/экспорт:/) // long включает экспорты
  })
})

describe('pickPackType — выбор слоя по задаче (Итер.4)', () => {
  it('короткий запрос → short', () => {
    expect(pickPackType('поправь опечатку')).toBe('short')
    expect(pickPackType('2+2?')).toBe('short')
  })
  it('план/обзор → medium', () => {
    expect(pickPackType('спроектируй подход к авторизации')).toBe('medium')
    expect(pickPackType('дай обзор где лежит логика роутинга')).toBe('medium')
  })
  it('архитектура/глубокий разбор → long', () => {
    expect(pickPackType('как устроен весь проект целиком?')).toBe('long')
    expect(pickPackType('большой рефактор всего кода')).toBe('long')
  })
})

describe('runWarmup — оркестратор (моки)', () => {
  function mockStore() {
    const fileSummaries: FileSummary[] = []
    const packs: ContextPack[] = []
    let brainPatch: Record<string, unknown> = {}
    const store = {
      saveFileSummary: vi.fn((_p, fs) => fileSummaries.push(fs)),
      saveContextPack: vi.fn((_p, pk) => packs.push(pk)),
      updateBrain: vi.fn((_p, patch) => { brainPatch = patch; return null }),
      createBrain: vi.fn(), getBrain: vi.fn(), getFileSummaries: vi.fn(() => fileSummaries),
      getContextPacks: vi.fn(() => packs), getContextPack: vi.fn(), saveDecisionRecord: vi.fn(), getDecisionRecords: vi.fn(),
    } as unknown as ProjectBrainStore
    return { store, fileSummaries, packs, getPatch: () => brainPatch }
  }

  it('скан → summary важных → overview + 3 пакета сохранены', async () => {
    const m = mockStore()
    const files = ['node_modules/x.js', 'README.md', 'package.json', 'src/index.ts', 'src/store/s.ts', 'dist/y.js']
    const res = await runWarmup('C:/proj', {
      listFiles: async () => files,
      readFile: async (rel) => `// ${rel}\nexport const z = 1`,
      store: m.store,
    })
    expect(res.filesScanned).toBe(6)
    expect(res.filesSummarized).toBe(4)          // README/package.json/index/store, без node_modules/dist
    expect(m.fileSummaries).toHaveLength(4)
    expect(m.packs.map(p => p.type)).toEqual(['short', 'medium', 'long'])
    expect((m.getPatch() as { importantFiles: string[] }).importantFiles).not.toContain('node_modules/x.js')
    expect((m.getPatch() as { lastWarmupAt: number }).lastWarmupAt).toBeGreaterThan(0)
  })

  it('файл не прочитался → пропускается, не падает', async () => {
    const m = mockStore()
    const res = await runWarmup('C:/proj', {
      listFiles: async () => ['README.md', 'package.json'],
      readFile: async (rel) => rel === 'README.md' ? '# проект' : null,
      store: m.store,
    })
    expect(res.filesSummarized).toBe(1)
  })
})
