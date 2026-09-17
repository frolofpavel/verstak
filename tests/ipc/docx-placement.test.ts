// ЗАДАЧА 2, пункт 1 (05.08): DOCX кладётся ТУДА, ГДЕ ЧЕЛОВЕК НАЙДЁТ.
//
// Дефект (01.08): человек выбрал папку, попросил «собери отчёт», файл упал в
// .verstak/artifacts/{дата} — каталог, который не-разработчик не найдёт никогда,
// и модель копировала его вторым действием. Причина — модель НЕ передала save_to,
// свалилась в дефолт 'project'. Пломбировка save_to существовала, не хватало
// ДЕФОЛТА на молчание модели.
//
// Правило (штаб): папка→alongside (корень выбранной папки), вложения→downloads
// (Загрузки знает каждый), без материалов→project (прежнее). Явный save_to модели
// перекрывает дефолт ВСЕГДА — это остаётся за моделью, дефолт лишь заполняет пустоту.
//
// Третий пин — КОНТРОЛЬНЫЙ: без него первые два зелены и в том случае, когда дефолт
// затирает явное решение модели, то есть не измеряют ничего.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { generateDocxHandler } from '../../electron/ipc/tool-handlers/artifacts'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { ToolCall, ToolResult } from '../../electron/ai/types'

function ctx(over: Partial<ToolContext>): ToolContext {
  return { sender: { send: vi.fn() }, sendId: 1, recordJournal: vi.fn(), ...over } as unknown as ToolContext
}
const call = (args: Record<string, unknown>): ToolCall => ({ id: 'c1', name: 'generate_docx', args })
const SECTIONS = [{ heading: 'Выводы', paragraphs: ['текст'] }]

/** Путь сохранённого файла из строки результата (её же читает модель). */
function savedPath(res: ToolResult): string {
  if (res.error) throw new Error('handler error: ' + res.error)
  const m = /DOCX artifact saved: (.+)/.exec(typeof res.result === 'string' ? res.result : '')
  if (!m) throw new Error('в результате нет пути: ' + JSON.stringify(res.result))
  return m[1].trim()
}

