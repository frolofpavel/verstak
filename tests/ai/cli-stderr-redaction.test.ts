// Сырой stderr дочернего CLI, который доходит ЧЕЛОВЕКУ НА ЭКРАН (29.07).
//
// Четыре CLI-провайдера кладут хвост stderr в пользовательскую ошибку — и это
// правильно: часто это единственное объяснение, почему бинарь не запустился.
// Убирать нельзя, нужен ОЧИЩЕННЫЙ хвост, а не его отсутствие.
//
// ГЛАВНОЕ ПРЕДОСТЕРЕЖЕНИЕ ПОСТАНОВЩИКА, и оно не про код: решение НЕ переносится
// по аналогии с чанком Gemini. Там был JSON со значением, похожим на ключ. Здесь
// форма другая — командные строки с флагами, куски окружения, пути. Поэтому
// первый блок ниже не проверяет провайдеров вовсе: он выясняет, что `scanText`
// на таком материале РЕАЛЬНО гасит, а что проходит насквозь. Ответ на этот
// вопрос — часть работы, а не предположение.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStderrTail, CLI_STDERR_LIMIT } from '../../electron/ai/cli-stderr'

const ROOT = process.cwd()

// ─────────────────────────────────────────────────────────────────────────────
// БЛОК 1: что сканер действительно гасит на материале ИМЕННО ЭТОЙ формы.
// ─────────────────────────────────────────────────────────────────────────────
const REDACTED = [
  {
    what: 'флаг с ключом в строке запуска',
    stderr: 'Error: spawn failed\n  cmd: claude --print --api-key sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH --model x',
    secret: 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH',
  },
  {
    what: 'дамп окружения с ключом Anthropic',
    stderr: 'env:\n  ANTHROPIC_API_KEY=sk-ant-api03-ZZZZYYYYXXXXWWWWVVVVUUUUTTTTSSSS\n  PATH=/usr/bin',
    secret: 'sk-ant-api03-ZZZZYYYYXXXXWWWWVVVVUUUUTTTTSSSS',
  },
  {
    what: 'ключ OpenAI в окружении',
    stderr: 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345\nnode: command failed',
    secret: 'sk-proj-abcdefghijklmnopqrstuvwxyz012345',
  },
  {
    what: 'ключ Google в окружении',
    stderr: 'GEMINI_API_KEY=AIza' + 'C'.repeat(35) + '\nfailed to start',
    secret: 'AIza' + 'C'.repeat(35),
  },
  {
    what: 'токен GitHub во флаге',
    stderr: 'git push --token ghp_' + 'a'.repeat(36) + ' origin main\nfatal: auth failed',
    secret: 'ghp_' + 'a'.repeat(36),
  },
  {
    what: 'пароль в URL',
    stderr: 'fatal: unable to access https://pavel:s3cretPassw0rd@git.example.com/repo.git/',
    secret: 's3cretPassw0rd',
  },
  {
    what: 'Bearer-токен в заголовке',
    stderr: 'request headers: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    secret: 'eyJhbGciOiJIUzI1NiJ9',
  },
]

describe('scanText на материале stderr: что гасится', () => {
  for (const c of REDACTED) {
    it(`${c.what} — не доходит до человека`, () => {
      const tail = safeStderrTail(c.stderr)
      expect(tail, `секрет уцелел: ${c.what}`).not.toContain(c.secret)
      expect(tail, 'следа очистки нет').toContain('[REDACTED')
    })
  }

  // КОНТРОЛЬ: обычный stderr без секретов доходит ДОСЛОВНО. Без этого пина
  // «очисткой» могло бы стать вымарывание всего подряд, и человек лишился бы
  // единственного объяснения, зачем этот хвост вообще показывают.
  it('обычная диагностика доходит дословно', () => {
    const plain = 'Error: spawn claude ENOENT\n  at ChildProcess.handle (node:internal/child_process:289:12)'
    expect(safeStderrTail(plain)).toBe(plain)
  })

  it('пустой буфер даёт пустую строку, а не «undefined»', () => {
    expect(safeStderrTail('')).toBe('')
    expect(safeStderrTail(null)).toBe('')
    expect(safeStderrTail(undefined)).toBe('')
  })
})

