import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Запрос №4 Этапа 1б: выдача файлов задачи — работа ядра, с ТЕМ ЖЕ гейтом пути, что
// у инструментов агента (safeRealJoin + secret-scanner), а не отдельной проверкой в
// прод-слое. Мок electron кидает: модуль обязан жить в чистом Node.
vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron' (headless Node)")
})

const { listWorkspaceFiles, resolveArtifactPath } = await import('../../electron/headless/artifacts')

describe('артефакты задачи — гейт пути (запрос №4)', () => {
  let ws: string
  let outside: string

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'vsk-art-ws-'))
    outside = mkdtempSync(join(tmpdir(), 'vsk-art-out-'))
    mkdirSync(join(ws, '.verstak', 'artifacts', '2026-08-04'), { recursive: true })
    writeFileSync(join(ws, '.verstak', 'artifacts', '2026-08-04', 'otchet.docx'), 'DOCX')
    writeFileSync(join(ws, 'notes.md'), '# заметки')
    writeFileSync(join(outside, 'host-secret.txt'), 'SECRET_HOST_DATA')
  })
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('список отдаёт файлы workspace относительными путями через слэш', () => {
    const files = listWorkspaceFiles(ws)
    const paths = files.map(f => f.path).sort()
    expect(paths).toContain('notes.md')
    expect(paths).toContain('.verstak/artifacts/2026-08-04/otchet.docx')
    expect(files.find(f => f.path === 'notes.md')?.size).toBeGreaterThan(0)
  })

  it('секрето-подобные файлы не показываются даже списком', () => {
    writeFileSync(join(ws, '.env'), 'API_KEY=leak')
    const paths = listWorkspaceFiles(ws).map(f => f.path)
    expect(paths).not.toContain('.env')
    // Контрольный кейс: обычные файлы на месте — фильтр не выкосил всё подряд.
    expect(paths).toContain('notes.md')
  })

  it('обычный файл внутри workspace резолвится', async () => {
    const abs = await resolveArtifactPath(ws, '.verstak/artifacts/2026-08-04/otchet.docx')
    expect(abs).toBeTruthy()
    expect(abs).toContain('otchet.docx')
  })

  it('выход за workspace через .. → отказ', async () => {
    expect(await resolveArtifactPath(ws, '../' + join(outside, 'host-secret.txt').split(/[\\/]/).pop())).toBeNull()
    expect(await resolveArtifactPath(ws, '../../etc/passwd')).toBeNull()
  })

  it('абсолютный путь наружу → отказ', async () => {
    expect(await resolveArtifactPath(ws, join(outside, 'host-secret.txt'))).toBeNull()
  })

  it('symlink изнутри workspace наружу НЕ обходит гейт', async () => {
    try {
      symlinkSync(outside, join(ws, 'link-out'), 'junction')
    } catch {
      return // без прав на symlink кейс недоступен; текстовый выход покрыт выше
    }
    expect(await resolveArtifactPath(ws, 'link-out/host-secret.txt')).toBeNull()
  })

  it('секрето-файл внутри workspace не выдаётся по прямому пути', async () => {
    writeFileSync(join(ws, '.env'), 'API_KEY=leak')
    expect(await resolveArtifactPath(ws, '.env')).toBeNull()
  })

  it('несуществующий файл → отказ (safeRealJoin сам по себе его пропускает)', async () => {
    // Важный кейс: safeRealJoin рассчитан и на запись, поэтому для ENOENT он ВОЗВРАЩАЕТ
    // путь. Без явной проверки существования ручка отдавала бы 200 на пустоту.
    expect(await resolveArtifactPath(ws, 'nope.docx')).toBeNull()
  })

  it('каталог вместо файла → отказ', async () => {
    expect(await resolveArtifactPath(ws, '.verstak')).toBeNull()
  })
})
