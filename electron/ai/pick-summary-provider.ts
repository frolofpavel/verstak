import { PROVIDERS, isCodexAuthProvider } from './registry'
import type { ProviderId } from './registry'

/**
 * Кем сжимать контекст — срез 2.0.11-B.
 *
 * Почему это не «просто активный провайдер чата». Summary — отдельный одноразовый вызов
 * (не agent-loop). CLI-провайдеры так не умеют дёшево: каждый их ход сериализует всю
 * историю в one-shot. Значит нужен API-провайдер с ключом.
 *
 * Но у человека на подписке (claude-cli / codex-cli) активным как раз стоит CLI. Правило
 * «сжимаем только активным» сделало бы кнопку сжатия для него вечно серой — фича есть, а
 * работать не может. Поэтому: активный API-провайдер, иначе ЛЮБОЙ настроенный API — по
 * фиксированному порядку каталога, чтобы выбор был предсказуемым, а не «как повезёт».
 *
 * Сжимать не тем провайдером, которым идёт разговор, — нормально и даже дешевле. UI обязан
 * честно показать, кем сжал (для этого providerId возвращается наружу).
 */

export interface SummaryProviderChoice {
  providerId: ProviderId
  model: string
  secretKey: string
}

/**
 * @param activeId — провайдер, выбранный в чате.
 * @param hasKey — есть ли ключ у провайдера (getSecret на его secretKey).
 * @param getModel — модель, выбранная пользователем для провайдера (null → дефолт каталога).
 */
export function pickSummaryProvider(
  activeId: ProviderId | null,
  hasKey: (secretKey: string) => boolean,
  getModel: (id: ProviderId) => string | null,
  exclude?: ReadonlySet<string>,
): SummaryProviderChoice | null {
  const usable = (id: ProviderId): SummaryProviderChoice | null => {
    if (exclude?.has(id)) return null
    const d = PROVIDERS[id]
    if (!d || d.transport !== 'API' || !d.secretKey) return null
    if (!hasKey(d.secretKey)) return null
    const model = getModel(id) ?? d.defaultModel
    if (!model) return null
    return { providerId: id, model, secretKey: d.secretKey }
  }

  // 1. Активный — если он API с ключом. Разговор и сжатие на одной модели предсказуемее.
  if (activeId) {
    const active = usable(activeId)
    if (active) return active
  }

  // 2. Иначе — первый настроенный API из каталога. Порядок фиксирован объявлением
  //    PROVIDERS: один и тот же набор ключей всегда даёт один и тот же выбор.
  for (const id of Object.keys(PROVIDERS) as ProviderId[]) {
    const choice = usable(id)
    if (choice) return choice
  }

  return null
}


// ─── EF-R2 Б3: gated-вариант для ручной компакции ────────────────────────────

/** Упрощённый структурный срез ResolvedSubscription (полный тип — в
 *  ai/resolve-subscription-account): нужны только configDir и маркеры стопа. */
export type SummaryAccountResolution =
  | { configDir?: string | null }
  | { unavailable: true }
  | { blocked: true }
  | { allBlocked: true }
  | null

export interface GatedSummaryChoice extends SummaryProviderChoice {
  /** codexHome для codex-oauth: configDir аккаунта из canonical resolver'а.
   *  null — провайдер не codex ИЛИ парка нет (legacy: дефолтный ~/.codex допустим). */
  codexHome: string | null
}

/**
 * EF-R2 Б3: выбор summary-провайдера для ручной компакции С учётом подписочного
 * парка. Codex OAuth — полноценный production entry point: если выбран он, аккаунт
 * проходит через ТОТ ЖЕ canonical resolver, что и ai:send:
 *  - success → codexHome = configDir аккаунта (изоляция мультиаккаунта);
 *  - blocked/allBlocked/unavailable → НИКАКОГО default ~/.codex: безопасный fallback
 *    на другой настроенный API-провайдер, либо null (явный нейтральный отказ);
 *  - парка нет (resolver → null / не передан) → прежний legacy-путь.
 */
export function pickSummaryProviderGated(
  activeId: ProviderId | null,
  hasKey: (secretKey: string) => boolean,
  getModel: (id: ProviderId) => string | null,
  resolveAccount?: (providerId: string) => SummaryAccountResolution,
): GatedSummaryChoice | null {
  const choice = pickSummaryProvider(activeId, hasKey, getModel)
  if (!choice) return null
  if (!isCodexAuthProvider(choice.providerId)) return { ...choice, codexHome: null }

  const sub = resolveAccount?.(choice.providerId) ?? null
  if (sub && ('unavailable' in sub || 'blocked' in sub || 'allBlocked' in sub)) {
    // Парк есть, но неготов — сеть через default credential ЗАПРЕЩЕНА. Ищем другой
    // summary provider вне codex-семейства (оба id исключаем — у них общий парк).
    const alt = pickSummaryProvider(activeId, hasKey, getModel, new Set(['codex-cli', 'openai-codex-oauth']))
    return alt ? { ...alt, codexHome: null } : null
  }
  if (sub && 'configDir' in sub) return { ...choice, codexHome: sub.configDir || null }
  return { ...choice, codexHome: null }
}
