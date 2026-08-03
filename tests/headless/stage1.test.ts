import { describe, it, expect, vi } from 'vitest'

// Allowlist Этапа 1 (блок №5). Анти-дрейф: каждая запись обязана существовать в живых
// TOOL_DEFS — иначе переименование инструмента в десктопе молча превратит запись в
// мёртвую, а инструмент выпадет с сервера без следа (класс «ложная зелень» §3.1).
vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron' (headless Node)")
})

const { STAGE1_TOOLS_ALLOW, STAGE1_CONNECTOR_DENY } = await import('../../electron/headless/stage1')
const { TOOL_DEFS } = await import('../../electron/ai/tools')

describe('Этап 1 — allowlist инструментов', () => {
  const liveNames = new Set(TOOL_DEFS.map(d => d.name))

  it('каждая запись allowlist существует в TOOL_DEFS (нет мёртвых записей)', () => {
    const dead = STAGE1_TOOLS_ALLOW.filter(n => !liveNames.has(n))
    expect(dead).toEqual([])
  })

  it('shell/браузер/мультиагент/экран/код НЕ входят в allowlist (граница Этапа 1)', () => {
    const banned = [
      'run_command', 'run_until_green', 'spawn_process', 'process_status', 'read_process', 'stop_process',
      'dev_server', 'execute_code', 'screen_capture', 'screen_info',
      'delegate_task', 'delegate_parallel', 'orchestrate', 'swarm', 'oracle', 'new_task',
      'review_diff', 'review_before_commit', 'create_proof_video',
      'check_diagnostics', 'impact_analysis', 'find_definition', 'find_references'
    ]
    for (const name of banned) expect(STAGE1_TOOLS_ALLOW).not.toContain(name)
    expect(STAGE1_TOOLS_ALLOW.some(n => n.startsWith('browser_'))).toBe(false)
  })

  it('ядро Этапа 1 на месте: веб, коннекторы, артефакты, файлы workspace', () => {
    for (const name of ['web_fetch', 'web_search', 'list_connectors', 'connector_query',
      'render_chart', 'generate_html', 'generate_docx', 'read_file', 'write_file', 'apply_patch']) {
      expect(STAGE1_TOOLS_ALLOW).toContain(name)
    }
  })

  it('ssh в deny-списке коннекторов', () => {
    expect(STAGE1_CONNECTOR_DENY.has('ssh')).toBe(true)
  })
})
