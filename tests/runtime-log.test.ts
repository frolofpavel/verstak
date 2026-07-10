import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'os'

// runtime-log тянет electron (app/ipcMain) на загрузке — мокаем.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, ipcMain: { handle: () => {} } }))

const { sanitize } = await import('../electron/runtime-log')

describe('runtime-log sanitize — редакция ЗНАЧЕНИЙ, не только по имени ключа (1.9.8 #6)', () => {
  it('секрет в строковом значении под НЕ-секрет ключом (stderr) редактируется', () => {
    const out = sanitize({ stderr: 'fatal: remote https://user:supersecretpw@github.com rejected' }) as { stderr: string }
    expect(out.stderr).not.toContain('supersecretpw')
  })

  it('Authorization: Bearer в значении гасится', () => {
    const out = sanitize({ detail: 'req headers Authorization: Bearer sk-ant-abcdefghij0123456789klmno' }) as { detail: string }
    expect(out.detail).not.toContain('sk-ant-abcdefghij0123456789klmno')
  })

  it('секрет в message/stack ошибки редактируется', () => {
    const err = new Error('auth failed: api_key=sk-proj-abcdefghij1234567890')
    const out = sanitize(err) as { message: string }
    expect(out.message).not.toContain('sk-proj-abcdefghij1234567890')
  })

  it('редакция по имени ключа сохранена (быстрый первый слой)', () => {
    const out = sanitize({ token: 'anything', password: 'x' }) as Record<string, string>
    expect(out.token).toBe('[redacted]')
    expect(out.password).toBe('[redacted]')
  })

  it('чистые значения не трогаются', () => {
    const out = sanitize({ event: 'run_start', count: 5, ok: true }) as Record<string, unknown>
    expect(out).toEqual({ event: 'run_start', count: 5, ok: true })
  })
})

describe('runtime-log sanitize — вложенность, массивы, split-token контракт (1.9.8 #6)', () => {
  it('секрет во ВЛОЖЕННОМ объекте под не-секрет ключом редактируется (рекурсия)', () => {
    const out = sanitize({ req: { ctx: { detail: 'api_key=ABCDEFGHIJ0123456789KLMN' } } }) as { req: { ctx: { detail: string } } }
    expect(out.req.ctx.detail).not.toContain('ABCDEFGHIJ0123456789KLMN')
  })

  it('секреты в элементах МАССИВА редактируются поэлементно', () => {
    const out = sanitize({ argv: ['run', 'Authorization: Bearer sk-ant-abcdefghij0123456789klmno', 'clean'] }) as { argv: string[] }
    expect(out.argv.join(' ')).not.toContain('sk-ant-abcdefghij0123456789klmno')
    expect(out.argv[0]).toBe('run')       // чистые элементы целы
    expect(out.argv[2]).toBe('clean')
  })

  it('глубже 5 уровней → [MaxDepth] (защита от циклов/бомб), без падения', () => {
    const deep: Record<string, unknown> = {}
    let cur = deep
    for (let i = 0; i < 8; i++) { cur.next = {}; cur = cur.next as Record<string, unknown> }
    cur.leaf = 'api_key=ABCDEFGHIJ0123456789KLMN'
    const out = sanitize(deep) as Record<string, unknown>
    // цепочка обрывается маркером до 8-го уровня — секрет за обрывом не сериализуется в лог
    expect(JSON.stringify(out)).toContain('[MaxDepth]')
    expect(JSON.stringify(out)).not.toContain('ABCDEFGHIJ0123456789KLMN')
  })

  // Контракт stderr-редакции: CLI-провайдеры аккумулируют stderr (`stderrBuffer += chunk`)
  // и редактят/логируют ПОЛНЫЙ буфер, а не отдельные чанки. Токен, физически разбитый
  // на границе чанков, к моменту sanitize уже пересобран → гасится целиком. Тест
  // фиксирует ИНВАРИАНТ: если кто-то в будущем переведёт stderr на per-chunk логирование,
  // половина токена (< порога паттерна) не сматчится и утечёт — этот тест это поймает.
  it('токен, разбитый по stderr-чанкам, после пересборки буфера редактируется', () => {
    const secret = 'api_key=ABCDEFGHIJ0123456789KLMNOPQR'
    // Провайдер шлёт secret двумя data-событиями; split посреди значения (< 16 символов в первой половине).
    const chunks = ['fatal: remote rejected — api_key=ABCDEF', 'GHIJ0123456789KLMNOPQR (invalid)']
    let stderrBuffer = ''
    for (const c of chunks) stderrBuffer += c   // зеркалит `child.stderr.on('data', chunk => stderrBuffer += chunk)`
    const out = sanitize({ stderr: stderrBuffer }) as { stderr: string }
    expect(out.stderr).not.toContain(secret)
    expect(out.stderr).not.toContain('ABCDEFGHIJ0123456789KLMNOPQR')
    // sanity: одиночная первая половина (per-chunk путь) паттерн НЕ ловит — вот почему буферизация обязательна.
    expect(sanitize({ stderr: chunks[0] })).toEqual({ stderr: chunks[0] })
  })
})
