import { createHash, hkdfSync } from 'crypto'
import { mkdirSync } from 'fs'
import { join } from 'path'

import { createAesGcmSafeStorage } from './secure-storage'
import {
  createHeadlessHost,
  createHeadlessRunCapacity,
  type HeadlessHost,
  type HeadlessHostOptions
} from './host'
import { listConnectorSecretViews } from './connector-secrets'

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
  hostDefaults?: Partial<Omit<
    HeadlessHostOptions,
    'dataDir' | 'safeStorage' | 'workspaceRoots' | 'globalRunCapacity' | 'beforeCloseDb'
  >>
  /** Общий потолок provider run'ов всех tenant-host'ов процесса. */
  maxActiveRunsGlobal?: number
  /** Жёсткий потолок одновременно открытых tenant SQLite/scheduler host'ов. */
  maxTenantHosts?: number
}

export interface TenantHandle {
  tenantId: string
  host: HeadlessHost
  /** Корень workspace'ов тенанта — сюда кладутся каталоги задач. */
  workspaceRoot: string
}

/** Один request-scoped доступ к tenant-host. release идемпотентен. */
export interface TenantLease extends TenantHandle {
  /** Сигнал терминального shutdown registry; после него handler не обращается к host. */
  signal: AbortSignal
  /** Server регистрирует закрытие HTTP response; для SSE это завершает весь стрим. */
  onShutdown: (closeResponse: () => void) => void
  release: () => void
}

export interface TenantRegistry {
  /**
   * Request lease на хост тенанта. Server обязан держать его до finish/close
   * ответа (для SSE — весь lifetime стрима), затем вызвать release().
   */
  get: (tenantId: string) => Promise<TenantLease>
  /**
   * Статус коннекторов тенанта для кабинета: наружу уходят ТОЛЬКО имена недостающих
   * ключей, никогда значения (та же дисциплина, что withHonestStatus в registry.ts).
   */
  connectorStatus: (
    tenantId: string,
  ) => Promise<Array<{ id: string; label: string; status: string; missingKeys: string[] }>>
  /**
   * Закрыть хосты всех тенантов, дождавшись их живых прогонов (host.close()).
   * Асинхронный: на SIGTERM закрытие БД под работающими задачами оставляло их
   * навсегда 'running'. `timeoutMs` — бюджет ожидания КАЖДОГО хоста.
   */
  closeAll: (opts?: { timeoutMs?: number }) => Promise<void>
}