describe('generate_docx: дефолт места — «туда, где человек найдёт» (задача 2)', () => {
  let project: string
  let downloads: string
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'gg-proj-'))
    downloads = mkdtempSync(join(tmpdir(), 'gg-dl-'))
  })
  afterEach(() => {
    rmSync(project, { recursive: true, force: true })
    rmSync(downloads, { recursive: true, force: true })
  })

  it('материалы ПАПКОЙ + модель молчит → alongside (корень папки), не .verstak', async () => {
    const res = await generateDocxHandler.handle(
      call({ filename: 'отчёт', sections: SECTIONS }),
      ctx({ projectPath: project, defaultDocxSaveTo: 'alongside', artifactsDownloadsDir: downloads }),
    )
    const p = savedPath(res)
    expect(dirname(p)).toBe(project)
    expect(existsSync(p)).toBe(true)
  })

  it('материалы ВЛОЖЕНИЯМИ + модель молчит → downloads (Загрузки)', async () => {
    const res = await generateDocxHandler.handle(
      call({ filename: 'отчёт', sections: SECTIONS }),
      ctx({ projectPath: project, defaultDocxSaveTo: 'downloads', artifactsDownloadsDir: downloads }),
    )
    const p = savedPath(res)
    expect(dirname(p)).toBe(downloads)
    expect(existsSync(p)).toBe(true)
  })

  it('КОНТРОЛЬ: явный save_to=downloads модели при папке → Загрузки, дефолт alongside НЕ перекрывает', async () => {
    const res = await generateDocxHandler.handle(
      call({ filename: 'отчёт', sections: SECTIONS, save_to: 'downloads' }),
      ctx({ projectPath: project, defaultDocxSaveTo: 'alongside', artifactsDownloadsDir: downloads }),
    )
    expect(dirname(savedPath(res))).toBe(downloads)
  })

  it('КОНТРОЛЬ: без материалов (дефолт undefined) → прежний .verstak/artifacts, поведение не тронуто', async () => {
    const res = await generateDocxHandler.handle(
      call({ filename: 'отчёт', sections: SECTIONS }),
      ctx({ projectPath: project, defaultDocxSaveTo: undefined, artifactsDownloadsDir: downloads }),
    )
    expect(savedPath(res).startsWith(join(project, '.verstak', 'artifacts'))).toBe(true)
  })

  it('R3 browser handoff не позволяет модели вынести artifact из task dir', async () => {
    const res = await generateDocxHandler.handle(
      call({ filename: 'отчёт', sections: SECTIONS, save_to: 'downloads' }),
      ctx({
        projectPath: project, artifactsDownloadsDir: downloads, runId: 'run-r3', browserTaskId: 'bt-r3',
        browserRunState: {
          active: true, contextExposed: true, r3HandoffAllowed: true,
          r3Handoff: {
            version: 1, browserTaskId: 'bt-r3', runId: 'run-r3', phase: 'browser-ready',
            checkpoint: { version: 1, goal: 'browser-to-artifact-to-computer', constraints: [], confirmedActions: [], environment: { source: null, account: null, period: null, rowCount: null, sourceChecksum: 'sha256:x' }, pendingApproval: null, resultRefs: [] },
          },
        },
        appendBrowserArtifactProof: vi.fn(),
        persistR3HandoffCheckpoint: vi.fn(),
      } as any),
    )
    expect(res.error).toMatch(/task dir|project/i)
    expect(existsSync(join(downloads, 'отчёт.docx'))).toBe(false)
  })

  it('R3 successful artifact emits proof + durable checkpoint callbacks from actual handler', async () => {
    const appendBrowserArtifactProof = vi.fn()
    const persistR3HandoffCheckpoint = vi.fn()
    const handoff = {
      version: 1 as const, browserTaskId: 'bt-r3', runId: 'run-r3', phase: 'browser-ready' as const,
      checkpoint: {
        version: 1 as const, goal: 'browser-to-artifact-to-computer' as const, constraints: ['no-replay'], confirmedActions: ['browser_read_page'],
        environment: { source: 'https://example.test/report', account: 'cab-7', period: '2026-09', rowCount: 1, sourceChecksum: 'sha256:source' },
        pendingApproval: null, resultRefs: [],
      },
    }
    const res = await generateDocxHandler.handle(
      call({ filename: 'отчёт-r3', sections: [{ paragraphs: ['итог'], table: { rows: [['a']] } }] }),
      ctx({
        projectPath: project, runId: 'run-r3', browserTaskId: 'bt-r3',
        browserRunState: { active: true, contextExposed: true, r3HandoffAllowed: true, r3Handoff: handoff },
        appendBrowserArtifactProof, persistR3HandoffCheckpoint,
      } as any),
    )
    expect(res.error).toBeUndefined()
    expect(String(res.result)).toContain('[VERSTAK_R3_HANDOFF_V1]')
    expect(appendBrowserArtifactProof).toHaveBeenCalledWith(expect.objectContaining({
      browserTaskId: 'bt-r3', runId: 'run-r3', rowCount: 1,
      checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    }))
    expect(persistR3HandoffCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ phase: 'artifact-ready' }))
    expect(savedPath(res).startsWith(join(project, '.verstak', 'artifacts'))).toBe(true)
  })

  it('§3.1 видимый след: строка активности называет ПОЛНЫЙ ПУТЬ (не только имя)', async () => {
    const sender = { send: vi.fn(), exec: vi.fn(async () => undefined) }
    await generateDocxHandler.handle(
      call({ filename: 'отчёт', sections: SECTIONS }),
      ctx({ projectPath: project, defaultDocxSaveTo: 'alongside', sender }),
    )
    const activity = sender.send.mock.calls
      .map(c => c[1])
      .find((e: { event?: { type?: string } }) => e?.event?.type === 'tool-activity') as { event: { detail: string } } | undefined
    expect(activity, 'tool-activity должно эмититься').toBeTruthy()
    expect(activity!.event.detail).toContain(join(project, 'отчёт.docx'))
  })
})
