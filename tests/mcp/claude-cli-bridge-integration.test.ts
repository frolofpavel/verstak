// Связка «подключённый в Verstak сервер → командная строка claude». Это ровно тот
// стык, который стенд на настоящем claude НЕ проверял: там записи серверов клал
// сам стенд, а в проде их отдаёт McpClient.getConnectedServers() (ipc/ai.ts).
// Пин гоняет РЕАЛЬНЫЙ дочерний процесс сервера — форма записи берётся из клиента,
// а не сочиняется фикстурой (§3.1: фикстура, разошедшаяся с продовой формой,
// не защищает ничего и не сообщает об этом).
import { describe, it, expect, afterEach } from 'vitest'
import { McpClient } from '../../electron/mcp/client'
import { buildClaudeMcpBridge } from '../../electron/ai/claude-cli-mcp'
import { buildClaudeCliArgs } from '../../electron/ai/claude-cli'

const clients: McpClient[] = []
function makeClient(): McpClient {
  const c = new McpClient()
  clients.push(c)
  return c
}
afterEach(() => { for (const c of clients.splice(0)) c.disconnectAll() })

// Минимальный живой MCP-сервер: отвечает на handshake и отдаёт один инструмент.
const MINI_SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', l => {
  let m; try { m = JSON.parse(l) } catch { return }
  if (m.method === 'initialize') respond(m.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 't', version: '0' } });
  else if (m.method === 'tools/list') respond(m.id, { tools: [{ name: 'quote', description: 'read data', inputSchema: {} }] });
});
function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n') }
`

describe('подключённый сервер → аргументы claude CLI', () => {
  it('сервер, подключённый через McpClient, доезжает до --mcp-config', async () => {
    const client = makeClient()
    await client.connect({
      id: 'srv-moex', name: 'Московская Биржа (MOEX)',
      command: process.execPath, args: ['-e', MINI_SERVER], env: {}
    })

    // Ровно то, что ipc/ai.ts передаёт в createProvider.
    const bridge = buildClaudeMcpBridge(client.getConnectedServers())
    expect(bridge).not.toBeNull()
    const servers = JSON.parse(bridge!.args[1]).mcpServers as Record<string, { command: string; args: string[] }>
    const key = Object.keys(servers)[0]
    expect(key).toContain('MOEX')
    expect(servers[key].command).toBe(process.execPath)
    expect(servers[key].args[0]).toBe('-e')

    // И доезжает до итоговой командной строки, не потеряв guard.
    const argv = buildClaudeCliArgs({ agentMode: 'ask', mcpArgs: bridge!.args })
    expect(argv.indexOf('--mcp-config')).toBeLessThan(argv.indexOf('--disallowedTools'))
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('default')
  })

  it('SECURITY: ключ подключённого сервера не оказывается в аргументах', async () => {
    const client = makeClient()
    await client.connect({
      id: 'srv-key', name: 'Keyed', command: process.execPath, args: ['-e', MINI_SERVER],
      env: { SERVICE_TOKEN: 'tok-INTEGRATION-SECRET' }
    })
    const bridge = buildClaudeMcpBridge(client.getConnectedServers())!
    expect(buildClaudeCliArgs({ agentMode: 'ask', mcpArgs: bridge.args }).join(' '))
      .not.toContain('tok-INTEGRATION-SECRET')
    expect(Object.values(bridge.env)).toContain('tok-INTEGRATION-SECRET')
  })

  it('контрольный кейс: ни одного подключённого сервера → флага --mcp-config нет', async () => {
    // Без него оба пина выше зелены и тогда, когда мост не передаёт НИЧЕГО.
    const client = makeClient()
    expect(buildClaudeMcpBridge(client.getConnectedServers())).toBeNull()
    expect(buildClaudeCliArgs({ agentMode: 'ask' })).not.toContain('--mcp-config')
  })
})
