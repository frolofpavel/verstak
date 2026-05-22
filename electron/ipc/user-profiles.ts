import { ipcMain } from 'electron'
import type { UserProfiles } from '../storage/user-profiles'

export function registerUserProfilesIpc(profiles: UserProfiles): void {
  ipcMain.handle('user-profiles:list', () => profiles.list())
  ipcMain.handle('user-profiles:get-active', () => profiles.getActive())
  ipcMain.handle('user-profiles:create', (_e, input: {
    name: string
    role?: string
    defaultProvider?: string
    defaultModel?: string
    skillsEnabled?: string[]
  }) => profiles.create(input))
  ipcMain.handle('user-profiles:set-active', (_e, id: number) => profiles.setActive(id))
  ipcMain.handle('user-profiles:update', (_e, id: number, patch: Parameters<UserProfiles['update']>[1]) =>
    profiles.update(id, patch)
  )
  ipcMain.handle('user-profiles:remove', (_e, id: number) => profiles.remove(id))
}
