import { afterEach, describe, expect, it } from 'vitest'
import { McpClient } from '../../electron/mcp/client'

const clients: McpClient[] = []

function makeClient(): McpClient {
  const client = new McpClient()
  clients.push(client)
  return client
}

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnectAll()
})

const SHARED_SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
const cancelled = [];
const holds = [];
rl.on('line', line => {
  let msg; try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') return respond(msg.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'shared', version: '0' } });
  if (msg.method === 'tools/list') return respond(msg.id, { tools: [
    { name: 'hold', description: 'read delayed data', inputSchema: {} },
    { name: 'fast', description: 'read fast data', inputSchema: {} },
    { name: 'cancelled', description: 'list hold and cancelled request ids', inputSchema: {} }
  ] });
  if (msg.method === 'notifications/cancelled') { cancelled.push(msg.params && msg.params.requestId); return }
  if (msg.method !== 'tools/call') return;
  const name = msg.params && msg.params.name;
  if (name === 'hold') { holds.push(msg.id); return setTimeout(() => tool(msg.id, 'late-A'), 180); }
  if (name === 'fast') return setTimeout(() => tool(msg.id, 'B-ok'), 20);
  if (name === 'cancelled') return tool(msg.id, JSON.stringify({ holds, cancelled }));
});
function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n') }
function tool(id, text) { respond(id, { content: [{ type: 'text', text }] }) }
`

const STABLE_SERVER = `
const label = process.argv[1] || 'unknown';
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  let msg; try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') return respond(msg.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: label, version: '0' } });
  if (msg.method === 'tools/list') return respond(msg.id, { tools: [{ name: 'ping', description: 'read ping', inputSchema: {} }] });
  if (msg.method === 'tools/call') return respond(msg.id, { content: [{ type: 'text', text: label }] });
});
function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n') }
// Красный прогон не должен оставлять потерянный successor-процесс навсегда.
setTimeout(() => process.exit(0), 2000);
`

const CYCLE_SERVER = `
const label = process.argv[1] || 'unknown';
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  let msg; try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') return respond(msg.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: label, version: '0' } });
  if (msg.method === 'tools/list') return respond(msg.id, { tools: [
    { name: 'ping', description: 'read pid', inputSchema: {} },
    { name: 'crash', description: 'exit without reply', inputSchema: {} }
  ] });
  if (msg.method !== 'tools/call') return;
  const name = msg.params && msg.params.name;
  if (name === 'ping') return tool(msg.id, JSON.stringify({ label, pid: process.pid }));
  if (name === 'crash') return setTimeout(() => process.exit(9), 5);
});
function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n') }
function tool(id, text) { respond(id, { content: [{ type: 'text', text }] }) }
`

function signal(): AbortSignal {
  return new AbortController().signal
}

async function rejectWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<unknown> {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`request did not abort within ${timeoutMs}ms`)), timeoutMs)),
  ])
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 1500
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(isProcessAlive(pid), `owned MCP pid ${pid} must be gone`).toBe(false)
}

type InternalConnection = { process: { pid?: number }; pending: Map<number, unknown> }
function currentConnection(client: McpClient, serverId: string): InternalConnection {
  const connections = (client as unknown as { connections: Map<string, InternalConnection> }).connections
  const connection = connections.get(serverId)
  if (!connection) throw new Error(`missing test connection ${serverId}`)
  return connection
}

describe('McpClient — request-scoped cancellation', () => {
  it('Stop A отменяет только A; поздний ответ игнорируется, B и общий сервер продолжают работу', async () => {
    const client = makeClient()
    await client.connect({ id: 'shared', name: 'shared', command: process.execPath, args: ['-e', SHARED_SERVER] })
    const a = new AbortController()

    const requestA = client.callTool('shared', 'hold', {}, a.signal)
    const requestB = client.callTool('shared', 'fast', {}, signal())
    await new Promise(resolve => setTimeout(resolve, 10))
    const abortedAt = Date.now()
    a.abort()

    await expect(rejectWithin(requestA, 100)).rejects.toThrow(/abort.*outcome uncertain/i)
    expect(Date.now() - abortedAt).toBeLessThan(100)
    await expect(requestB).resolves.toBe('B-ok')
    expect(client.isConnected('shared')).toBe(true)

    // Сервер намеренно всё равно присылает поздний ответ A. Он не должен найти
    // pending-запрос, повредить B или закрыть shared connection.
    await new Promise(resolve => setTimeout(resolve, 220))
    const state = JSON.parse(await client.callTool('shared', 'cancelled', {}, signal()) as string) as {
      holds: number[]
      cancelled: number[]
    }
    expect(state.holds).toHaveLength(1)
    expect(state.cancelled).toEqual(state.holds)
    await expect(client.callTool('shared', 'fast', {}, signal())).resolves.toBe('B-ok')
    expect(client.isConnected('shared')).toBe(true)
  }, 15000)
})

describe('McpClient — connection ownership', () => {
  it('поздний close старого connection не удаляет новый connection с тем же serverId', async () => {
    const client = makeClient()
    await client.connect({ id: 'same', name: 'old', command: process.execPath, args: ['-e', STABLE_SERVER, 'old'] })
    await client.connect({ id: 'same', name: 'new', command: process.execPath, args: ['-e', STABLE_SERVER, 'new'] })

    // close старого процесса доставляется асинхронно уже после установки successor.
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(client.isConnected('same')).toBe(true)
    await expect(client.callTool('same', 'ping', {}, signal())).resolves.toBe('new')
  }, 15000)

  it('30 циклов disconnect/error → reconnect не оставляют pending и owned процессы', async () => {
    const client = makeClient()
    for (let i = 0; i < 30; i++) {
      const id = 'cycle'
      await client.connect({ id, name: `old-${i}`, command: process.execPath, args: ['-e', CYCLE_SERVER, `old-${i}`] })
      const oldConn = currentConnection(client, id)
      const oldWrapperPid = oldConn.process.pid
      const oldInfo = JSON.parse(await client.callTool(id, 'ping', {}, signal()) as string) as { pid: number }

      if (i % 2 === 0) {
        await client.disconnect(id)
      } else {
        await expect(client.callTool(id, 'crash', {}, signal())).rejects.toThrow(/код 9/)
      }
      expect(oldConn.pending.size).toBe(0)

      await client.connect({ id, name: `new-${i}`, command: process.execPath, args: ['-e', CYCLE_SERVER, `new-${i}`] })
      const newConn = currentConnection(client, id)
      const next = JSON.parse(await client.callTool(id, 'ping', {}, signal()) as string) as { label: string; pid: number }
      expect(next.label).toBe(`new-${i}`)
      expect(newConn.pending.size).toBe(0)
      await client.disconnect(id)
      expect(newConn.pending.size).toBe(0)

      if (oldWrapperPid) await waitForProcessExit(oldWrapperPid)
      await waitForProcessExit(oldInfo.pid)
      if (newConn.process.pid) await waitForProcessExit(newConn.process.pid)
      await waitForProcessExit(next.pid)
    }
  }, 120000)
})
