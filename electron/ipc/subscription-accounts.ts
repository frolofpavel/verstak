/**
 * IPC для управления аккаунтами подписочных / CLI-провайдеров (1.9.3, мультиаккаунт).
 * Секрет (токен/ключ) кладём в SafeStorage под сгенерированный cred_ref; наружу
 * рендереру НИКОГДА не отдаём сам секрет — только метаданные + флаг hasSecret.
 */

import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import type { Database } from 'better-sqlite3'
import type { Settings } from '../storage/settings'
import {
  createSubscriptionAccount,
  listSubscriptionAccounts,
  getSubscriptionAccount,
  setActiveAccount,
  renameSubscriptionAccount,
  deleteSubscriptionAccount,
  type SubscriptionAccount,
} from '../storage/subscription-accounts'

/** DTO без секрета: cred_ref не покидает main. */
export interface SubscriptionAccountDto {
  id: number
  providerId: string
  label: string
  configDir: string | null
  baseUrl: string | null
  active: boolean
  state: string
  createdAt: number
  lastUsedAt: number | null
  hasSecret: boolean
}

export function registerSubscriptionAccountsIpc(db: Database, settings: Settings): void {
  const toDto = (a: SubscriptionAccount): SubscriptionAccountDto => {
    const { credRef, ...rest } = a
    return { ...rest, hasSecret: Boolean(settings.getSecret(credRef)) }
  }

  ipcMain.handle('subscription-accounts:list', (_e, providerId?: string) =>
    listSubscriptionAccounts(db, providerId).map(toDto))

  ipcMain.handle('subscription-accounts:create', (_e, input: {
    providerId: string; label: string; secret: string; configDir?: string | null; baseUrl?: string | null
  }) => {
    const providerId = String(input?.providerId ?? '').trim()
    const label = String(input?.label ?? '').trim()
    const secret = String(input?.secret ?? '')
    if (!providerId) return { ok: false as const, error: 'Не указан провайдер.' }
    if (!label) return { ok: false as const, error: 'Укажи название аккаунта.' }
    if (!secret) return { ok: false as const, error: 'Пустой токен/ключ — нечего сохранять.' }
    const credRef = `subacct:${randomUUID()}`
    settings.setSecret(credRef, secret)
    const account = createSubscriptionAccount(db, {
      providerId, label, credRef,
      configDir: input.configDir ?? null,
      baseUrl: input.baseUrl ?? null,
    })
    return { ok: true as const, account: toDto(account) }
  })

  ipcMain.handle('subscription-accounts:set-active', (_e, providerId: string, id: number) => {
    setActiveAccount(db, String(providerId), Number(id))
    return { ok: true as const }
  })

  ipcMain.handle('subscription-accounts:rename', (_e, id: number, label: string) => {
    const clean = String(label ?? '').trim()
    if (!clean) return { ok: false as const, error: 'Пустое название.' }
    renameSubscriptionAccount(db, Number(id), clean)
    return { ok: true as const }
  })

  ipcMain.handle('subscription-accounts:delete', (_e, id: number) => {
    const account = getSubscriptionAccount(db, Number(id))
    if (account) {
      // Стираем секрет из SafeStorage вместе с записью — не оставляем висячий cred.
      try { settings.setSecret(account.credRef, '') } catch { /* best-effort */ }
    }
    const removed = deleteSubscriptionAccount(db, Number(id))
    return { ok: removed }
  })
}
