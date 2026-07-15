/**
 * IPC для управления аккаунтами подписочных / CLI-провайдеров (1.9.3, мультиаккаунт).
 * Секрет (токен/ключ) кладём в SafeStorage под сгенерированный cred_ref; наружу
 * рендереру НИКОГДА не отдаём сам секрет — только метаданные + флаг hasSecret.
 */

import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import type { Database } from 'better-sqlite3'
import type { Settings } from '../storage/settings'
import { reloginCli, isCliProvider } from '../ai/cli-auth'
import {
  createSubscriptionAccount,
  listSubscriptionAccounts,
  getSubscriptionAccount,
  setActiveAccount,
  renameSubscriptionAccount,
  deleteSubscriptionAccount,
  type SubscriptionAccount,
} from '../storage/subscription-accounts'
import { toSubscriptionAccountDTO, type SubscriptionAccountDTO } from '../../shared/contracts/subscription'

/** Провайдеры с config-dir изоляцией (аккаунт = отдельная папка стейта) → env-переменная. */
const CONFIG_DIR_ENV: Record<string, string> = {
  'codex-cli': 'CODEX_HOME',
}

// 2.0.8-B: renderer-safe DTO — из shared-контракта. Прежний локальный DTO спредил
// `...rest` и МОЛЧА пропускал configDir/baseUrl в renderer. Единый источник теперь один.
export type { SubscriptionAccountDTO }

export function registerSubscriptionAccountsIpc(db: Database, settings: Settings, accountsBaseDir: string): void {
  // WHITELIST-сериализация: credRef/configDir/baseUrl физически не попадают в DTO.
  const toDto = (a: SubscriptionAccount): SubscriptionAccountDTO =>
    toSubscriptionAccountDTO(a, { hasCredential: Boolean(settings.getSecret(a.credRef)), now: Date.now() })

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

  // Config-dir аккаунт (Codex): секрета нет — генерим изолированную папку стейта, логин
  // потом в терминале с нужной env-переменной. hasSecret=false до первого логина.
  ipcMain.handle('subscription-accounts:create-dir', (_e, input: { providerId: string; label: string }) => {
    const providerId = String(input?.providerId ?? '').trim()
    const label = String(input?.label ?? '').trim()
    if (!CONFIG_DIR_ENV[providerId]) return { ok: false as const, error: 'Провайдер не поддерживает config-dir аккаунты.' }
    if (!label) return { ok: false as const, error: 'Укажи название аккаунта.' }
    const configDir = join(accountsBaseDir, `${providerId}-${randomUUID()}`)
    try { mkdirSync(configDir, { recursive: true }) } catch (err) {
      return { ok: false as const, error: `Не удалось создать папку аккаунта: ${(err as Error).message}` }
    }
    const account = createSubscriptionAccount(db, { providerId, label, credRef: '', configDir })
    return { ok: true as const, account: toDto(account) }
  })

  // Логин в config-dir аккаунт: открываем терминал с env (напр. CODEX_HOME=<папка>) + CLI login.
  ipcMain.handle('subscription-accounts:login', async (_e, id: number) => {
    const account = getSubscriptionAccount(db, Number(id))
    if (!account) return { ok: false as const, error: 'Аккаунт не найден.' }
    const envKey = CONFIG_DIR_ENV[account.providerId]
    if (!envKey || !account.configDir) return { ok: false as const, error: 'У аккаунта нет config-dir для логина.' }
    if (!isCliProvider(account.providerId)) return { ok: false as const, error: 'Не CLI-провайдер.' }
    const res = await reloginCli(account.providerId, { [envKey]: account.configDir })
    return res.ok ? { ok: true as const } : { ok: false as const, error: res.message }
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
      if (account.credRef) { try { settings.setSecret(account.credRef, '') } catch { /* best-effort */ } }
      // Для config-dir аккаунта чистим изолированную папку стейта (там креды логина).
      if (account.configDir && account.configDir.includes('cli-accounts')) {
        try { rmSync(account.configDir, { recursive: true, force: true }) } catch { /* best-effort */ }
      }
    }
    const removed = deleteSubscriptionAccount(db, Number(id))
    return { ok: removed }
  })
}
