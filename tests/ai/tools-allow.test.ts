import { describe, it, expect, vi } from 'vitest'
// Распил 1.9.8: selectAllowedToolDefs вынесен в runner-util.
import { selectAllowedToolDefs, resolveToolsAllowSet } from '../../electron/ai/runner-util'

/**
 * Аудит M4: tools_allow скилла должен реально ограничивать инструменты модели —
 * read-only скилл физически не получает write_file/run_command. До фикса
 * tools_allow нигде не применялся (вся модель безопасности скиллов фиктивна).
 */

type Def = { name: string }
const BASE: Def[] = [
  { name: 'read_file' },
  { name: 'search_project' },
  { name: 'get_project_map' },
  { name: 'connector_query' },
  { name: 'write_file' },
  { name: 'run_command' },
  { name: 'apply_patch' }
]
const MCP: Def[] = [{ name: 'mcp_fetch' }, { name: 'mcp_db_query' }]

describe('selectAllowedToolDefs (M4 — enforce skill tools_allow)', () => {
  it('без tools_allow отдаёт все инструменты (стандартные + MCP)', () => {
    const r = selectAllowedToolDefs(BASE, MCP, undefined)
    expect(r.map(d => d.name)).toEqual([...BASE, ...MCP].map(d => d.name))
    const r2 = selectAllowedToolDefs(BASE, MCP, [])
    expect(r2).toHaveLength(BASE.length + MCP.length)
  })

  it('read-only скилл: write_file/run_command/apply_patch недоступны', () => {
    const allow = ['read_file', 'search_project', 'get_project_map', 'connector_query']
    const names = selectAllowedToolDefs(BASE, MCP, allow).map(d => d.name)
    expect(names).toContain('read_file')
    expect(names).toContain('connector_query')
    expect(names).not.toContain('write_file')
    expect(names).not.toContain('run_command')
    expect(names).not.toContain('apply_patch')
  })

  it('MCP-инструменты тоже фильтруются по tools_allow', () => {
    const names = selectAllowedToolDefs(BASE, MCP, ['read_file', 'mcp_fetch']).map(d => d.name)
    expect(names).toEqual(['read_file', 'mcp_fetch'])
    expect(names).not.toContain('mcp_db_query')
  })

  it('все имена — опечатки: fail-open (полный набор) + предупреждение', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const names = selectAllowedToolDefs(BASE, MCP, ['raed_file', 'нет_такого']).map(d => d.name)
    // broken-скилл не должен стать молчаливым кирпичом — отдаём всё.
    expect(names).toEqual([...BASE, ...MCP].map(d => d.name))
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('частичное совпадение строго ограничивает (валидные имена + опечатка)', () => {
    const names = selectAllowedToolDefs(BASE, MCP, ['read_file', 'опечатка']).map(d => d.name)
    expect(names).toEqual(['read_file'])
  })

  it('mcp-only скилл: совпали только MCP — base НЕ восстанавливается (не fail-open)', () => {
    const names = selectAllowedToolDefs(BASE, MCP, ['mcp_fetch']).map(d => d.name)
    expect(names).toEqual(['mcp_fetch'])
    expect(names).not.toContain('write_file') // ключевое: ограничение держится
  })

  it('псевдо-имена раскрываются только в нужные реальные инструменты', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const names = selectAllowedToolDefs(BASE, MCP, [
      'yandex_wordstat',
      'connector_query',
      'files',
    ]).map(d => d.name)
    expect(names).toEqual(['read_file', 'search_project', 'get_project_map', 'connector_query'])
    expect(names).toContain('read_file')
    expect(names).not.toContain('write_file')
    expect(names).not.toContain('run_command')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

// Общий предикат tools_allow — ОДИН источник для фильтра списка И для гейта диспетчера
// (аудит 09.08). Две копии этой логики разъехались бы: инструмент, который фильтр не
// показал, гейт бы пропустил. Здесь пиним сам предикат.
describe('resolveToolsAllowSet — общий предикат (фильтр + гейт диспетчера)', () => {
  const baseNames = BASE.map(d => d.name)
  const mcpNames = MCP.map(d => d.name)

  it('нет tools_allow → allowed=null (ограничения нет), fail-open=false', () => {
    expect(resolveToolsAllowSet(null, baseNames, mcpNames)).toMatchObject({ allowed: null, unmatchedFailOpen: false })
    expect(resolveToolsAllowSet([], baseNames, mcpNames)).toMatchObject({ allowed: null, unmatchedFailOpen: false })
  })

  it('read-only набор → allowed содержит read_file, НЕ содержит write_file/run_command', () => {
    const { allowed, unmatchedFailOpen } = resolveToolsAllowSet(['read_file', 'search_project'], baseNames, mcpNames)
    expect(unmatchedFailOpen).toBe(false)
    expect(allowed?.has('read_file')).toBe(true)
    expect(allowed?.has('write_file')).toBe(false)
    expect(allowed?.has('run_command')).toBe(false)
  })

  it('все имена — опечатки → allowed=null И unmatchedFailOpen=true (это и есть СЛЕД для журнала)', () => {
    const { allowed, unmatchedFailOpen } = resolveToolsAllowSet(['raed_file', 'нет_такого'], baseNames, mcpNames)
    expect(allowed).toBeNull()
    expect(unmatchedFailOpen).toBe(true)   // без этого флага runner-api не оставит след
  })

  it('частичное совпадение → строго ограничивает, fail-open=false (не тихое снятие)', () => {
    const { allowed, unmatchedFailOpen } = resolveToolsAllowSet(['read_file', 'опечатка'], baseNames, mcpNames)
    expect(unmatchedFailOpen).toBe(false)
    expect(allowed?.has('read_file')).toBe(true)
    expect(allowed?.has('write_file')).toBe(false)
  })

  it('псевдо-имя shell → run_command в наборе; files → read-набор', () => {
    const shell = resolveToolsAllowSet(['shell'], baseNames, mcpNames)
    expect(shell.allowed?.has('run_command')).toBe(true)
    expect(shell.pseudoNames).toContain('shell')
    const files = resolveToolsAllowSet(['files'], baseNames, mcpNames)
    expect(files.allowed?.has('read_file')).toBe(true)
    expect(files.allowed?.has('write_file')).toBe(false)
  })
})
