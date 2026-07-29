// Путь ЗАПИСИ и секреты в файле пользователя (29.07). SEC-SECRET-01/02.
//
// ЧТО БЫЛО СЛОМАНО. `read_file` отдаёт содержимое, пропущенное через scanText:
// секреты заменены на `[REDACTED:…]`. Это правильно — так защищается контекст
// модели. Но путь записи брал исходное состояние файла ОТТУДА ЖЕ, и то же самое
// отредактированное содержимое клалось в стек отката. Значит после записи в файл
// с секретом нажатие «откатить» писало на диск заглушку ВМЕСТО реального
// значения. Это не утечка, а УНИЧТОЖЕНИЕ данных: утечку отзывают сменой ключа,
// затёртое значение восстановить неоткуда. И делала это кнопка, которую человек
// нажимает именно тогда, когда хочет вернуть как было.
//
// ПОЧЕМУ ЛЕЧИТСЯ НЕ ГАРДАМИ. Очевидная правка — поставить гард `[REDACTED:` ещё
// и на write_file/propose_edits — делает хуже: сканер даёт ложные срабатывания на
// обычном коде (`apiKey = descriptor.secretKey` — 13 файлов из 566, включая
// реестр провайдеров), и такие файлы стали бы нередактируемы ничем. Лечение —
// СЫРОЕ чтение на входе пути записи: точечный патч ложится на настоящий текст,
// секрет не виден модели и не затирается, а запись отката становится верной
// попутно. Гард нужен только там, где модель отдаёт файл ЦЕЛИКОМ.
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ НАСТОЯЩИМ, А НЕ МОКОМ: FileTools реальные
// (`createFileTools`), файлы настоящие во временном каталоге, хендлеры
// настоящие. Мок — только sender и recordWrite, и оба лишь ЗАПИСЫВАЮТ то, что им
// отдали: именно их содержимое и есть предмет проверки.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { writeFileHandler, applyPatchHandler, proposeEditsHandler } from '../../electron/ipc/tool-handlers/file-ops'
import { createFileTools } from '../../electron/ai/tools'
import { maskSecretsForDiff, scanText } from '../../electron/ai/secret-scanner'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { AgentMode } from '../../electron/ai/mode-policy'
import type { ToolCall } from '../../electron/ai/types'

// Настоящий по форме ключ Anthropic. Хвост A7F2 — отпечаток, по которому потом
// проверяется маска (см. блок «маска для экрана»).
const SECRET = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGA7F2'
const SECRET_NEW = 'sk-ant-api03-ZZZZYYYYXXXXWWWWVVVVUUUUTTTT91BC'

const SECRET_FILE = [
  'export const config = {',
  '  name: \'verstak\',',
  `  key: '${SECRET}',`,
  '  timeout: 30',
  '}',
  ''
].join('\n')

// Файл БЕЗ единого секрета, но сканер считает его секретным: `auth-keyword-value`
// ловит обычный код. Ровно эти 13 файлов и правят чаще всего (реестр провайдеров,
// делегирование), поэтому контроль на них — не формальность.
const FALSE_POSITIVE_FILE = [
  'export function pick(descriptor: Descriptor) {',
  '  const apiKey = descriptor.secretKey',
  '  return apiKey',
  '}',
  ''
].join('\n')

const PLAIN_FILE = [
  'export function add(a: number, b: number) {',
  '  return a + b',
  '}',
  ''
].join('\n')

interface Recorded { path: string; before: string | null; after: string }
interface Harness {
  ctx: ToolContext
  records: Recorded[]
  events: Array<Record<string, unknown>>
  controller: AbortController
}