export function createTenantRegistry(opts: TenantRegistryOptions): TenantRegistry {
  interface TenantEntry {
    handle: TenantHandle | null
    leases: Set<{
      controller: AbortController
      closeResponse: (() => void) | null
    }>
    idleWaiters: Set<() => void>
    /** Монотонный LRU clock; Date.now() не различает несколько requests в одном ms. */
    lastUsed: number
    /** Pending get callbacks, которые ещё не превратились в реальные request leases. */
    reservedGets: number
    /** Синхронный fence между проверкой idle и изъятием entry из hosts. */
    retiring: boolean
  }

  const hosts = new Map<string, TenantEntry>()
  interface PendingHost {
    entry: TenantEntry
    promise: Promise<TenantEntry>
  }
  const pendingHosts = new Map<string, PendingHost>()
  /** Закрывающиеся victims: повторное открытие того же tenant ждёт старую SQLite. */
  const retiringHosts = new Map<string, Promise<void>>()
  /**
   * Неудачно закрытый victim может всё ещё держать SQLite/scheduler. Такой quarantine
   * продолжает занимать свой slot; closeAll повторит close, а тот же tenant не сможет
   * получить второй handle одной БД.
   */
  const failedRetirements = new Map<string, { entry: TenantEntry; error: unknown }>()
  const configuredGlobalRuns = Number(
    opts.maxActiveRunsGlobal ?? process.env.VERSTAK_MAX_ACTIVE_RUNS_GLOBAL ?? 12
  )
  const maxActiveRunsGlobal = Number.isFinite(configuredGlobalRuns)
    ? Math.max(1, Math.floor(configuredGlobalRuns))
    : 12
  const globalRunCapacity = createHeadlessRunCapacity(maxActiveRunsGlobal)
  const configuredTenantHosts = Number(
    opts.maxTenantHosts ?? process.env.VERSTAK_MAX_TENANT_HOSTS ?? 32
  )
  const maxTenantHosts = Number.isFinite(configuredTenantHosts)
    ? Math.max(1, Math.floor(configuredTenantHosts))
    : 32
  let closed = false
  let closePromise: Promise<void> | null = null
  let lruClock = 0

  function touch(entry: TenantEntry): void {
    entry.lastUsed = ++lruClock
  }

  function waitForNoLeases(entry: TenantEntry): Promise<void> {
    if (entry.leases.size === 0) return Promise.resolve()
    return new Promise<void>(resolve => { entry.idleWaiters.add(resolve) })
  }

  async function shutdownAndWaitForLeases(entry: TenantEntry): Promise<void> {
    // Эта точка вызывается host.close() только ПОСЛЕ drain/abort/reconcile прогона.
    // Теперь можно оборвать оставшиеся HTTP ответы: SSE уже имеет durable terminal
    // status, а зависший provider больше не способен удерживать shutdown навсегда.
    for (const lease of [...entry.leases]) {
      lease.controller.abort()
      try { lease.closeResponse?.() } catch { /* server всё равно отпустит lease */ }
    }
    await waitForNoLeases(entry)
  }

  function acquire(tenantId: string, entry: TenantEntry): TenantLease {
    if (entry.retiring || hosts.get(tenantId) !== entry) {
      throw new Error('tenant-host уже закрывается')
    }
    if (!entry.handle) throw new Error('tenant-host ещё не готов')
    const record = {
      controller: new AbortController(),
      closeResponse: null as (() => void) | null,
    }
    entry.leases.add(record)
    touch(entry)
    let released = false
    return {
      ...entry.handle,
      signal: record.controller.signal,
      onShutdown(closeResponse) {
        if (released) return
        record.closeResponse = closeResponse
        if (record.controller.signal.aborted) closeResponse()
      },
      release() {
        if (released) return
        released = true
        entry.leases.delete(record)
        record.closeResponse = null
        touch(entry)
        if (entry.leases.size === 0) {
          for (const resolve of entry.idleWaiters) resolve()
          entry.idleWaiters.clear()
        }
      },
    }
  }

  function acquirePending(tenantId: string, pending: PendingHost): Promise<TenantLease> {
    return pending.promise.then(entry => {
      if (closed) throw new Error('реестр тенантов закрыт')
      return acquire(tenantId, entry)
    }).finally(() => {
      // На success реальный lease уже добавлен; на reject reservation больше не
      // соответствует будущему request. В обоих случаях слот можно пересчитать.
      pending.entry.reservedGets -= 1
    })
  }

  /**
   * Освободить один cache slot через безопасный LRU victim.
   *
   * hosts.delete() и первый синхронный участок host.close() выполняются в одном JS
   * turn: новый get уже не может взять lease на victim, а scheduler получает closing
   * до следующего timer/microtask. Replacement ждёт close до открытия своей SQLite,
   * поэтому фактическое число открытых handles также не выходит за hard cap.
   */
  function evictLeastRecentlyUsedIdle(): Promise<void> | null {
    const candidates = [...hosts.entries()]
      .filter(([tenantId, entry]) => {
        if (
          !entry.handle
          || entry.retiring
          || pendingHosts.has(tenantId)
          || entry.reservedGets !== 0
          || entry.leases.size !== 0
        ) return false
        try {
          return entry.handle.host.canEvictIdle?.() === true
        } catch {
          return false
        }
      })
      .sort(([tenantA, entryA], [tenantB, entryB]) => (
        entryA.lastUsed - entryB.lastUsed || tenantA.localeCompare(tenantB)
      ))
    const victim = candidates[0]
    if (!victim) return null

    const [tenantId, entry] = victim
    // Сравнение защищает от будущих lifecycle-правок: удаляем только тот объект,
    // который только что признали idle, а не переоткрытый handle того же tenantId.
    if (hosts.get(tenantId) !== entry) return null
    entry.retiring = true
    hosts.delete(tenantId)
    let closing: Promise<void>
    try {
      closing = Promise.resolve(entry.handle!.host.close())
    } catch (error) {
      closing = Promise.reject(error)
    }
    let tracked!: Promise<void>
    tracked = closing.then(
      () => {
        if (retiringHosts.get(tenantId) === tracked) retiringHosts.delete(tenantId)
      },
      error => {
        if (retiringHosts.get(tenantId) === tracked) retiringHosts.delete(tenantId)
        failedRetirements.set(tenantId, { entry, error })
        throw error
      },
    )
    retiringHosts.set(tenantId, tracked)
    return tracked
  }

  function get(tenantId: string): Promise<TenantLease> {
    if (closed) return Promise.reject(new Error('реестр тенантов закрыт'))
    const pending = pendingHosts.get(tenantId)
    if (pending) {
      pending.entry.reservedGets += 1
      return acquirePending(tenantId, pending)
    }
    const existing = hosts.get(tenantId)
    // Reservation синхронна до возврата Promise: closeAll в следующей строке JS
    // уже увидит lease и не закроет SQLite под вызывающим request handler.
    if (existing) return Promise.resolve(acquire(tenantId, existing))
    const sameTenantFailure = failedRetirements.get(tenantId)
    if (sameTenantFailure) return Promise.reject(sameTenantFailure.error)
    const sameTenantRetirement = retiringHosts.get(tenantId)
    if (sameTenantRetirement) {
      // Сначала узнаём исход закрытия именно этой SQLite. Не эвиктим другой idle
      // tenant ради replacement, который всё равно нельзя открыть при close failure.
      return sameTenantRetirement.then(() => get(tenantId))
    }
    const retirements: Promise<void>[] = []
    if (hosts.size + pendingHosts.size + failedRetirements.size >= maxTenantHosts) {
      const eviction = evictLeastRecentlyUsedIdle()
      // Active/request-leased/scheduled hosts never become a victim. If every slot
      // is protected, preserve the current fail-closed 503 contract.
      if (!eviction) {
        return Promise.reject(new Error(
          `HEADLESS_TENANT_HOST_CAPACITY: одновременно открыто не более ${maxTenantHosts} tenant-host'ов`
        ))
      }
      retirements.push(eviction)
    }

    const entry: TenantEntry = {
      handle: null,
      leases: new Set(),
      idleWaiters: new Set(),
      lastUsed: ++lruClock,
      reservedGets: 1,
      retiring: false,
    }
    const initialization = (async (): Promise<TenantEntry> => {
      // Никогда не открываем replacement SQLite, пока victim ещё закрывается.
      // При closeAll closed проверяется повторно, и новый host уже не создаётся.
      if (retirements.length > 0) await Promise.all([...new Set(retirements)])
      if (closed) throw new Error('реестр тенантов закрыт')
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
        env: {},
        globalRunCapacity,
        beforeCloseDb: () => shutdownAndWaitForLeases(entry),
      })
      const handle: TenantHandle = { tenantId, host, workspaceRoot }
      entry.handle = handle
      hosts.set(tenantId, entry)
      // closeAll — терминальная операция. Если shutdown начался пока хост
      // создавался, get не возвращает его наружу, а closeAll закроет с тем же timeout.
      if (closed) {
        throw new Error('реестр тенантов закрыт')
      }
      return entry
    })()

    let tracked!: Promise<TenantEntry>
    tracked = initialization.finally(() => {
      if (pendingHosts.get(tenantId)?.promise === tracked) pendingHosts.delete(tenantId)
    })
    const pendingHost = { entry, promise: tracked }
    pendingHosts.set(tenantId, pendingHost)
    return acquirePending(tenantId, pendingHost)
  }

  return {
    get,
    async connectorStatus(tenantId) {
      const lease = await get(tenantId)
      try {
        // Одна реализация на весь сервис (connector-secrets.ts): вторая копия правила
        // разошлась бы с ручкой GET /connectors при первой же правке.
        return listConnectorSecretViews(lease.host).map(({ id, label, status, missingKeys }) => ({
          id,
          label,
          status,
          missingKeys,
        }))
      } finally {
        lease.release()
      }
    },
    closeAll(closeOpts) {
      if (closePromise) return closePromise
      closed = true
      closePromise = (async () => {
        // get(), начатый до shutdown, уже занёс promise в pendingHosts.
        // Ждём его: поздно созданный host попадёт в hosts и закроется ниже.
        await Promise.allSettled([...pendingHosts.values()].map(pending => pending.promise))
        // Idle eviction изымает victim из hosts до await close(). Обычно его close
        // уже входит в pending initialization replacement'а; явное ожидание держит
        // closeAll корректным и при гонке/ошибке инициализации replacement.
        await Promise.allSettled([...retiringHosts.values()])
        // close() допускает повтор после ошибки. На terminal shutdown пробуем ещё
        // раз закрыть orphan'ы; persistent failure обязательно выходит наружу.
        const failedEntries = [...failedRetirements.entries()]
        const failedResults = await Promise.allSettled(failedEntries.map(
          ([, failed]) => failed.entry.handle!.host.close(closeOpts)
        ))
        for (let index = 0; index < failedResults.length; index += 1) {
          if (failedResults[index].status === 'fulfilled') {
            failedRetirements.delete(failedEntries[index][0])
          }
        }
        // Параллельно, а не по очереди: последовательное ожидание сложило бы бюджеты
        // тенантов и вышло бы за отпущенное systemd время на остановку сервиса.
        const entries = [...hosts.entries()]
        hosts.clear()
        // host.close() сначала останавливает provider/start preparations, а его
        // beforeCloseDb затем ждёт request leases. Поэтому живой SSE не создаёт
        // deadlock: abort/completion закрывает response, server отпускает lease,
        // и только после этого SQLite закрывается.
        const results = await Promise.allSettled(entries.map(([, entry]) => entry.handle!.host.close(closeOpts)))
        for (let index = 0; index < results.length; index += 1) {
          const result = results[index]
          if (result.status === 'rejected') {
            const [tenantId, entry] = entries[index]
            entry.retiring = true
            failedRetirements.set(tenantId, { entry, error: result.reason })
          }
        }
        const failure = [...failedResults, ...results]
          .find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failure) throw failure.reason
      })()
      return closePromise
    },
  }
}
