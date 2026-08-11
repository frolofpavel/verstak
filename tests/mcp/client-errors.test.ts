// P8 шаг 3 «честный отказ»: сервер не поднялся — понятная строка причины, не тишина
// и не голый "exit 1". Тесты гоняют РЕАЛЬНЫЕ дочерние процессы (spawn без shell —
// разбор аргументов cmd.exe не участвует, инлайновый node -e безопасен).
import { describe, it, expect, afterEach } from 'vitest'
import { McpClient, resolveSpawnTarget } from '../../electron/mcp/client'

const clients: McpClient[] = []

function makeClient(): McpClient {
  const c = new McpClient()
  clients.push(c)
  return c
}

afterEach(() => {
  for (const c of clients.splice(0)) c.disconnectAll()
})

// Контрольный кейс: подключение РАБОТАЕТ против минимального живого MCP-сервера.
// Без него «отказ понятен» зелен и тогда, когда connect не работает вовсе (§3.1).
const MINI_SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', l => {
  let m; try { m = JSON.parse(l) } catch { return }
  if (m.method === 'initialize') respond(m.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 't', version: '0' } });
  else if (m.method === 'tools/list') respond(m.id, { tools: [{ name: 'ping', description: 'read data', inputSchema: {} }] });
});
function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n') }
`

describe('resolveSpawnTarget — npx-шимы на Windows', () => {
  it('голое "npx" резолвится в запускаемый файл (без резолва spawn = ENOENT)', () => {
    const t = resolveSpawnTarget('npx')
    if (process.platform === 'win32') {
      expect(t.file).not.toBe('npx')
      // файл может быть заквотирован для shell — учитываем закрывающую кавычку
      expect(t.useShell).toBe(/\.(cmd|bat|ps1)"?$/i.test(t.file))
      if (t.useShell && /\s/.test(t.file)) expect(t.file).toMatch(/^".*"$/)
    } else {
      expect(t).toEqual({ file: 'npx', useShell: false })
    }
  })

  it('явный путь не трогается, shell только для шимов', () => {
    expect(resolveSpawnTarget(process.execPath).useShell).toBe(false)
    expect(resolveSpawnTarget(process.execPath).file).toBe(process.execPath)
  })

  it('шим-путь с пробелом квотируется для shell (живая приёмка: «"C:\\Program" не является…»)', () => {
    if (process.platform !== 'win32') return
    const t = resolveSpawnTarget('C:\\Program Files\\nodejs\\npx.cmd')
    expect(t.useShell).toBe(true)
    expect(t.file).toBe('"C:\\Program Files\\nodejs\\npx.cmd"')
    // без пробела — без кавычек
    expect(resolveSpawnTarget('C:\\nodejs\\npx.cmd').file).toBe('C:\\nodejs\\npx.cmd')
  })
})

describe('McpClient честный отказ', () => {
  it('контроль: живой мини-сервер подключается и отдаёт инструменты', async () => {
    const client = makeClient()
    const tools = await client.connect({
      id: 'mini', name: 'mini', command: process.execPath, args: ['-e', MINI_SERVER]
    })
    expect(tools.map(t => t.name)).toEqual(['ping'])
  }, 15000)

  it('команда не найдена → строка причины называет команду и что поставить', async () => {
    const client = makeClient()
    await expect(client.connect({
      id: 'ghost', name: 'ghost', command: 'verstak-no-such-command-12345', args: []
    })).rejects.toThrow(/не удалось запустить|не найдена/i)
  }, 15000)

  it('смерть сервера ПОСЛЕ подключения не роняет процесс, pending-вызов получает причину', async () => {
    // До фикса P8 здесь был краш: _handleDisconnect эмитил 'error' без слушателя,
    // EventEmitter кидал ERR_UNHANDLED_ERROR прямо в main-процесс.
    const DIES_ON_CALL = MINI_SERVER + `
rl.on('line', l => {
  let m; try { m = JSON.parse(l) } catch { return }
  if (m.method === 'tools/call') { console.error('SERVER CRASH: token expired'); process.exit(3) }
});
`
    const client = makeClient()
    const tools = await client.connect({
      id: 'crashy', name: 'crashy', command: process.execPath, args: ['-e', DIES_ON_CALL]
    })
    expect(tools.length).toBe(1)
    const err = await client.callTool('crashy', 'ping', {}).then(() => null, (e: Error) => e)
    expect(err).not.toBeNull()
    expect(err!.message).toMatch(/код 3/)
    expect(err!.message).toContain('SERVER CRASH')
  }, 15000)

  it('процесс умер на старте → причина содержит код выхода и хвост stderr', async () => {
    const client = makeClient()
    const err = await client.connect({
      id: 'dying', name: 'dying', command: process.execPath,
      args: ['-e', 'console.error("AUTH BOOM: invalid token supplied"); process.exit(7)']
    }).then(() => null, (e: Error) => e)
    expect(err).not.toBeNull()
    expect(err!.message).toMatch(/код 7/)
    expect(err!.message).toContain('AUTH BOOM')
  }, 15000)
})