function harness(dir: string, mode: AgentMode = 'accept-edits'): Harness {
  const records: Recorded[] = []
  const events: Array<Record<string, unknown>> = []
  const controller = new AbortController()
  const ctx = {
    runId: 'run-secret',
    projectPath: dir,
    sendId: 's',
    agentMode: mode,
    signal: controller.signal,
    sender: { send: (_ch: string, payload: { event: Record<string, unknown> }) => { events.push(payload.event) } },
    pendingWrites: new Map(),
    scopedKey: (sendId: unknown, callId: unknown) => `${sendId}:${callId}`,
    recordWrite: (_p: string, filePath: string, before: string | null, after: string) => {
      records.push({ path: filePath, before, after })
    },
    recordRunEvent: () => {},
    tools: createFileTools(dir)
  } as unknown as ToolContext
  return { ctx, records, events, controller }
}

/**
 * Ждать появления ожидающей записи. Одного тика мало: путь записи ходит в
 * НАСТОЯЩУЮ файловую систему (realpath/stat/read), и сколько это займёт тиков —
 * не наше дело. Бюджет 2 с намеренно много меньше глобального testTimeout
 * (20 000): исчерпание бюджета обязано читаться как «модалки нет», а не как
 * безымянный таймаут прогона.
 */
const WAIT_PENDING_MS = 2000
async function waitForPendingWrite(h: Harness, key: string) {
  const deadline = Date.now() + WAIT_PENDING_MS
  for (;;) {
    const pending = h.ctx.pendingWrites.get(key)
    if (pending || Date.now() >= deadline) return pending
    await new Promise<void>(r => setTimeout(r, 5))
  }
}

/** Патч, меняющий участок, СЕКРЕТА НЕ КАСАЮЩИЙСЯ. Именно так выглядит обычная правка. */
const PATCH_AWAY_FROM_SECRET = [
  '<<<<<<< SEARCH',
  '  timeout: 30',
  '=======',
  '  timeout: 60',
  '>>>>>>> REPLACE'
].join('\n')

function patchCall(path: string, diff: string, id = 'p1'): ToolCall {
  return { id, name: 'apply_patch', args: { path, diff } }
}
function writeCall(path: string, content: string, id = 'w1'): ToolCall {
  return { id, name: 'write_file', args: { path, content } }
}

