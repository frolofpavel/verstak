/**
 * IPC handlers для MCP клиента.
 * Управление серверами + подключение/отключение + список инструментов.
 */

import { ipcMain } from 'electron'
import type { Settings } from '../storage/settings'
import { mcpClient } from '../mcp/client'
import {
  loadMcpServers,
  saveMcpServers,
  addMcpServer,
  removeMcpServer,
  toggleMcpServer,
  updateMcpServer,
  POPULAR_MCP_SERVERS,
  type McpServerEntry
} from '../mcp/registry'
import { MCP_CATALOG } from '../mcp/catalog'

export function registerMcpIpc(settings: Settings): void {

  ipcMain.handle('mcp:list-servers', () => {
    return loadMcpServers(settings)
  })

  ipcMain.handle('mcp:add-server', (_e, entry: Omit<McpServerEntry, 'id'>) => {
    return addMcpServer(settings, entry)
  })

  ipcMain.handle('mcp:update-server', (_e, id: string, patch: Partial<Omit<McpServerEntry, 'id'>>) => {
    return updateMcpServer(settings, id, patch)
  })

  ipcMain.handle('mcp:remove-server', async (_e, id: string) => {
    // Отключаем если подключён
    if (mcpClient.isConnected(id)) {
      await mcpClient.disconnect(id)
    }
    removeMcpServer(settings, id)
  })

  ipcMain.handle('mcp:toggle-server', (_e, id: string, enabled: boolean) => {
    toggleMcpServer(settings, id, enabled)
  })

  ipcMain.handle('mcp:connect', async (_e, id: string) => {
    const servers = loadMcpServers(settings)
    const server = servers.find(s => s.id === id)
    if (!server) throw new Error(`MCP server "${id}" not found`)

    let parsedArgs: string[]
    let parsedEnv: Record<string, string>
    try {
      parsedArgs = JSON.parse(server.args || '[]') as string[]
    } catch {
      parsedArgs = []
    }
    try {
      parsedEnv = JSON.parse(server.env || '{}') as Record<string, string>
    } catch {
      parsedEnv = {}
    }

    const tools = await mcpClient.connect({
      id: server.id,
      name: server.name,
      command: server.command,
      args: parsedArgs,
      env: parsedEnv
    })
    return tools
  })

  ipcMain.handle('mcp:disconnect', async (_e, id: string) => {
    await mcpClient.disconnect(id)
  })

  ipcMain.handle('mcp:tools', () => {
    return mcpClient.getAllTools()
  })

  ipcMain.handle('mcp:connected-servers', () => {
    return mcpClient.getConnectedServers()
  })

  ipcMain.handle('mcp:popular', () => {
    return POPULAR_MCP_SERVERS
  })

  // P8: каталог готовых серверов — статические данные, секретов не содержит.
  ipcMain.handle('mcp:catalog', () => {
    return MCP_CATALOG
  })

  ipcMain.handle('mcp:save-all', (_e, servers: McpServerEntry[]) => {
    saveMcpServers(settings, servers)
  })
}
