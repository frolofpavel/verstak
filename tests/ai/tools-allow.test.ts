import { describe, it, expect, vi } from 'vitest'
// Распил 1.9.8: selectAllowedToolDefs вынесен в runner-util.
import { selectAllowedToolDefs } from '../../electron/ai/runner-util'

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
})
