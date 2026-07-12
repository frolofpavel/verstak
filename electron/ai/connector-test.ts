/**
 * Проверка коннекторов из Settings — реальный ping через connector registry.
 * UI id (Settings) → registry id (electron/connectors).
 */

import { createSign } from 'crypto'
import type { ConnectorRegistry } from '../connectors/registry'
import type { ConnectorContext } from '../connectors/types'

export interface ConnectorCapabilityResult {
  id: string
  label: string
  ok: boolean
  message?: string
}

export interface ConnectorTestResult {
  ok: boolean
  message: string
  capabilities?: ConnectorCapabilityResult[]
}

/** Id карточки в Settings → id в registry (null = особая проверка без registry). */
export const CONNECTOR_UI_TO_REGISTRY: Record<string, string | null> = {
  'claude-oauth': null,
  'onec': 'onec',
  'http': 'http',
  'gsheets': 'gsheets',
  'telegram': 'telegram',
  'ssh': 'ssh',
  'bitrix': 'bitrix24',
  'ydirect': 'yandex_direct',
  'ydisk': 'yandex_disk',
  'skills-server': null,
  'github': 'github',
  'social-publish': 'social-publish',
  'dadata': 'dadata',
  'ymetrika': 'yandex_metrika',
  'avito': 'avito',
  'ywebmaster': 'yandex_webmaster',
  'ywordstat': 'yandex_wordstat',
  'ozon': 'ozon',
  'wildberries': 'wildberries',
  'yookassa': 'yookassa',
  'vk': 'vk',
  'amocrm': 'amocrm',
  'moysklad': 'moysklad',
  'yandex_tracker': 'yandex_tracker',
  'sendpulse': 'sendpulse',
  'unisender': 'unisender',
  'ga4': 'ga4',
  'notion': 'notion',
  'kontur_focus': 'kontur_focus',
  'mpstats': 'mpstats',
  'ozon_performance': 'ozon_performance',
  'jira': 'jira',
  'trello': 'trello',
}

const TEST_TIMEOUT_MS = 20_000

const REGISTRY_TEST_OPS: Record<string, Record<string, unknown>> = {
  onec: { metadata: true },
  telegram: { op: 'get_me' },
  ssh: { op: 'run_remote', command: 'echo verstak-ping', timeout_ms: 8_000 },
  bitrix24: { op: 'call', method: 'profile' },
  yandex_direct: { op: 'list_campaigns' },
  yandex_disk: { op: 'list_files', path: '/' },
  github: { op: 'list_repos', per_page: 1 },
  'social-publish': { op: 'list_channels' },
  dadata: { op: 'suggest_party', query: 'сбер', count: 1 },
  yandex_metrika: { op: 'list_counters' },
  avito: { op: 'get_balance' },
  yandex_webmaster: { op: 'list_hosts' },
  yandex_wordstat: { op: 'get_top_requests', phrase: 'проверка', num_phrases: 1 },
  ozon: { op: 'list_products' },
  wildberries: { op: 'get_stocks' },
  yookassa: { op: 'list_payments', limit: 1 },
  vk: { op: 'users_get', user_ids: '1', fields: 'id' },
  amocrm: { op: 'list_pipelines' },
  moysklad: { op: 'list_products' },
  yandex_tracker: { op: 'list_queues' },
  sendpulse: { op: 'get_balance' },
  unisender: { op: 'get_lists' },
  ga4: { op: 'get_realtime' },
  notion: { op: 'search', query: 'verstak' },
  kontur_focus: { op: 'req', inn: '7707083893' },
  mpstats: { op: 'wb_category', path: 'Женщинам', d1: '2026-01-01', d2: '2026-01-07' },
  ozon_performance: { op: 'list_campaigns' },
  jira: { op: 'list_projects' },
  trello: { op: 'list_boards' },
  gsheets: { op: 'ping' },
}

function parseConnectorResult(result: unknown): ConnectorTestResult {
  if (result === null || result === undefined) {
    return { ok: false, message: 'Пустой ответ от коннектора' }
  }
  if (typeof result !== 'object') {
    return { ok: true, message: 'Подключение работает' }
  }
  const r = result as Record<string, unknown>
  if (typeof r.error === 'string') {
    const msg = typeof r.message === 'string' ? r.message : r.error
    return { ok: false, message: msg }
  }
  if (r.ok === false) {
    return {
      ok: false,
      message: typeof r.message === 'string' ? r.message : 'Запрос отклонён API'
    }
  }
  if (typeof r.message === 'string' && r.ok === true) {
    return { ok: true, message: r.message }
  }
  return { ok: true, message: 'Токен работает' }
}

function firstHttpEndpoint(getSecret: (k: string) => string | null): string | null {
  for (let i = 1; i <= 4; i++) {
    const name = (getSecret(`http_endpoint_${i}_name`) ?? '').trim()
    const base = (getSecret(`http_endpoint_${i}_base`) ?? '').trim()
    if (name && base) return name
  }
  return null
}

