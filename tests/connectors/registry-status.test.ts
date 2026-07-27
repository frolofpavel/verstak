// list_connectors: честный статус вместо захардкоженного 'ready'.
//
// Дефект (найден аудитом 27.07): `ConnectorInfo.status` объявлен как
// 'ready' | 'needs-config' | 'error', но ВСЕ 31 коннектора возвращали строку
// 'ready' независимо от того, настроен ли ключ — `info()` не получал контекста и
// физически не мог проверить хранилище. Модель через `list_connectors` видела
// 31 готовый источник всегда. Симптом обходили формулировкой в промпте
// (`electron/ai/tools.ts`), причина оставалась.
//
// Здесь: red-first на новое поведение + пины на инварианты, которые меняться НЕ
// должны (состав, порядок, id, kind). Секреты не участвуют: тесты подают
// подставной getSecret, значения не настоящие.
import { describe, it, expect } from 'vitest'
import { createConnectorRegistry } from '../../electron/connectors/registry'

/** Хранилище, где нет ничего. */
const emptyStore = () => null
/** Хранилище, где есть всё. */
const fullStore = () => 'значение-заглушка'

describe('реестр коннекторов — инварианты состава (характеризация)', () => {
  const list = createConnectorRegistry().list()

  it('31 коннектор, порядок и id прежние', () => {
    expect(list).toHaveLength(31)
    expect(list.map(c => c.id)).toEqual([
      'onec', 'http', 'gsheets', 'ssh', 'telegram', 'bitrix24', 'yandex_direct',
      'yandex_disk', 'github', 'social-publish', 'dadata', 'yandex_metrika',
      'avito', 'yandex_webmaster', 'yandex_wordstat', 'ozon', 'wildberries',
      'yookassa', 'vk', 'amocrm', 'moysklad', 'yandex_tracker', 'sendpulse',
      'unisender', 'ga4', 'notion', 'kontur_focus', 'mpstats',
      'ozon_performance', 'jira', 'trello',
    ])
  })

  it('у каждого есть label и kind', () => {
    for (const c of list) {
      expect(c.label, c.id).toBeTruthy()
      expect(c.kind, c.id).toBeTruthy()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// НОВОЕ ПОВЕДЕНИЕ. До правки эти тесты красные: статус был 'ready' всегда.
// ─────────────────────────────────────────────────────────────────────────────
describe('реестр коннекторов — честный статус', () => {
  it('пустое хранилище: источники с обязательными ключами помечены needs-config', () => {
    const list = createConnectorRegistry(emptyStore).list()
    const needing = list.filter(c => (c.requires?.length ?? 0) > 0 || (c.requiresAnyOf?.length ?? 0) > 0)
    expect(needing.length).toBeGreaterThanOrEqual(28)
    for (const c of needing) {
      expect(c.status, `${c.id} обязан быть needs-config без ключей`).toBe('needs-config')
    }
  })

  it('пустое хранилище: в detail названы недостающие ключи, но не значения', () => {
    const list = createConnectorRegistry(emptyStore).list()
    const ozon = list.find(c => c.id === 'ozon')!
    expect(ozon.status).toBe('needs-config')
    expect(ozon.detail).toContain('ozon_client_id')
    expect(ozon.detail).toContain('ozon_api_key')
  })

  it('полное хранилище: все снова ready', () => {
    const list = createConnectorRegistry(fullStore).list()
    for (const c of list) expect(c.status, c.id).toBe('ready')
  })

  it('частичное хранилище: не хватает одного ключа из пары — needs-config', () => {
    const onlyShopId = (k: string) => (k === 'yookassa_shop_id' ? 'x' : null)
    const yookassa = createConnectorRegistry(onlyShopId).list().find(c => c.id === 'yookassa')!
    expect(yookassa.status).toBe('needs-config')
    expect(yookassa.detail).toContain('yookassa_secret_key')
    expect(yookassa.detail).not.toContain('yookassa_shop_id:')
  })

  it('пустая строка и пробелы ключом не считаются', () => {
    const blank = (k: string) => (k === 'github_token' ? '   ' : null)
    const github = createConnectorRegistry(blank).list().find(c => c.id === 'github')!
    expect(github.status).toBe('needs-config')
  })

  it('«хотя бы один из»: HTTP готов, если настроен любой эндпоинт', () => {
    const third = (k: string) => (k === 'http_endpoint_3_base' ? 'https://x.test' : null)
    expect(createConnectorRegistry(emptyStore).list().find(c => c.id === 'http')!.status).toBe('needs-config')
    expect(createConnectorRegistry(third).list().find(c => c.id === 'http')!.status).toBe('ready')
  })

  it('SSH не требует хранилища — хост можно передать в аргументах', () => {
    const ssh = createConnectorRegistry(emptyStore).list().find(c => c.id === 'ssh')!
    expect(ssh.status).toBe('ready')
  })

  // Обратная совместимость: без доступа к хранилищу поведение прежнее.
  it('реестр без getSecret не выдумывает статус — всё ready, как раньше', () => {
    for (const c of createConnectorRegistry().list()) expect(c.status, c.id).toBe('ready')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Анти-дрейф: список обязательных ключей — контракт. Новый коннектор без
// объявления `requires` тихо вернёт «ready» и вернёт дефект. Здесь он зафиксирован
// поимённо, чтобы такое изменение было видно в диффе.
// ─────────────────────────────────────────────────────────────────────────────
describe('реестр коннекторов — объявленные требования', () => {
  const byId = new Map(createConnectorRegistry().list().map(c => [c.id, c]))

  const EXPECTED: Record<string, string[]> = {
    onec: ['onec_base_url', 'onec_username', 'onec_password'],
    gsheets: ['gsheets_service_account_json'],
    telegram: ['telegram_bot_token'],
    bitrix24: ['bitrix24_webhook_url'],
    yandex_direct: ['yandex_direct_token'],
    yandex_disk: ['yandex_disk_token'],
    github: ['github_token'],
    dadata: ['dadata_api_key'],
    yandex_metrika: ['yandex_metrika_token'],
    avito: ['avito_client_id', 'avito_client_secret'],
    yandex_webmaster: ['yandex_webmaster_token'],
    yandex_wordstat: ['yandex_wordstat_token', 'yandex_wordstat_folder_id'],
    ozon: ['ozon_client_id', 'ozon_api_key'],
    wildberries: ['wildberries_token'],
    yookassa: ['yookassa_shop_id', 'yookassa_secret_key'],
    vk: ['vk_access_token'],
    amocrm: ['amocrm_subdomain', 'amocrm_access_token'],
    moysklad: ['moysklad_token'],
    yandex_tracker: ['yandex_tracker_token', 'yandex_tracker_org_id'],
    sendpulse: ['sendpulse_client_id', 'sendpulse_client_secret'],
    unisender: ['unisender_api_key'],
    ga4: ['ga4_access_token', 'ga4_property_id'],
    notion: ['notion_token'],
    kontur_focus: ['kontur_focus_api_key'],
    mpstats: ['mpstats_token'],
    ozon_performance: ['ozon_perf_client_id', 'ozon_perf_client_secret'],
    jira: ['jira_base_url', 'jira_email', 'jira_api_token'],
    trello: ['trello_api_key', 'trello_token'],
  }

  for (const [id, keys] of Object.entries(EXPECTED)) {
    it(`${id}: требует ${keys.join(' + ')}`, () => {
      expect(byId.get(id)?.requires ?? []).toEqual(keys)
    })
  }

  it('http и social-publish требуют «хотя бы один из»', () => {
    expect(byId.get('http')?.requiresAnyOf).toEqual([
      'http_endpoint_1_base', 'http_endpoint_2_base',
      'http_endpoint_3_base', 'http_endpoint_4_base',
    ])
    expect(byId.get('social-publish')?.requiresAnyOf).toEqual([
      'telegram_bot_token', 'social_publish_vk_token', 'social_publish_webhooks',
    ])
  })

  it('SSH намеренно ничего не требует — это осознанное исключение', () => {
    expect(byId.get('ssh')?.requires ?? []).toEqual([])
    expect(byId.get('ssh')?.requiresAnyOf ?? []).toEqual([])
  })
})
