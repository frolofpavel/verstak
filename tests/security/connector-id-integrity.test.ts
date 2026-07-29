// SEC-CMD-05 · гейт и исполнение коннектора судят ОДНО И ТО ЖЕ имя.
//
// ЧТО БЫЛО СЛОМАНО — классический подставной посредник: вердикт выносится про
// один коннектор, исполняется другой. Расхождений было ДВА, и оба живые.
//
// 1. ЛИШНИЙ КЛЮЧ. Хендлер определял коннектор ТОЛЬКО по `args.id`
//    (connectors.ts:41), а оба гейта читали `args.connector ?? args.id`
//    (responsible-action.ts:109, permission-rules.ts:366). Вызов
//    {id:'telegram', connector:'onec'} судился как безобидный `onec` — пауза
//    ответственного действия не срабатывала, deny-правило на telegram не
//    матчилось, — а исполнялся telegram: сообщение уходило живому человеку.
//    Толерантность «имя может лежать в connector ИЛИ в id» была безобидной,
//    пока по этим значениям ничего не решалось; когда по ним стали решать
//    паузу и permissions, предпосылка умерла, а код остался.
//    Отдельно важно: схема инструмента объявляет ТОЛЬКО `id`
//    (tools.ts:302, required:['id']) — ключ `connector` модель по контракту
//    породить не может, поэтому его присутствие не альтернативная форма, а
//    аномалия.
//
// 2. АЛИАС ПОСЛЕ ВЕРДИКТА. Канонизация (`ywordstat` → `yandex_wordstat`) стояла
//    в хендлере ПОСЛЕ resolveDecision, поэтому правило, написанное на
//    канонический id, обходилось написанием алиаса.
//
// ЛЕЧЕНИЕ — ОДНО ЗНАЧЕНИЕ ИЗ ОДНОГО МЕСТА: canonicalConnectorId() зовут все
// трое (хендлер, классификатор ответственного, extractArgText), плюс явный
// отказ при конфликте ключей. Полного allowlist ключей НЕТ намеренно:
// параметры коннекторов произвольны и уходят в `rest` (entity/op/path/body/…),
// а двусмысленным был ровно идентификатор — единственный ключ, по которому
// выносится вердикт.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { connectorQueryHandler } from '../../electron/ipc/tool-handlers/connectors'
import { classifyResponsibleAction } from '../../electron/ai/responsible-action'
import { resolveDecision, compilePermissionConfig } from '../../electron/ai/permission-rules'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { AgentMode } from '../../electron/ai/mode-policy'
import type { ToolCall } from '../../electron/ai/types'

let dir: string
/** Кого РЕАЛЬНО дёрнули: предмет проверки — совпадение с тем, кого судили. */
let queried: string[]

function ctxFor(agentMode: AgentMode, over: Record<string, unknown> = {}): ToolContext {
  const aborted = new AbortController()
  aborted.abort()
  return {
    projectPath: dir,
    sendId: 1,
    agentMode,
    signal: aborted.signal,
    pendingCommands: new Map(),
    scopedKey: (s: number, c: string) => `${s}::${c}`,
    sender: { send: vi.fn() },
    connectors: {
      list: () => [
        { id: 'telegram', kind: 'telegram' },
        { id: 'onec', kind: 'onec' },
        { id: 'yandex_wordstat', kind: 'wordstat' },
        { id: 'yandex_disk', kind: 'disk' },
      ],
      query: async (id: string) => { queried.push(id); return { ok: true } },
    },
    recordJournal: () => {},
    recordRunEvent: () => {},
    ...over,
  } as unknown as ToolContext
}

