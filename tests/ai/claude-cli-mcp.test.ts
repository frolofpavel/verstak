import { describe, it, expect } from 'vitest'
import { buildClaudeMcpBridge } from '../../electron/ai/claude-cli-mcp'

// Формат установлен ФАКТОМ на установленном claude 2.1.220 (14.08), а не по памяти:
//   --mcp-config <configs...>  Load MCP servers from JSON files or strings
// Инлайн-строка принимается, `${VAR}` в значениях env раскрывается из окружения
// РОДИТЕЛЬСКОГО процесса — проверено зондом (сервер-заглушка получил значение
// внешней переменной, хотя в JSON стоял плейсхолдер). Отсюда вся конструкция:
// ключи живут в env дочернего процесса, в argv уходит только имя плейсхолдера.

const MOEX = {
  id: 'srv-1',
  name: 'Московская Биржа (MOEX)',
  command: 'npx',
  args: ['-y', 'moex-mcp'],
  env: {}
}

describe('buildClaudeMcpBridge — проброс серверов Verstak в claude CLI', () => {
  it('пустой список серверов → null (флага в командной строке нет вовсе)', () => {
    expect(buildClaudeMcpBridge([])).toBeNull()
  })

  it('передаёт конфиг ИНЛАЙНОМ, а не путём к файлу (ключам негде осесть на диске)', () => {
    const bridge = buildClaudeMcpBridge([MOEX])!
    expect(bridge.args).toHaveLength(2)
    expect(bridge.args[0]).toBe('--mcp-config')
    expect(bridge.args[1].startsWith('{')).toBe(true)
    const parsed = JSON.parse(bridge.args[1])
    expect(Object.keys(parsed.mcpServers)).toHaveLength(1)
  })

  it('command и args сервера доходят до CLI без изменений', () => {
    const bridge = buildClaudeMcpBridge([MOEX])!
    const entry = Object.values(JSON.parse(bridge.args[1]).mcpServers)[0] as Record<string, unknown>
    expect(entry.command).toBe('npx')
    expect(entry.args).toEqual(['-y', 'moex-mcp'])
  })

  it('SECURITY: значение ключа НЕ появляется в аргументах — только плейсхолдер', () => {
    const bridge = buildClaudeMcpBridge([{
      id: 'srv-2', name: 'Secret Server', command: 'npx', args: ['-y', 'x'],
      env: { API_KEY: 'sk-live-SUPER-SECRET-VALUE' }
    }])!
    const argvText = bridge.args.join(' ')
    expect(argvText).not.toContain('sk-live-SUPER-SECRET-VALUE')
    const entry = Object.values(JSON.parse(bridge.args[1]).mcpServers)[0] as { env: Record<string, string> }
    const placeholder = entry.env.API_KEY
    expect(placeholder).toMatch(/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/)
    // Реальное значение уходит в env дочернего процесса под именем плейсхолдера.
    const varName = placeholder.slice(2, -1)
    expect(bridge.env[varName]).toBe('sk-live-SUPER-SECRET-VALUE')
  })

  it('SECURITY: контрольный кейс — сервер БЕЗ env не заводит ни одной переменной', () => {
    // Зеркало к пину выше: без него «значения нет в argv» было бы зелено и тогда,
    // когда мост не передаёт env вовсе.
    const bridge = buildClaudeMcpBridge([MOEX])!
    expect(Object.keys(bridge.env)).toHaveLength(0)
  })

  it('SECURITY: мост не добавляет ни одного ослабляющего права флага', () => {
    const bridge = buildClaudeMcpBridge([MOEX])!
    for (const forbidden of ['--allowedTools', '--allowed-tools', '--dangerously-skip-permissions',
      '--allow-dangerously-skip-permissions', '--permission-mode', '--tools']) {
      expect(bridge.args, forbidden).not.toContain(forbidden)
    }
  })

  it('под shell:true JSON экранируется по конвенции cmd — иначе он туда не доезжает', () => {
    // Замер 14.08 (шим, печатающий argv): cmd.exe срезает внутренние кавычки, и
    // настоящий claude отвечает «MCP config file not found: {mcpServers:…}».
    const shellArg = buildClaudeMcpBridge([MOEX], true)!.args[1]
    expect(shellArg.startsWith('"')).toBe(true)
    expect(shellArg.endsWith('"')).toBe(true)
    // Снятие обёртки и удвоения возвращает ровно тот же JSON, что и без shell.
    const unwrapped = shellArg.slice(1, -1).replace(/""/g, '"')
    expect(unwrapped).toBe(buildClaudeMcpBridge([MOEX], false)!.args[1])
    expect(JSON.parse(unwrapped).mcpServers).toBeTruthy()
  })

  it('контрольный кейс: без shell экранирования НЕТ (иначе кавычки уехали бы в JSON)', () => {
    expect(buildClaudeMcpBridge([MOEX], false)!.args[1].startsWith('"')).toBe(false)
  })

  it('SECURITY: экранирование не выносит значение ключа в argv', () => {
    const bridge = buildClaudeMcpBridge([{
      id: 's', name: 'S', command: 'npx', args: [], env: { API_KEY: 'sk-live-SECRET' }
    }], true)!
    expect(bridge.args.join(' ')).not.toContain('sk-live-SECRET')
    expect(Object.values(bridge.env)).toContain('sk-live-SECRET')
  })

  it('имя сервера превращается в ascii-ключ (claude именует инструменты mcp__<ключ>__<tool>)', () => {
    const bridge = buildClaudeMcpBridge([MOEX])!
    const key = Object.keys(JSON.parse(bridge.args[1]).mcpServers)[0]
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(key).toContain('MOEX')
  })

  it('полностью не-ascii имя не даёт пустой ключ', () => {
    const bridge = buildClaudeMcpBridge([{ ...MOEX, name: 'Московская Биржа' }])!
    const key = Object.keys(JSON.parse(bridge.args[1]).mcpServers)[0]
    expect(key.length).toBeGreaterThan(0)
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('одинаковые имена не схлопываются в один сервер', () => {
    const bridge = buildClaudeMcpBridge([
      { id: 'a', name: 'Files', command: 'npx', args: ['a'], env: {} },
      { id: 'b', name: 'Files', command: 'npx', args: ['b'], env: {} }
    ])!
    const servers = JSON.parse(bridge.args[1]).mcpServers as Record<string, { args: string[] }>
    expect(Object.keys(servers)).toHaveLength(2)
    expect(Object.values(servers).map(s => s.args[0]).sort()).toEqual(['a', 'b'])
  })

  it('ключи разных серверов не сталкиваются именами переменных', () => {
    const bridge = buildClaudeMcpBridge([
      { id: 'a', name: 'A', command: 'npx', args: [], env: { TOKEN: 'value-A' } },
      { id: 'b', name: 'B', command: 'npx', args: [], env: { TOKEN: 'value-B' } }
    ])!
    expect(Object.keys(bridge.env)).toHaveLength(2)
    expect(Object.values(bridge.env).sort()).toEqual(['value-A', 'value-B'])
  })
})