async function testClaudeOauth(getSecret: (k: string) => string | null): Promise<ConnectorTestResult> {
  const token = (getSecret('claude_code_oauth_token') ?? '').trim()
  if (!token) return { ok: false, message: 'Токен не задан' }
  if (!token.startsWith('sk-ant-')) {
    return { ok: false, message: 'Неверный формат (ожидается sk-ant-...)' }
  }
  return { ok: true, message: 'Формат токена корректен' }
}

async function testSkillsServer(
  getSecret: (k: string) => string | null,
  signal: AbortSignal
): Promise<ConnectorTestResult> {
  const base = (getSecret('skills_server_base') ?? '').trim().replace(/\/+$/, '')
  if (!base) {
    return { ok: true, message: 'Локальные скиллы (URL сервера не задан)' }
  }
  try {
    const url = `${base}/api/skills`
    const res = await fetch(url, { signal })
    if (!res.ok) {
      return { ok: false, message: `Сервер ответил ${res.status}` }
    }
    return { ok: true, message: 'Сервер скиллов доступен' }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Не удалось подключиться к серверу'
    }
  }
}

async function testBitrix24(registry: ConnectorRegistry, ctx: ConnectorContext): Promise<ConnectorTestResult> {
  const check = async (id: string, label: string, args: Record<string, unknown>): Promise<ConnectorCapabilityResult> => {
    const raw = await registry.query('bitrix24', args, ctx)
    const parsed = parseConnectorResult(raw)
    return { id, label, ok: parsed.ok, message: parsed.message }
  }

  const profile = await check('profile', 'Webhook', { op: 'call', method: 'profile' })
  if (!profile.ok) {
    return { ok: false, message: profile.message ?? 'Webhook недоступен', capabilities: [profile] }
  }

  const crm = await check('crm', 'CRM', { op: 'call', method: 'crm.deal.fields' })
  const tasks = await check('tasks', 'Задачи', {
    op: 'call',
    method: 'tasks.task.list',
    params: { order: { ID: 'desc' }, filter: {}, select: ['ID', 'TITLE'], limit: 1 }
  })

  const capabilities = [
    { ...profile, message: profile.ok ? 'Webhook отвечает' : profile.message },
    { ...crm, message: crm.ok ? 'CRM доступна' : crm.message },
    { ...tasks, message: tasks.ok ? 'Задачи доступны' : tasks.message }
  ]
  const workingFeatures = capabilities.filter(item => item.id !== 'profile' && item.ok)

  if (workingFeatures.length > 0) {
    const available = workingFeatures.map(item => item.label.toLowerCase())
    return { ok: true, message: `Webhook работает. Доступно: ${available.join(', ')}`, capabilities }
  }

  const details = capabilities
    .filter(item => !item.ok)
    .map(item => `${item.label}: ${item.message ?? 'нет доступа'}`)
    .join('\n')

  if (/insufficient_scope/i.test(details)) {
    return {
      ok: false,
      message: 'Webhook живой, но CRM и задачи недоступны. В Битрикс24 проверь права webhook на CRM/Tasks.',
      capabilities
    }
  }
  return { ok: false, message: `Webhook живой, но рабочих разделов не найдено:\n${details}`, capabilities }
}

async function runRegistryTest(
  registryId: string,
  registry: ConnectorRegistry,
  ctx: ConnectorContext
): Promise<ConnectorTestResult> {
  if (registryId === 'http') {
    const endpoint = firstHttpEndpoint(ctx.getSecret)
    if (!endpoint) {
      return { ok: false, message: 'Задайте хотя бы один HTTP-эндпоинт (имя + base URL)' }
    }
    const raw = await registry.query(registryId, { endpoint, method: 'GET', path: '/' }, ctx)
    return parseConnectorResult(raw)
  }

  if (registryId === 'bitrix24') {
    return testBitrix24(registry, ctx)
  }

  const args = REGISTRY_TEST_OPS[registryId]
  if (!args) {
    return { ok: false, message: `Проверка для «${registryId}» не настроена` }
  }

  const raw = await registry.query(registryId, { ...args }, ctx)
  return parseConnectorResult(raw)
}

/**
 * Проверяет коннектор по id карточки Settings. Credentials читаются из settings store.
 */
export async function testConnectorUi(
  uiId: string,
  registry: ConnectorRegistry,
  getSecret: (key: string) => string | null
): Promise<ConnectorTestResult> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TEST_TIMEOUT_MS)
  const ctx: ConnectorContext = { getSecret, signal: ac.signal }

  try {
    if (uiId === 'claude-oauth') return await testClaudeOauth(getSecret)
    if (uiId === 'skills-server') return await testSkillsServer(getSecret, ac.signal)

    const registryId = CONNECTOR_UI_TO_REGISTRY[uiId]
    if (!registryId) {
      return { ok: false, message: `Неизвестный коннектор «${uiId}»` }
    }

    return await runRegistryTest(registryId, registry, ctx)
  } catch (err) {
    if (ac.signal.aborted) {
      return { ok: false, message: `Таймаут проверки (>${TEST_TIMEOUT_MS / 1000} с)` }
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}
