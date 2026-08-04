import type { AgentRun } from '../types/api'

/**
 * Маршрут прогона для показа: что ЗАПРОСИЛИ (requested) vs что реально отработало
 * (actual). SSOT — persisted `agent_runs` (та же логика, что buildRun в бывшем
 * AgentRunInspector, но напрямую из строки прогона, без audit-эвристики):
 * requested_* заполнен при явном route-override; null ⇒ запрошенное == фактическому.
 * Отличие requested от actual ⇒ был фолбэк (показываем ВИДИМО во вкладке «Диагностика»).
 */
export interface RouteDisplay {
  actualProvider: string | null
  actualModel: string | null
  requestedProvider: string | null
  requestedModel: string | null
  isFallback: boolean
}

export function describeRoute(run: AgentRun): RouteDisplay {
  const actualProvider = run.providerId
  const actualModel = run.model
  const requestedProvider = run.requestedProviderId ?? run.providerId
  const requestedModel = run.requestedModel ?? run.model
  const isFallback =
    (!!requestedProvider && requestedProvider !== actualProvider) ||
    (!!requestedModel && requestedModel !== actualModel)
  return { actualProvider, actualModel, requestedProvider, requestedModel, isFallback }
}
