import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createFileTools, createSshFileTools } from '../../electron/ai/tools'

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

// Безопасность (ревью): SSH-ветка файл-тулзов обходила isForbiddenPath, который
// есть в локальной — секреты внутри remote-дерева утекали/перезаписывались.
describe('createSshFileTools — isForbiddenPath guard (security)', () => {
  function makeBackend() {
    return {
      readFile: vi.fn(async () => 'SECRET_CONTENT'),
      writeFile: vi.fn(async () => {}),
      listDir: vi.fn(async () => ['.env', 'src/', 'creds.json', 'app.ts', 'config.key']),
      runCommand: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    }
  }
  it('read_file на секретном пути бросает, backend.readFile НЕ вызывается', async () => {
    const b = makeBackend(); const t = createSshFileTools(b as never)
    await expect(t.execute('read_file', { path: '.env' })).rejects.toThrow(/политикой безопасности/)
    await expect(t.execute('read_file', { path: 'deploy/creds.json' })).rejects.toThrow()
    await expect(t.execute('read_file', { path: '.ssh/id_ed25519' })).rejects.toThrow()
    await expect(t.execute('read_file', { path: 'secret.key' })).rejects.toThrow()
    expect(b.readFile).not.toHaveBeenCalled()
  })
  it('write_file/apply_patch на секретном пути бросают, backend.writeFile НЕ вызывается', async () => {
    const b = makeBackend(); const t = createSshFileTools(b as never)
    await expect(t.execute('write_file', { path: '.env', content: 'x' })).rejects.toThrow(/запрещена политикой/)
    await expect(t.execute('apply_patch', { path: 'creds.json', diff: '' })).rejects.toThrow(/запрещена политикой/)
    expect(b.writeFile).not.toHaveBeenCalled()
  })
  it('list_directory прячет секретные имена', async () => {
    const b = makeBackend(); const t = createSshFileTools(b as never)
    const out = await t.execute('list_directory', { path: '.' }) as string[]
    expect(out).not.toContain('.env')
    expect(out).not.toContain('creds.json')
    expect(out).not.toContain('config.key')
    expect(out).toContain('app.ts')
    expect(out).toContain('src/')
  })
  it('обычный файл — читается и пишется без блокировки', async () => {
    const b = makeBackend(); const t = createSshFileTools(b as never)
    await t.execute('read_file', { path: 'src/app.ts' })
    expect(b.readFile).toHaveBeenCalled()
    await t.execute('write_file', { path: 'src/app.ts', content: 'x' })
    expect(b.writeFile).toHaveBeenCalled()
  })
})
