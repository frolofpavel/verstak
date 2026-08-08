import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { generateDocxHandler, generateHtmlHandler, renderChartHandler } from '../../electron/ipc/tool-handlers/artifacts'
import { createProofVideoHandler } from '../../electron/ipc/tool-handlers/create-proof-video'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { AgentMode } from '../../electron/ai/mode-policy'

// СЕДЬМОЙ ОБХОД ГЕЙТА (08.08): артефакты ПИШУТ ФАЙЛ на диск, но хендлеры не звали
// resolveDecision → проходили во ВСЕХ режимах, включая plan («ничего не менять»). Здесь
// пин на ЭНФОРСМЕНТ в самом хендлере (не только decide()): в plan — блок, вне — проходит.
let projectPath: string
beforeAll(async () => { projectPath = await mkdtemp(join(tmpdir(), 'gg-artifact-gate-')) })
afterAll(async () => { await rm(projectPath, { recursive: true, force: true }) })

function ctx(mode: AgentMode): ToolContext {
  return {
    agentMode: mode, projectPath,
    sender: { send: () => {} },
    recordJournal: () => {},
    // permissionRules не задаём (undefined = нет пользовательских правил) — гейт решает
    // по одному режиму, как в проде при отсутствии правил.
  } as unknown as ToolContext
}

const calls = {
  generate_docx: { id: 'd1', name: 'generate_docx', args: { filename: 'r', sections: [{ heading: 'H', paragraphs: ['p'] }] } },
  generate_html: { id: 'h1', name: 'generate_html', args: { filename: 'r', content_html: '<p>x</p>' } },
  render_chart: { id: 'c1', name: 'render_chart', args: { filename: 'r', kind: 'bar', labels: ['a'], values: [1] } },
} as const

describe('артефакты: гейт режима в ХЕНДЛЕРЕ (седьмой обход закрыт)', () => {
  const handlers = {
    generate_docx: generateDocxHandler,
    generate_html: generateHtmlHandler,
    render_chart: renderChartHandler,
  } as const

  for (const name of ['generate_docx', 'generate_html', 'render_chart'] as const) {
    it(`${name} в plan → БЛОКИРОВАН (файл не создаётся)`, async () => {
      const res = await handlers[name].handle(calls[name] as never, ctx('plan'))
      expect(res.error).toBeTruthy()
      expect(String(res.error)).toContain('планирования')
    })
    it(`${name} в auto → проходит гейт (не заблокирован)`, async () => {
      const res = await handlers[name].handle(calls[name] as never, ctx('auto'))
      expect(res.error).toBeFalsy()
    })
  }

  // create_proof_video — то же семейство (пишет MP4), но в auto без кадров падает на
  // «нет кадров», а не пишет. Поэтому проверяем: plan → блок гейта (про планирование);
  // auto → гейт ПРОЙДЕН (ошибка НЕ про планирование, а про кадры/сборку).
  const pv = { id: 'v1', name: 'create_proof_video', args: {} }
  it('create_proof_video в plan → БЛОКИРОВАН гейтом (про планирование)', async () => {
    const res = await createProofVideoHandler.handle(pv as never, ctx('plan'))
    expect(res.error).toBeTruthy()
    expect(String(res.error)).toContain('планирования')
  })
  it('create_proof_video в auto → гейт пройден (ошибка не про планирование)', async () => {
    const res = await createProofVideoHandler.handle(pv as never, ctx('auto'))
    expect(String(res.error ?? '')).not.toContain('планирования')
  })
})