const call = (args: Record<string, unknown>): ToolCall => ({ id: 'c1', name: 'connector_query', args })

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vst-conn-id-')); queried = [] })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('SEC-CMD-05 · подделка вердикта лишним ключом', () => {
  // ОБЯЗАТЕЛЬНЫЙ ПИН: исполняется не то, что судил гейт.
  it('{id:telegram, connector:onec} НЕ отправляет в telegram по вердикту про onec', async () => {
    const res = await connectorQueryHandler.handle(
      call({ id: 'telegram', connector: 'onec', op: 'send_message', text: 'привет' }),
      ctxFor('auto'),
    )

    expect(queried, 'исполнен коннектор, которого гейт не судил').not.toContain('telegram')
    expect(res.error, 'расхождение ключей должно быть названо, а не проглочено').toBeTruthy()
  })

  it('deny-правило на telegram не обходится подстановкой другого имени в connector', async () => {
    const rules = compilePermissionConfig({ deny: ['connector_query(telegram)'] })

    await connectorQueryHandler.handle(
      call({ id: 'telegram', connector: 'onec', op: 'send_message' }),
      ctxFor('auto', { permissionRules: rules }),
    )

    expect(queried).not.toContain('telegram')
  })

  // ОТДЕЛЬНЫЙ ПИН НА ОТКАЗ, и он нужен. После единого извлечения расхождение
  // само по себе перестаёт быть дырой: гейт и исполнение согласованы, а вызов
  // с ответственным коннектором просто упирается в паузу. Проверено мутацией —
  // сняв отказ, пины выше остаются ЗЕЛЁНЫМИ. Поэтому берём НЕответственную пару:
  // без явного отказа такой вызов молча исполнился бы по `id`, хотя вызывающий
  // назвал два разных коннектора и его намерение неизвестно.
  it('конфликт имён отвергается ЯВНО, а не разрешается молча в пользу одного', async () => {
    const res = await connectorQueryHandler.handle(
      call({ id: 'onec', connector: 'http', entity: 'X' }),
      ctxFor('auto'),
    )

    expect(queried, 'вызов с двумя разными именами исполнился молча').toEqual([])
    expect(String(res.error), 'отказ обязан назвать оба имени').toMatch(/onec/)
    expect(String(res.error)).toMatch(/http/)
  })

  // Расхождение видно и на уровне решения — до всякого исполнения.
  it('классификатор судит по ТОМУ ЖЕ имени, которое исполнится', () => {
    const v = classifyResponsibleAction('connector_query', { id: 'telegram', connector: 'onec' })
    expect(v.responsible, 'вердикт вынесен про onec, а исполнится telegram').toBe(true)
  })

  it('алиас не обходит правило: ywordstat судится как yandex_wordstat', () => {
    const rules = compilePermissionConfig({ deny: ['connector_query(yandex_wordstat)'] })

    const { decision } = resolveDecision('connector_query', { id: 'ywordstat' }, 'auto', undefined, rules)

    expect(decision, 'правило на канонический id обошли алиасом').toBe('block')
  })

  it('мёртвое правило Я.Диска ожило: реальный id yandex_disk даёт паузу', () => {
    const v = classifyResponsibleAction('connector_query', { id: 'yandex_disk' })
    expect(v.responsible, 'публикация файла по ссылке не спрашивает').toBe(true)
    expect(v.kind).toBe('publish')
  })

  // КОНТРОЛЬ. Без него «починкой» был бы запрет коннекторов вообще: пины выше
  // стали бы зелёными, а инструмент — мёртвым.
  it('контроль: обычный вызов по одному id исполняется', async () => {
    const res = await connectorQueryHandler.handle(call({ id: 'onec', entity: 'X' }), ctxFor('auto'))

    expect(res.error).toBeFalsy()
    expect(queried).toEqual(['onec'])
  })

  it('контроль: алиас по-прежнему РАБОТАЕТ, когда его никто не запрещает', async () => {
    const res = await connectorQueryHandler.handle(call({ id: 'ywordstat', op: 'get_wordstat' }), ctxFor('auto'))

    expect(res.error).toBeFalsy()
    expect(queried, 'канонизация алиаса потеряна').toEqual(['yandex_wordstat'])
  })

  it('контроль: совпадающий connector конфликтом не считается', async () => {
    const res = await connectorQueryHandler.handle(
      call({ id: 'onec', connector: 'onec', entity: 'X' }),
      ctxFor('auto'),
    )

    expect(res.error).toBeFalsy()
    expect(queried).toEqual(['onec'])
  })

  it('контроль: ответственный коннектор по-прежнему требует паузы', async () => {
    await connectorQueryHandler.handle(call({ id: 'telegram', op: 'send_message' }), ctxFor('auto'))

    expect(queried, 'telegram отправил без подтверждения').toEqual([])
  })
})