// ГРАНИЦА СКАНЕРА, ЗАФИКСИРОВАННАЯ КАК ЕСТЬ. Постановщик прямо запретил
// дописывать паттерны в этом коммите: сканер уже даёт ложные срабатывания
// (13 файлов из 566 исходников считаются «содержащими секрет»), и любое
// расширение их умножит. Поэтому формы, которые проходят насквозь, здесь не
// «чинятся», а ОБЪЯВЛЯЮТСЯ — чтобы никто не считал очистку полной.
//
// Если однажды сканер научится их узнавать, этот блок покраснеет. Это не
// регрессия, а сигнал: границу можно переписать, и вместе с ней — отчёт.
describe('чего сканер на stderr НЕ ловит — объявлено, а не спрятано', () => {
  it('опаковый секрет в ИМЕНИ ПУТИ проходит насквозь', () => {
    const stderr = String.raw`ENOENT: C:\Users\Pavel\.codex\auth-9f8a7b6c5d4e3f2a1b0c.json not found`
    expect(safeStderrTail(stderr)).toContain('9f8a7b6c5d4e3f2a1b0c')
  })

  it('переменная окружения с НЕизвестным сканеру именем проходит насквозь', () => {
    const stderr = 'env: VERSTAK_RELAY_SECRET=9f8a7b6c5d4e3f2a1b0c7d8e'
    expect(safeStderrTail(stderr)).toContain('9f8a7b6c5d4e3f2a1b0c7d8e')
  })

  // Контроль к границе: соседняя форма с ИЗВЕСТНЫМ именем гасится. Значит дело
  // именно в словаре имён, а не в том, что сканер не работает на окружении.
  it('контроль: та же форма с известным именем гасится', () => {
    expect(safeStderrTail('env: API_KEY=9f8a7b6c5d4e3f2a1b0c7d8e')).toContain('[REDACTED')
  })
})

// ПОРЯДОК «сначала чистим, потом режем» — не стилистика. Редакция УДЛИНЯЕТ
// текст, поэтому обратный порядок оставляет секрет разрезанным ровно на границе:
// половина уходит человеку, и сканер её уже не узнаёт.
describe('порядок обработки: чистим весь буфер, режем очищенный', () => {
  it('секрет у самой границы обрезки не переживает очистку', () => {
    const secret = 'sk-ant-api03-' + 'Q'.repeat(32)
    const stderr = 'x'.repeat(CLI_STDERR_LIMIT - 20) + ' --api-key ' + secret + ' tail'

    const tail = safeStderrTail(stderr)

    expect(tail).not.toContain(secret)
    expect(tail, 'даже обрывок ключа не должен доехать').not.toContain(secret.slice(0, 20))
  })

  it('длина хвоста соблюдается', () => {
    expect(safeStderrTail('y'.repeat(1000)).length).toBe(CLI_STDERR_LIMIT)
    expect(safeStderrTail('y'.repeat(1000), 50).length).toBe(50)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// БЛОК 2: все ПЯТЬ пользовательских мест в ЧЕТЫРЁХ файлах идут через хелпер.
// По одному `it` на файл — до правки каждый краснеет ОТДЕЛЬНО, а не «первый за
// всех»: это и есть доказательство по каждой строке таблицы.
// ─────────────────────────────────────────────────────────────────────────────
const PROVIDERS = [
  { file: 'electron/ai/claude-cli.ts', name: 'Claude Code' },
  { file: 'electron/ai/codex-cli.ts', name: 'Codex CLI' },
  { file: 'electron/ai/gemini-cli.ts', name: 'Gemini CLI' },
  { file: 'electron/ai/grok-cli.ts', name: 'Grok CLI' },
]

/** Строки, где сырой буфер уходит в СООБЩЕНИЕ пользователю. */
function rawUserFacing(file: string): string[] {
  const src = readFileSync(join(ROOT, file), 'utf8')
  return src.split(/\r?\n/)
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => /stderrBuffer\.slice\(/.test(line) && !/logRuntime|stderr:\s*stderrBuffer/.test(line))
    .map(({ line, no }) => `${file}:${no} ${line.trim()}`)
}

describe('пользовательская ошибка CLI не несёт сырой stderr', () => {
  for (const p of PROVIDERS) {
    it(`${p.name}: сырой буфер в сообщение не попадает`, () => {
      expect(rawUserFacing(p.file), 'сырой stderr уходит человеку мимо scanText').toEqual([])
    })
  }

  it('каждый провайдер действительно показывает хвост — диагностика не выброшена', () => {
    for (const p of PROVIDERS) {
      const src = readFileSync(join(ROOT, p.file), 'utf8')
      expect(src, `${p.name}: хвост stderr исчез вместе с дефектом`).toContain('safeStderrTail(')
    }
  })

  // КОНТРОЛЬ: сканер строк умеет находить нарушение — иначе пустой массив выше
  // означал бы лишь то, что искать он не умеет.
  it('контроль: прежняя форма строки распознаётся как нарушение', () => {
    const old = '            queue.push({ type: \'error\', message: `Claude CLI exit ${code}. ${stderrBuffer.slice(0, 400)}` })'
    expect(/stderrBuffer\.slice\(/.test(old)).toBe(true)
    expect(/logRuntime|stderr:\s*stderrBuffer/.test(old), 'строка ошибочно принята за лог').toBe(false)
  })
})
