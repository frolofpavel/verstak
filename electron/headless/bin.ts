/**
 * Точка входа headless-сервиса Verstak: env → конфиг → listen.
 *
 * До неё host.ts/server.ts были библиотеками, и каждый потребитель писал свой запуск
 * (прод-слой облачного Verstak собирал бандл сам — расхождение двух сборок). Теперь
 * исполняемый модуль живёт здесь, рядом с ядром, и собирается `npm run build:headless`.
 *
 * Режим по умолчанию — многопользовательский: сервер принимает тенанта заголовком
 * `X-Verstak-Tenant`, каждому — своя sqlite и свой ключ шифрования (tenants.ts).
 * VERSTAK_SINGLE_TENANT=1 поднимает одиночный хост (dev, локальная отладка).
 *
 * Переменные окружения:
 *   VERSTAK_MASTER_KEY   (обяз.) 32 байта base64/hex — мастер-ключ секретов тенантов
 *   VERSTAK_AGENT_TOKEN  (обяз. вне dev) сервисный bearer-токен
 *   VERSTAK_DATA_ROOT    каталог данных (по умолчанию ./verstak-agent-data)
 *   VERSTAK_AGENT_PORT / VERSTAK_AGENT_HOST   адрес прослушивания (8020 / 127.0.0.1)
 *   VERSTAK_SKILL_ROOTS  каталоги скиллов через запятую (по умолчанию — никаких)
 *   VERSTAK_SINGLE_TENANT=1  одиночный режим; workspace-корень — {DATA_ROOT}/workspaces
 */
import { mkdirSync } from 'fs'
import { join, resolve } from 'path'

import { createHeadlessHost } from './host'
import { createHeadlessServer } from './server'
import { createTenantRegistry } from './tenants'
import { createAesGcmSafeStorage, masterKeyFromEnv } from './secure-storage'
import { configureRuntimeLogDir, logRuntime } from '../runtime-log'

function envFlag(name: string): boolean {
  const v = process.env[name]
  return v === '1' || v === 'true'
}

function splitList(value: string | undefined): string[] {
  return (value ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

export async function main(): Promise<{ port: number; close: () => Promise<void> }> {
  const dataRoot = resolve(process.env.VERSTAK_DATA_ROOT || join(process.cwd(), 'verstak-agent-data'))
  const port = Number(process.env.VERSTAK_AGENT_PORT || 8020)
  const hostname = process.env.VERSTAK_AGENT_HOST || '127.0.0.1'
  const authToken = process.env.VERSTAK_AGENT_TOKEN || null
  const skillRoots = splitList(process.env.VERSTAK_SKILL_ROOTS)

  mkdirSync(dataRoot, { recursive: true })
  configureRuntimeLogDir(join(dataRoot, 'logs'))
  // Мастер-ключ обязателен всегда: без него секреты тенантов негде держать, а тихий
  // фолбэк на «без шифрования» — ровно та ошибка, которую нельзя допустить на сервере.
  const masterKey = masterKeyFromEnv(process.env, 'VERSTAK_MASTER_KEY')

  let server: ReturnType<typeof createHeadlessServer>
  // Асинхронный: закрытие хостов ждёт живые прогоны, иначе SIGTERM рвёт sqlite под
  // работающими задачами пользователей и они остаются 'running' (см. host.close()).
  let closeExtra: () => Promise<void> = async () => {}

  if (envFlag('VERSTAK_SINGLE_TENANT')) {
    const workspaceRoot = join(dataRoot, 'workspaces')
    mkdirSync(workspaceRoot, { recursive: true })
    const host = await createHeadlessHost({
      dataDir: dataRoot,
      workspaceRoots: [workspaceRoot],
      safeStorage: createAesGcmSafeStorage(masterKey),
      skillRoots: skillRoots.length ? skillRoots : undefined
    })
    closeExtra = () => host.close()
    server = createHeadlessServer({ host, authToken })
  } else {
    const tenants = createTenantRegistry({
      root: join(dataRoot, 'tenants'),
      masterKey,
      hostDefaults: skillRoots.length ? { skillRoots } : undefined
    })
    closeExtra = () => tenants.closeAll()
    server = createHeadlessServer({ tenants, authToken })
  }

  const actualPort = await server.listen(port, hostname)
  logRuntime('headless.service.start', {
    port: actualPort,
    hostname,
    dataRoot,
    mode: envFlag('VERSTAK_SINGLE_TENANT') ? 'single' : 'multi-tenant',
    authToken: authToken ? 'set' : 'MISSING'
  })
  // eslint-disable-next-line no-console -- сервис пишет старт в stdout: это его лог.
  console.log(`[verstak-headless] listening on ${hostname}:${actualPort} (${envFlag('VERSTAK_SINGLE_TENANT') ? 'single' : 'multi-tenant'}), data=${dataRoot}`)
  if (!authToken) {
    // eslint-disable-next-line no-console -- предупреждение обязано быть видно в консоли.
    console.warn('[verstak-headless] VERSTAK_AGENT_TOKEN не задан — сервис отвечает БЕЗ авторизации (только для локальной отладки)')
  }

  const close = async (): Promise<void> => {
    // Сначала перестаём принимать запросы, потом дожидаемся уже идущих задач —
    // обратный порядок дал бы новым задачам стартовать во время остановки.
    await server.close()
    await closeExtra()
  }
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      logRuntime('headless.service.stopping', { signal: sig })
      void close().then(() => process.exit(0), () => process.exit(1))
    })
  }
  return { port: actualPort, close }
}

// Запуск только когда модуль исполняется как программа, а не импортируется тестом.
if (process.env.VERSTAK_HEADLESS_NO_AUTOSTART !== '1') {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console -- фатальная ошибка старта: без stderr её не видно.
    console.error('[verstak-headless] не удалось запустить:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
