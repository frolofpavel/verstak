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
  createSocialPublishConnector()
]

export interface ConnectorRegistry {
  list(): ConnectorInfo[]
  get(id: string): Connector | null
  query(id: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown>
}

export function createConnectorRegistry(): ConnectorRegistry {
  const byId = new Map<string, Connector>()
  for (const c of BUILTINS) byId.set(c.info().id, c)

  return {
    list() {
      return BUILTINS.map(c => c.info())
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
