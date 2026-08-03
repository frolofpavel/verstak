import { createHash, hkdfSync } from 'crypto'
import { mkdirSync } from 'fs'
import { join } from 'path'

import { createAesGcmSafeStorage } from './secure-storage'
import { createHeadlessHost, type HeadlessHost, type HeadlessHostOptions } from './host'
import { createConnectorRegistry } from '../connectors/registry'
import { STAGE1_CONNECTOR_DENY } from './stage1'

// Мульти-тенантность headless-сервиса (Этап 1а, блок №7; рабочая гипотеза отчёта §3а):
// у каждого пользователя СВОЙ sqlite-файл и СВОЙ ключ шифрования, выведенный из общего
// мастер-ключа через HKDF. Смешивать секреты разных пользователей в одной таблице
// settings нельзя — модель хранения десктопа рассчитана на «одна БД = один пользователь»,
// и вместо её переделки мы держим это допущение истинным per-tenant.
//
// Что это даёт бесплатно: chats/plans/agent_runs/checkpoints тоже изолированы;
// удаление пользователя = удаление каталога; компрометация одного ключа не раскрывает
// секреты остальных (HKDF односторонняя).

/** Имя каталога тенанта: sha256 от id, а не сам id — id может быть email/UUID с чем угодно. */
export function tenantDirName(tenantId: string): string {
  return createHash('sha256').update(tenantId, 'utf8').digest('hex').slice(0, 32)
}

/** Per-tenant ключ из общего мастер-ключа (HKDF-SHA256, info = tenantId). */
export function deriveTenantKey(masterKey: Buffer, tenantId: string): Buffer {
  if (!tenantId) throw new Error('tenantId обязателен')
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.from('verstak-tenant-v1'), Buffer.from(tenantId, 'utf8'), 32))
}

export interface TenantRegistryOptions {
  /** Корень данных сервиса: {root}/{tenantDir}/verstak.db + workspaces. */
  root: string
  masterKey: Buffer
  /** Общие для всех тенантов настройки хоста, кроме dataDir/safeStorage/workspaceRoots. */
  hostDefaults?: Partial<Omit<HeadlessHostOptions, 'dataDir' | 'safeStorage' | 'workspaceRoots'>>
}

export interface TenantHandle {
  tenantId: string
  host: HeadlessHost
  /** Корень workspace'ов тенанта — сюда кладутся каталоги задач. */
  workspaceRoot: string
}

export interface TenantRegistry {
  /** Хост тенанта (создаётся при первом обращении, дальше переиспользуется). */
  get: (tenantId: string) => Promise<TenantHandle>
  /**
   * Статус коннекторов тенанта для кабинета: наружу уходят ТОЛЬКО имена недостающих
   * ключей, никогда значения (та же дисциплина, что withHonestStatus в registry.ts).
   */
  connectorStatus: (tenantId: string) => Promise<Array<{ id: string; label: string; status: string; missingKeys: string[] }>>
  closeAll: () => void
}

export function createTenantRegistry(opts: TenantRegistryOptions): TenantRegistry {
  const hosts = new Map<string, TenantHandle>()

  async function get(tenantId: string): Promise<TenantHandle> {
    const existing = hosts.get(tenantId)
    if (existing) return existing
    const dir = join(opts.root, tenantDirName(tenantId))
    const workspaceRoot = join(dir, 'workspaces')
    mkdirSync(workspaceRoot, { recursive: true })
    const host = await createHeadlessHost({
      ...opts.hostDefaults,
      dataDir: dir,
      workspaceRoots: [workspaceRoot],
      safeStorage: createAesGcmSafeStorage(deriveTenantKey(opts.masterKey, tenantId)),
      // env-фолбэк секретов НЕ наследуется тенантами: ключи процесса — не ключи
      // пользователя. Пустой env закрывает случайное «подхватил чужой ключ из окружения».
      env: {}
    })
    const handle: TenantHandle = { tenantId, host, workspaceRoot }
    hosts.set(tenantId, handle)
    return handle
  }

  return {
    get,
    async connectorStatus(tenantId) {
      const { host } = await get(tenantId)
      const registry = createConnectorRegistry(host.getSecret)
      return registry.list()
        .filter(c => !STAGE1_CONNECTOR_DENY.has(c.id))
        .map(c => {
          const info = registry.get(c.id)?.info()
          const required = [...(info?.requires ?? []), ...(info?.requiresAnyOf ?? [])]
          return {
            id: c.id,
            label: c.label,
            status: c.status,
            // Только ИМЕНА недостающих ключей — значения секретов наружу не выходят.
            missingKeys: required.filter(k => !host.getSecret(k))
          }
        })
    },
    closeAll() {
      for (const handle of hosts.values()) handle.host.close()
      hosts.clear()
    }
  }
}
