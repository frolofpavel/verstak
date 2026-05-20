import type { Connector, ConnectorContext, ConnectorInfo } from './types'
import { createOneCConnector } from './onec'
import { createHttpConnector } from './http'

// Built-in connectors. Adding a new adapter = register it here.
const BUILTINS: Connector[] = [
  createOneCConnector(),
  createHttpConnector()
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
