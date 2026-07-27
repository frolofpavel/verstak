import type { Connector, ConnectorContext, ConnectorInfo } from './types'
import { createOneCConnector } from './onec'
import { createHttpConnector } from './http'
import { createGSheetsConnector } from './gsheets'
import { createSshConnector } from './ssh'
import { createTelegramConnector } from './telegram'
import { createBitrix24Connector } from './bitrix24'
import { createYandexDirectConnector } from './yandex-direct'
import { createYandexDiskConnector } from './yandex-disk'
import { createGitHubConnector } from './github'
import { createSocialPublishConnector } from './social-publish'
import { createDaDataConnector } from './dadata'
import { createYandexMetrikaConnector } from './yandex-metrika'
import { createAvitoConnector } from './avito'
import { createYandexWebmasterConnector } from './yandex-webmaster'
import { createYandexWordstatConnector } from './yandex-wordstat'
import { createOzonConnector } from './ozon'
import { createWildberriesConnector } from './wildberries'
import { createYooKassaConnector } from './yookassa'
import { createVkConnector } from './vk'
import { createAmoCrmConnector } from './amocrm'
import { createMoySkladConnector } from './moysklad'
import { createYandexTrackerConnector } from './yandex-tracker'
import { createSendPulseConnector } from './sendpulse'
import { createUniSenderConnector } from './unisender'
import { createGa4Connector } from './ga4'
import { createNotionConnector } from './notion'
import { createKonturFocusConnector } from './kontur-focus'
import { createMpStatsConnector } from './mpstats'
import { createOzonPerformanceConnector } from './ozon-performance'
import { createJiraConnector } from './jira'
import { createTrelloConnector } from './trello'

// Built-in connectors. Adding a new adapter = register it here.
const BUILTINS: Connector[] = [
  createOneCConnector(),
  createHttpConnector(),
  createGSheetsConnector(),
  createSshConnector(),
  createTelegramConnector(),
  createBitrix24Connector(),
  createYandexDirectConnector(),
  createYandexDiskConnector(),
  createGitHubConnector(),
  createSocialPublishConnector(),
  createDaDataConnector(),
  createYandexMetrikaConnector(),
  createAvitoConnector(),
  createYandexWebmasterConnector(),
  createYandexWordstatConnector(),
  createOzonConnector(),
  createWildberriesConnector(),
  createYooKassaConnector(),
  createVkConnector(),
  createAmoCrmConnector(),
  createMoySkladConnector(),
  createYandexTrackerConnector(),
  createSendPulseConnector(),
  createUniSenderConnector(),
  createGa4Connector(),
  createNotionConnector(),
  createKonturFocusConnector(),
  createMpStatsConnector(),
  createOzonPerformanceConnector(),
  createJiraConnector(),
  createTrelloConnector()
]

export interface ConnectorRegistry {
  list(): ConnectorInfo[]
  get(id: string): Connector | null
  query(id: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown>
}

/** Ключ считается заполненным, только если в нём есть непробельный текст. */
function filled(getSecret: (key: string) => string | null, key: string): boolean {
  return ((getSecret(key) ?? '').trim().length > 0)
}

/**
 * Честный статус источника.
 *
 * До 27.07 каждый адаптер возвращал захардкоженное `status: 'ready'` — `info()`
 * не получает контекста и проверить хранилище не может. Из-за этого модель через
 * `list_connectors` видела все 31 источника готовыми, включая те, где ключа нет
 * вовсе, и уверенно шла в них за данными. Симптом обходили формулировкой в
 * промпте; причина была здесь.
 *
 * Теперь реестр знает `getSecret` и сверяет объявленные требования. Названия
 * недостающих ключей попадают в `detail` — ЗНАЧЕНИЯ не читаются и не показываются.
 */
function withHonestStatus(info: ConnectorInfo, getSecret?: (key: string) => string | null): ConnectorInfo {
  // Нет доступа к хранилищу — не выдумываем: отдаём как есть (прежнее поведение).
  if (!getSecret) return info
  const missingAll = (info.requires ?? []).filter(k => !filled(getSecret, k))
  const anyOf = info.requiresAnyOf ?? []
  const anyMissing = anyOf.length > 0 && !anyOf.some(k => filled(getSecret, k))
  if (missingAll.length === 0 && !anyMissing) return info

  const parts: string[] = []
  if (missingAll.length > 0) parts.push(`не заданы: ${missingAll.join(', ')}`)
  if (anyMissing) parts.push(`нужен хотя бы один из: ${anyOf.join(', ')}`)
  const note = `Не настроено — ${parts.join('; ')}. Settings → коннекторы.`
  return { ...info, status: 'needs-config', detail: info.detail ? `${info.detail} ${note}` : note }
}

/**
 * @param getSecret доступ к хранилищу настроек. Без него статусы остаются такими,
 *        какими их объявил адаптер (обратная совместимость для тестов и утилит).
 */
export function createConnectorRegistry(getSecret?: (key: string) => string | null): ConnectorRegistry {
  const byId = new Map<string, Connector>()
  for (const c of BUILTINS) byId.set(c.info().id, c)

  return {
    list() {
      return BUILTINS.map(c => withHonestStatus(c.info(), getSecret))
    },
    get(id: string) {
      return byId.get(id) ?? null
    },
    async query(id: string, args: Record<string, unknown>, ctx: ConnectorContext) {
      const c = byId.get(id)
      if (!c) return { error: 'unknown-connector', message: `Нет коннектора "${id}". Известны: ${[...byId.keys()].join(', ')}` }
      return c.query(args, ctx)
    }
  }
}
