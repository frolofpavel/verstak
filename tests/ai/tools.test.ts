import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createFileTools } from '../../electron/ai/tools'

describe('file tools', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gg-'))
    writeFileSync(join(root, 'README.md'), '# Test')
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'index.ts'), 'export {}')
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('read_file returns file contents', async () => {
    const tools = createFileTools(root)
    const result = await tools.execute('read_file', { path: 'README.md' })
    expect(result).toBe('# Test')
  })

  it('list_directory returns entries', async () => {
    const tools = createFileTools(root)
    const result = await tools.execute('list_directory', { path: '.' }) as string[]
    expect(result).toContain('README.md')
    expect(result).toContain('src/')
  })

  it('rejects path traversal', async () => {
    const tools = createFileTools(root)
    await expect(tools.execute('read_file', { path: '../../../etc/passwd' })).rejects.toThrow()
  })

  // Регрессия: длинный русский вывод не должен превращаться в мойибейк.
  // Баг был в per-chunk chunk.toString(): многобайтовый UTF-8 символ,
  // разорванный на границе пайп-чанка, декодировался половинками и давал
  // символы-замены (U+FFFD). setEncoding('utf8') буферизует хвост через
  // StringDecoder. Выводим программой (а не cmd-builtin echo) на UTF-8 stdout.
  it('runCommand preserves long Cyrillic output across chunk boundaries', async () => {
    const tools = createFileTools(root)
    const script = join(root, 'cyr.js')
    writeFileSync(script, 'process.stdout.write("Привет мир ".repeat(20000))')
    const { stdout } = await tools.runCommand('node cyr.js')
    expect(stdout).not.toContain('�')
    expect(stdout).toContain('Привет мир')
  })
})