describe('SEC-SECRET-01 · путь записи не уничтожает секрет в файле пользователя', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vk-secret-'))
    file = join(dir, 'config.ts')
    writeFileSync(file, SECRET_FILE, 'utf8')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  // ГЛАВНЫЙ ПИН задачи. Всё остальное в файле — следствия и подпорки к нему.
  it('правка файла с секретом в участке, секрета НЕ касающемся: секрет на диске жив и неизменен', async () => {
    const h = harness(dir)
    const res = await applyPatchHandler.handle(patchCall('config.ts', PATCH_AWAY_FROM_SECRET), h.ctx)

    expect(res.error, 'обычная правка соседнего участка не должна отвергаться').toBeFalsy()
    const disk = readFileSync(file, 'utf8')
    expect(disk, 'секрет затёрт правкой, которая его не касалась').toContain(SECRET)
    expect(disk, 'сама правка не легла').toContain('timeout: 60')
    expect(disk, 'на диск уехала заглушка сканера').not.toContain('[REDACTED:')
    expect(disk).toBe(SECRET_FILE.replace('timeout: 30', 'timeout: 60'))
  })

  it('откат возвращает СЫРОЕ содержимое, а не заглушку', async () => {
    const h = harness(dir)
    await applyPatchHandler.handle(patchCall('config.ts', PATCH_AWAY_FROM_SECRET), h.ctx)

    expect(h.records).toHaveLength(1)
    expect(h.records[0].before, 'в стек отката легла заглушка вместо живого значения').toBe(SECRET_FILE)

    // Буквально то, что делает откат: undo.ts пишет beforeContent на диск как есть
    // (electron/ipc/undo.ts — ветка `await writeFile(abs, before, 'utf8')`).
    writeFileSync(file, h.records[0].before!, 'utf8')
    expect(readFileSync(file, 'utf8'), 'откат уничтожил секрет').toBe(SECRET_FILE)
  })

  // Тот же дефект, сформулированный как инвариант на весь путь: чем бы ни
  // кончился вызов, заглушка сканера в стек отката попасть не может. Сегодня
  // сюда краснеет write_file — у него гарда нет, и он кладёт в откат
  // отредактированное «до».
  it('НИ ОДИН инструмент не кладёт заглушку сканера в стек отката', async () => {
    const h = harness(dir)
    const modelView = SECRET_FILE.replace(SECRET, '[REDACTED:openai-key]').replace('timeout: 30', 'timeout: 60')

    await applyPatchHandler.handle(patchCall('config.ts', PATCH_AWAY_FROM_SECRET), h.ctx)
    await writeFileHandler.handle(writeCall('config.ts', modelView), h.ctx)
    await proposeEditsHandler.handle(
      { id: 'e1', name: 'propose_edits', args: { edits: [{ path: 'config.ts', content: modelView }] } },
      h.ctx
    )

    const poisoned = h.records.filter(r => String(r.before).includes('[REDACTED:'))
    expect(poisoned, 'заглушка сканера доехала до стека отката — откат затрёт секрет').toEqual([])
  })

  it('патч, чей SEARCH-блок содержит [REDACTED:, отвергается сам — гард не нужен', async () => {
    const h = harness(dir)
    const diff = [
      '<<<<<<< SEARCH',
      '  key: \'[REDACTED:openai-key]\',',
      '=======',
      '  key: process.env.KEY,',
      '>>>>>>> REPLACE'
    ].join('\n')

    const res = await applyPatchHandler.handle(patchCall('config.ts', diff), h.ctx)

    expect(res.error, 'патч поверх заглушки прошёл').toBeTruthy()
    expect(res.error, 'отказ должен быть штатной ошибкой поиска, а не отдельным гардом')
      .toMatch(/SEARCH/)
    expect(readFileSync(file, 'utf8')).toBe(SECRET_FILE)
    expect(h.records).toEqual([])
  })

  it('write_file по файлу с секретом блокируется — модель отдаёт файл целиком', async () => {
    const h = harness(dir)
    const modelView = SECRET_FILE.replace(SECRET, '[REDACTED:openai-key]')

    const res = await writeFileHandler.handle(writeCall('config.ts', modelView), h.ctx)

    expect(res.error, 'полная перезапись файла с секретом прошла').toBeTruthy()
    expect(res.error, 'отказ должен подсказывать выход, а не просто запрещать').toContain('apply_patch')
    expect(readFileSync(file, 'utf8')).toBe(SECRET_FILE)
    expect(h.records).toEqual([])
  })

  it('propose_edits блокируется тем же путём — он собирает те же полные записи', async () => {
    const h = harness(dir)
    const modelView = SECRET_FILE.replace(SECRET, '[REDACTED:openai-key]')

    const res = await proposeEditsHandler.handle(
      { id: 'e1', name: 'propose_edits', args: { edits: [{ path: 'config.ts', content: modelView }] } },
      h.ctx
    )

    expect(res.error, 'propose_edits прошёл мимо гарда').toBeTruthy()
    expect(readFileSync(file, 'utf8')).toBe(SECRET_FILE)
    expect(h.records).toEqual([])
  })
})

