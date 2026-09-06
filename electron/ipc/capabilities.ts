/**
 * IPC реестра возможностей. Тонкая обёртка: вся логика — в
 * `electron/capabilities/service.ts`, здесь только доставка в renderer.
 *
 * Наружу уходит паспорт и причина уровня доверия. Секретов в паспорте нет по
 * построению: `source` MCP-сервера — это команда и аргументы, а окружение с
 * ключами (`entry.env`) в проекцию не входит вовсе.
 */
import { ipcMain } from 'electron'
import type { CapabilityService } from '../capabilities/service'

export function registerCapabilitiesIpc(service: CapabilityService): void {
  ipcMain.handle('capabilities:list', () => service.list())
  ipcMain.handle('capabilities:get', (_e, id: unknown) =>
    typeof id === 'string' ? service.get(id) : null
  )
  ipcMain.handle('capabilities:reason', (_e, id: unknown) =>
    typeof id === 'string' ? service.reason(id) : null
  )
}
