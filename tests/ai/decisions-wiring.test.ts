import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { buildContextPack } from '../../electron/ai/context-pack'

// Знание о решениях доезжает до модели по ЦЕПОЧКЕ из четырёх звеньев:
//   brainStore.getDecisionRecords → AiDeps.listDecisions → SystemAssemblyDeps →
//   prepareSystemContext → context-pack → блок в system prompt.
//
// Разрыв любого звена НЕ КРАСНЕЕТ САМ: поле просто окажется undefined, блок не
// появится, и всё останется зелёным. Ровно так эта функция и «отсутствовала» до 31.08 —
// запись работала, чтение работало, панель показывала человеку, а агент не получал
// ничего, и никто этого не замечал.
//
// Поэтому цепочка проверяется двумя способами: поведением сборщика (главное) и
// текстовой сверкой проводки (страж от тихого разрыва).

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const DECISION = {
  title: 'Хранение сессий',
  finalDecision: 'SQLite на пользователя',
  why: 'переносится одним файлом',
  alternativesRejected: ['общая БД на всех'],
  createdAt: Date.UTC(2026, 7, 20),
}

describe('решения доезжают до контекста', () => {
  it('на ПЕРВОМ ходе блок появляется в собранном контексте', async () => {
    const pack = await buildContextPack({
      projectPath: ROOT,
      isFirstTurn: true,
      decisions: [DECISION],
    })
    expect(pack).toContain('Что уже решено в этом проекте')
    expect(pack).toContain('УЖЕ ОТВЕРГНУТО')
    expect(pack).toContain('общая БД на всех')
  })

  // КОНТРОЛЬНЫЙ КЕЙС: не на первом ходе блока быть НЕ должно — иначе мы платим за
  // одно и то же каждый ход, а решения и так уже в истории чата.
  it('на последующих ходах блока нет — за одно и то же не платим дважды', async () => {
    const pack = await buildContextPack({
      projectPath: ROOT,
      isFirstTurn: false,
      decisions: [DECISION],
    })
    expect(pack).not.toContain('Что уже решено в этом проекте')
  })

  it('решений нет — блока нет, даже на первом ходе', async () => {
    const pack = await buildContextPack({ projectPath: ROOT, isFirstTurn: true, decisions: [] })
    expect(pack).not.toContain('Что уже решено в этом проекте')
  })
})

describe('проводка цепочки не разорвана', () => {
  it('main.ts наполняет listDecisions из хранилища решений', () => {
    expect(read('electron/main.ts')).toMatch(/listDecisions:.*getDecisionRecords/)
  })

  it('ai.ts объявляет listDecisions в AiDeps и передаёт его в сборщик', () => {
    const s = read('electron/ipc/ai.ts')
    expect(s, 'нет объявления в AiDeps').toMatch(/listDecisions\?:/)
    expect(s, 'не передан в SystemAssemblyDeps').toMatch(/listDecisions: deps\.listDecisions/)
  })

  it('сборчик отдаёт решения в prepareSystemContext', () => {
    expect(read('electron/ipc/ai-send/system-assembly.ts')).toMatch(/decisions: input\.projectPath && input\.deps\.listDecisions/)
  })
})