// Сырое чтение — обход scanText, поэтому его периметр обязан быть НЕ ШИРЕ
// периметра записи. read_file намеренно пускает абсолютные пути наружу проекта
// (явный read-only контекст); для сырого «до» это было бы дырой: содержимое
// уходит в стек отката и в дифф.
describe('SEC-SECRET-01 · сырое чтение подчиняется границам ЗАПИСИ, а не чтения', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vk-raw-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('запрещённые пути (.env и прочие хранилища секретов) сырым чтением не берутся', async () => {
    const tools = createFileTools(dir)
    writeFileSync(join(dir, '.env'), `OPENAI_API_KEY=${SECRET}\n`, 'utf8')
    await expect(tools.readRaw('.env')).rejects.toThrow(/политикой безопасности/)
  })

  it('выход за пределы проекта сырым чтением не берётся', async () => {
    const tools = createFileTools(dir)
    await expect(tools.readRaw('../outside.ts')).rejects.toThrow(/за пределы проекта/)
  })

  it('абсолютный путь вне разрешённых корней сырым чтением не берётся — в отличие от read_file', async () => {
    const tools = createFileTools(dir)
    const outside = join(dir, '..', `vk-outside-${process.pid}.txt`)
    writeFileSync(outside, `key=${SECRET}\n`, 'utf8')
    try {
      // Контраст: read_file такой путь отдаёт (осознанный read-only контекст)…
      await expect(tools.execute('read_file', { path: outside })).resolves.toBeTruthy()
      // …а сырое «до» — нет: оно уехало бы в откат и в дифф.
      await expect(tools.readRaw(outside)).rejects.toThrow(/Downloads|разрешённые папки/)
    } finally {
      rmSync(outside, { force: true })
    }
  })

  it('содержимое запрещённого файла не доезжает ни до диффа, ни до отката', async () => {
    const h = harness(dir)
    writeFileSync(join(dir, '.env'), `OPENAI_API_KEY=${SECRET}\n`, 'utf8')

    const res = await writeFileHandler.handle(writeCall('.env', 'OPENAI_API_KEY=\n', 'w9'), h.ctx)

    expect(res.error, 'запись в .env прошла').toBeTruthy()
    expect(h.records).toEqual([])
    expect(JSON.stringify(h.events), 'содержимое .env уехало в renderer').not.toContain(SECRET)
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(`OPENAI_API_KEY=${SECRET}\n`)
  })
})

describe('SEC-SECRET-01 · ложные срабатывания сканера не запирают обычный код', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vk-secret-fp-'))
    file = join(dir, 'registry.ts')
    writeFileSync(file, FALSE_POSITIVE_FILE, 'utf8')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('контроль: сканер действительно считает этот обычный код секретным', () => {
    expect(scanText(FALSE_POSITIVE_FILE).hits).toContain('auth-keyword-value')
  })

  it('apply_patch по такому файлу работает — это и есть выход для 13 ложных срабатываний', async () => {
    const h = harness(dir)
    const diff = [
      '<<<<<<< SEARCH',
      '  return apiKey',
      '=======',
      '  return apiKey ?? null',
      '>>>>>>> REPLACE'
    ].join('\n')

    const res = await applyPatchHandler.handle(patchCall('registry.ts', diff), h.ctx)

    expect(res.error, 'реестр провайдеров стал нередактируемым').toBeFalsy()
    expect(readFileSync(file, 'utf8')).toContain('return apiKey ?? null')
    expect(h.records[0].before).toBe(FALSE_POSITIVE_FILE)
  })
})

