import { PROVIDERS } from './registry'
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
): SummaryProviderChoice | null {
  const usable = (id: ProviderId): SummaryProviderChoice | null => {
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
