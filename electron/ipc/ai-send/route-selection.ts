// Распил ai.ts (2.1.10-E, срез 2а): выбор провайдера и модели для ai:send.
//
// Вынесено из registerAiIpc БЕЗ изменения логики. Собраны три решения маршрута,
// которые раньше были размазаны по хендлеру:
//  · selectSendProvider — приоритет источников провайдера (one-shot route → override
//    ревьюера → сохранённый route чекпойнта → выбранный в UI → дефолт чата);
//  · selectSendModel — та же лестница для модели + нормализация под дескриптор;
//  · decideSmartRouting — РЕШЕНИЕ smart-routing'а (без побочных эффектов: логи и
//    ai:event остаются в хендлере, чтобы порядок событий не поехал).
//
// resolveCodexHome переехал сюда же: он нужен и хендлеру, и fallback-маршруту, а
// держать его в ai.ts значило бы импорт ipc/ai.ts из ai-send/* (рантайм-цикл).

import { PROVIDERS, isCodexAuthProvider, type ProviderId, type ProviderDescriptor } from '../../ai/registry'
import { isKnownProviderId, normalizeSelectedModel, type PromptRouteOverride } from '../../../shared/contracts/provider'
import { estimateComplexity, recommendModel, complexityLabel } from '../../ai/smart-router'
import type { ChatMessage } from '../../ai/types'

/** Прогон-чекпойнт в объёме, который нужен маршруту (resume сохранённого route). */
export interface CheckpointRoute {
  requestedProviderId?: string | null
  requestedModel?: string | null
}

export interface ProviderSelection {
  providerId: ProviderId
  descriptor: ProviderDescriptor
  /** Валидный провайдер из чекпойнта (null — нет resume / провайдер удалён). Нужен
   *  ниже для решения «применять ли сохранённую модель». */
  resumedProviderId: ProviderId | null
}

/**
 * 2.0.7-F: promptRoute (модель на один prompt) побеждает дефолт чата, но НЕ меняет его.
 * Ревью F1: сохранённый в чекпойнте id валидируем — провайдер мог быть удалён между
 * прогоном и resume, тогда PROVIDERS[providerId]=undefined уронил бы descriptor.
 */
export function selectSendProvider(input: {
  promptRoute: PromptRouteOverride | null
  overrideProviderId?: ProviderId
  overrideSelectedProviderId?: ProviderId
  checkpointRun: CheckpointRoute | null
  getProviderId: () => ProviderId
}): ProviderSelection {
  const resumedProviderId: ProviderId | null =
    isKnownProviderId(input.checkpointRun?.requestedProviderId) ? input.checkpointRun!.requestedProviderId : null
  const selectedProviderId: ProviderId | null =
    isKnownProviderId(input.overrideSelectedProviderId) ? input.overrideSelectedProviderId : null
  const providerId = input.promptRoute?.providerId ?? input.overrideProviderId ?? resumedProviderId ?? selectedProviderId ?? input.getProviderId()
  return { providerId, descriptor: PROVIDERS[providerId], resumedProviderId }
}

/**
 * 2.0.7-F: сохранённая requested-модель прогона применяется при resume ТОГО ЖЕ
 * провайдера (иначе взяли бы дефолт чата — потеря route).
 */
export function selectSendModel(input: {
  promptRoute: PromptRouteOverride | null
  overrideModel?: string | null
  overrideSelectedModel?: string | null
  providerId: ProviderId
  resumedProviderId: ProviderId | null
  checkpointRun: CheckpointRoute | null
  descriptor: ProviderDescriptor
  getProviderModel: (id: ProviderId) => string | null
}): string {
  const resumedModel = (input.resumedProviderId && input.resumedProviderId === input.providerId && input.checkpointRun?.requestedModel) || null
  const model = (input.promptRoute?.model ?? input.overrideModel ?? resumedModel ?? input.overrideSelectedModel ?? input.getProviderModel(input.providerId)) ?? input.descriptor.defaultModel
  return normalizeSelectedModel(model, input.descriptor)
}

export interface SmartRoutingPick {
  model: string
  previousModel: string
  complexity: string
}

/**
 * Smart routing: если пользователь не задал модель явно и effort=standard, выбираем
 * дешёвую/мощную модель по сложности запроса. Возвращает решение (null = не менять) —
 * логирование и ai:event остаются на вызывающей стороне.
 */
export function decideSmartRouting(input: {
  enabled: boolean
  overrideModel?: string | null
  overrideSelectedModel?: string | null
  overrideProviderId?: ProviderId
  effortLevel: 'quick' | 'standard' | 'deep'
  descriptor: ProviderDescriptor
  providerId: ProviderId
  model: string
  messages: ChatMessage[]
}): SmartRoutingPick | null {
  if (
    !input.enabled ||
    input.overrideModel ||
    input.overrideSelectedModel ||
    input.overrideProviderId ||          // не в Explicit Review
    input.effortLevel !== 'standard' ||
    input.descriptor.transport !== 'API'
  ) return null
  const complexity = estimateComplexity(input.messages, [])
  const suggested = recommendModel(input.providerId, complexity)
  if (!suggested || suggested === input.model) return null
  return { model: suggested, previousModel: input.model, complexity: complexityLabel(complexity) }
}

/**
 * 2.0.8-C: изолированный CODEX_HOME для Codex-провайдеров. `codex-cli` и нативный
 * `openai-codex-oauth` аутентифицируются ОДИНАКОВО — `codex login` пишет
 * `<CODEX_HOME>/auth.json` — поэтому ОБА резолвят один активный Codex-аккаунт (реестр
 * `codex-cli`) и получают его config-dir (свой auth.json → свой credential-store-стейт по
 * пути). Раньше codexHome резолвился ТОЛЬКО для `codex-cli` → openai-codex-oauth всегда шёл
 * в дефолтный `~/.codex/auth.json`, и переключение аккаунтов на нём не действовало (2.0.4).
 *
 * Никакой мутации `process.env.CODEX_HOME` (глобал всего Electron, гонка между чатами) —
 * codexHome течёт аргументом в конкретный provider instance. `|| null` (не `??`): пустая
 * строка configDir нормализуется в null, иначе '' утёк бы downstream и authFilePath('')
 * свалился бы на process.env/~/.codex, сломав изоляцию (ревью F2). null → дефолтный путь.
 */
export function resolveCodexHome(
  providerId: string,
  // Структурный тип: берём только configDir. Явный union принимает и ResolvedSubscription
  // (success с configDir | { unavailable } | { blocked }), и упрощённый resolve в тестах
  // ({ configDir }). blocked-вариант configDir не несёт → дефолтный путь; реальный стоп
  // по blocked делает send-хендлер ДО этого вызова (2.1.3-CD).
  resolve: ((p: string, chatId?: number) => { configDir?: string | null } | { unavailable: true } | { blocked: true } | { allBlocked: true } | null) | undefined,
  chatId?: number,
): string | null {
  if (!isCodexAuthProvider(providerId)) return null
  // 2.0.8-D2: chatId → pinned Codex-аккаунт чата. unavailable-вариант configDir не несёт →
  // null (дефолтный путь); реальный стоп по unavailable делает send-хендлер ДО этого вызова.
  const r = resolve?.('codex-cli', chatId)
  return (r && 'configDir' in r ? r.configDir : null) || null
}