describe('SEC-SECRET-01 · контроль: обычный файл правится всеми тремя инструментами как раньше', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vk-plain-'))
    file = join(dir, 'math.ts')
    writeFileSync(file, PLAIN_FILE, 'utf8')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('write_file пишет', async () => {
    const h = harness(dir)
    const res = await writeFileHandler.handle(writeCall('math.ts', 'export const x = 1\n'), h.ctx)
    expect(res.error).toBeFalsy()
    expect(readFileSync(file, 'utf8')).toBe('export const x = 1\n')
    expect(h.records[0].before).toBe(PLAIN_FILE)
  })

  it('apply_patch патчит', async () => {
    const h = harness(dir)
    const diff = ['<<<<<<< SEARCH', '  return a + b', '=======', '  return a + b + 0', '>>>>>>> REPLACE'].join('\n')
    const res = await applyPatchHandler.handle(patchCall('math.ts', diff), h.ctx)
    expect(res.error).toBeFalsy()
    expect(readFileSync(file, 'utf8')).toContain('return a + b + 0')
  })

  it('propose_edits применяет пачку', async () => {
    const h = harness(dir)
    const res = await proposeEditsHandler.handle(
      { id: 'e1', name: 'propose_edits', args: { edits: [{ path: 'math.ts', content: 'export const y = 2\n' }] } },
      h.ctx
    )
    expect(res.error).toBeFalsy()
    expect(readFileSync(file, 'utf8')).toBe('export const y = 2\n')
  })

  it('новый файл создаётся: сырого «до» нет, и это не мешает', async () => {
    const h = harness(dir)
    const res = await writeFileHandler.handle(writeCall('fresh.ts', 'export const z = 3\n', 'w2'), h.ctx)
    expect(res.error).toBeFalsy()
    expect(readFileSync(join(dir, 'fresh.ts'), 'utf8')).toBe('export const z = 3\n')
    expect(h.records[0].before, 'файла не было — в откате должен быть null, иначе откат его не удалит').toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SEC-SECRET-02 · маска для экрана.
//
// Сырое «до» нужно ТОЛЬКО main-процессу — для записи и для отката. В renderer
// уходит маскированный, но информативный дифф: renderer — это ровно тот периметр,
// откуда содержимое утекает наружу (запись экрана, демонстрация, RDP, DevTools и
// DOM, логи, буфер обмена). Без маски починка выше СОЗДАЛА БЫ новый путь наружу:
// apply_patch по файлу с секретом отдаёт в модалку весь сырой файл.
//
// ЧЕСТНО О КРАСНОТЕ. Эти три пина на коде ДО починки краснеют НЕ своим
// утверждением: apply_patch по файлу с секретом там отвергается гардом, модалка
// не показывается вовсе, и до проверки содержимого дело не доходит. Они сторожат
// поверхность, которую ОТКРЫВАЕТ сырое чтение, а не воспроизводят прежний дефект
// — прежний дефект воспроизводят пины SEC-SECRET-01 выше. Записано прямо, чтобы
// никто не принял их красноту за доказательство утечки в старом коде.
// ─────────────────────────────────────────────────────────────────────────────
describe('SEC-SECRET-02 · маска секрета в диффе, уходящем на экран', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vk-mask-'))
    file = join(dir, 'config.ts')
    writeFileSync(file, SECRET_FILE, 'utf8')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  async function pendingWriteEvent(h: Harness, call: ToolCall) {
    const p = applyPatchHandler.handle(call, h.ctx)
    const pending = await waitForPendingWrite(h, `s:${call.id}`)
    // Модалки нет (так было до починки — путь отвергался гардом). Снимаем
    // ожидание сигналом, чтобы упасть утверждением, а не висящим хендлером.
    if (pending) pending.resolve(true)
    else h.controller.abort()
    await p
    expect(pending, 'модалка подтверждения не появилась — дифф до renderer не дошёл').toBeTruthy()
    const ev = h.events.find(e => e.type === 'pending-write') as { before: string; after: string } | undefined
    expect(ev, 'события pending-write нет — показывать нечего').toBeTruthy()
    return ev!
  }

  it('сырое значение секрета в renderer не уходит НИ в «до», НИ в «после»', async () => {
    const h = harness(dir, 'ask')
    const ev = await pendingWriteEvent(h, patchCall('config.ts', PATCH_AWAY_FROM_SECRET))

    expect(ev!.before, 'сырой секрет уехал в renderer').not.toContain(SECRET)
    expect(ev!.after, 'сырой секрет уехал в renderer').not.toContain(SECRET)
    // Инвариант жёстче простого «не содержит эту строку»: в маскированном тексте
    // сканер не должен находить ВООБЩЕ ничего.
    expect(scanText(ev!.before).hits).toEqual([])
    expect(scanText(ev!.after).hits).toEqual([])
  })

  it('маска информативна: тип секрета, отпечаток и что с ним происходит', async () => {
    const h = harness(dir, 'ask')
    const ev = await pendingWriteEvent(h, patchCall('config.ts', PATCH_AWAY_FROM_SECRET))

    expect(ev!.before, 'маска не сообщает, что в строке секрет').toContain('[SECRET:')
    expect(ev!.before, 'нет отпечатка — человек не отличит один ключ от другого').toContain('…A7F2')
    expect(ev!.before, 'не сказано, что с секретом происходит').toContain('без изменений')
    expect(ev!.after).toContain('без изменений')
    // Правка соседнего участка обязана читаться как правка соседнего участка:
    // строка с секретом на обеих сторонах одинакова, значит дифф её не подсветит.
    expect(ev!.after).toContain('timeout: 60')
  })

  it('«файл цел» видно: маска не съедает окружающий текст', async () => {
    const h = harness(dir, 'ask')
    const ev = await pendingWriteEvent(h, patchCall('config.ts', PATCH_AWAY_FROM_SECRET))
    expect(ev!.before).toContain('name: \'verstak\'')
    expect(ev!.before).toContain('key: ')
  })
})

describe('SEC-SECRET-02 · maskSecretsForDiff: четыре случая', () => {
  const line = (v: string) => `API_KEY=${v}\n`

  it('без изменений — одинаковая маска с обеих сторон, дифф строку не подсветит', () => {
    const m = maskSecretsForDiff(line(SECRET), line(SECRET) + 'extra\n')
    expect(m.before).toContain('без изменений')
    expect(m.before.split('\n')[0]).toBe(m.after.split('\n')[0])
    expect(m.before).not.toContain(SECRET)
  })

  it('изменён — стороны РАЗНЫЕ, направление читается по диффу', () => {
    const m = maskSecretsForDiff(line(SECRET), line(SECRET_NEW))
    expect(m.before).toContain('изменён')
    expect(m.after).toContain('изменён')
    expect(m.before).toContain('было …A7F2')
    expect(m.after).toContain('стало …91BC')
    expect(m.before).not.toBe(m.after)
    expect(m.before).not.toContain(SECRET)
    expect(m.after).not.toContain(SECRET_NEW)
  })

  it('удалён — главный случай: правка сносит живой секрет', () => {
    const m = maskSecretsForDiff(line(SECRET), 'API_KEY=\n')
    expect(m.before).toContain('удалён')
    expect(m.before).toContain('было …A7F2')
    expect(m.before).not.toContain(SECRET)
  })

  it('добавлен — в файл заезжает новый секрет', () => {
    const m = maskSecretsForDiff('API_KEY=\n', line(SECRET_NEW))
    expect(m.after).toContain('добавлен')
    expect(m.after).toContain('…91BC')
    expect(m.after).not.toContain(SECRET_NEW)
  })

  it('несколько секретов разных ключей не путаются между собой', () => {
    const before = `API_KEY=${SECRET}\nCLIENT_SECRET=${SECRET_NEW}\n`
    const after = `API_KEY=${SECRET}\nCLIENT_SECRET=\n`
    const m = maskSecretsForDiff(before, after)
    const [k, c] = m.before.split('\n')
    expect(k, 'нетронутый ключ объявлен изменившимся').toContain('без изменений')
    expect(c, 'снесённый секрет не объявлен удалённым').toContain('удалён')
  })

  it('текст без секретов проходит дословно — маска не «чистит всё подряд»', () => {
    const m = maskSecretsForDiff(PLAIN_FILE, PLAIN_FILE + 'const q = 1\n')
    expect(m.before).toBe(PLAIN_FILE)
    expect(m.after).toBe(PLAIN_FILE + 'const q = 1\n')
  })

  it('сама маска не матчится сканером — иначе второй проход исказил бы разметку', () => {
    const m = maskSecretsForDiff(line(SECRET), line(SECRET_NEW))
    expect(scanText(m.before).hits).toEqual([])
    expect(scanText(m.after).hits).toEqual([])
  })

  it('покрытие маски не уже покрытия редакции: что гасит scanText, то маскирует и маска', () => {
    const corpus = [
      'AKIAIOSFODNN7EXAMPLE',
      'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'https://admin:p4ss@1c.example.com/odata',
      'X-Secret: 0123456789abcdef0123456789abcdef01234567',
      'mytool --token SECRETTOKENVALUE1234',
      'OAuth y0_AgAAAABcDeFgHiJkLmNoPqRsTuVwXyZ012345',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAA==\n-----END RSA PRIVATE KEY-----'
    ].join('\n')
    const m = maskSecretsForDiff(corpus, '')
    expect(scanText(m.before).hits, 'маска покрыла меньше, чем редакция — секрет уедет в renderer').toEqual([])
  })
})
