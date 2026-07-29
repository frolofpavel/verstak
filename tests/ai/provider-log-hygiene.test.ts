// §8 регламента: весь текст, попадающий в логи, проходит через `scanText`.
//
// ЧТО ЭТО ЗАКРЫВАЕТ (29.07). В `electron/ai/gemini.ts` жила БЕЗУСЛОВНАЯ строка
// `console.error('[gemini chunk N]', dump.slice(0, 1500))` — до 1500 символов
// сырого ответа модели на первых трёх чанках КАЖДОГО запроса, и в dev, и в
// собранной сборке, мимо secret-scanner. Утечки никто не наблюдал, но правило
// обходилось на каждом запросе и обходилось МОЛЧА: строка выглядела как остаток
// ручной отладки, дописанный сбоку.
//
// Страж узкий СОЗНАТЕЛЬНО. Он не запрещает провайдерам логировать ошибки — в
// `electron/ai/` есть законные `console.error` с сообщением об исключении, и они
// должны жить. Запрещено ровно одно: печатать в лог СЕРИАЛИЗОВАННЫЙ ответ модели.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const AI_DIR = join(ROOT, 'electron', 'ai')

/** Признаки сырого ответа модели в аргументах печати. */
const RAW_MODEL_PAYLOAD = /\bdump\b|JSON\.stringify\(\s*(chunk|response|completion|delta|payload)\b/

function aiFiles(): string[] {
  return readdirSync(AI_DIR, { recursive: true, encoding: 'utf8' })
    .filter(p => p.endsWith('.ts'))
    .map(p => join(AI_DIR, p))
}

/** Строки вида «console.<что-то>(… сырой ответ модели …)». */
function offenders(): string[] {
  const found: string[] = []
  for (const file of aiFiles()) {
    const src = readFileSync(file, 'utf8')
    src.split(/\r?\n/).forEach((line, i) => {
      if (/console\.(log|error|warn|info|debug)\s*\(/.test(line) && RAW_MODEL_PAYLOAD.test(line)) {
        found.push(`${relative(ROOT, file).split(sep).join('/')}:${i + 1}`)
      }
    })
  }
  return found.sort()
}

describe('провайдеры не печатают сырой ответ модели в лог', () => {
  it('ни одной такой строки в electron/ai', () => {
    expect(offenders(), 'сырой ответ модели уходит в лог мимо scanText').toEqual([])
  })

  // КОНТРОЛЬ: без него первый пин зелёный и от «страж ничего не ищет».
  it('контроль: та самая удалённая строка была бы найдена', () => {
    const removed = "              console.error(`[gemini chunk ${chunkCount - 1}]`, dump.slice(0, 1500))"
    expect(/console\.(log|error|warn|info|debug)\s*\(/.test(removed)).toBe(true)
    expect(RAW_MODEL_PAYLOAD.test(removed), 'признак сырого ответа не сработал').toBe(true)
  })

  // КОНТРОЛЬ ВТОРОЙ СТОРОНЫ: законная диагностика ошибок остаётся разрешённой,
  // иначе страж заставил бы удалять полезное.
  it('контроль: обычный console.error с ошибкой не считается нарушением', () => {
    for (const ok of [
      "      console.error(`[commands] load ${filePath} failed:`, err)",
      "        console.error('[lsp-nav]', opts.kind, opts.symbol, 'pos=', JSON.stringify(pos), 'locs=', locs.length)",
    ]) {
      expect(RAW_MODEL_PAYLOAD.test(ok), ok).toBe(false)
    }
  })

  it('сканер действительно читает файлы провайдеров', () => {
    const files = aiFiles().map(f => relative(ROOT, f).split(sep).join('/'))
    expect(files).toContain('electron/ai/gemini.ts')
    expect(files.length).toBeGreaterThan(20)
  })
})

// Диагностика «все чанки пустые» осталась на месте: дамп по-прежнему копится в
// ПАМЯТЬ (sampleChunks) и используется ниже по коду. Удалена была только печать.
describe('диагностика пустого потока не потеряна', () => {
  const src = readFileSync(join(AI_DIR, 'gemini.ts'), 'utf8')

  it('накопитель сэмплов на месте и кем-то читается', () => {
    expect(src).toContain('sampleChunks.push(')
    expect(src, 'накопитель есть, а потребителя нет — значит он мёртвый').toMatch(/sampleChunks\[0\]/)
  })
})
