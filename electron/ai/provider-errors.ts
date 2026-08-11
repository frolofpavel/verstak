/**
 * Б3.3 (живая приёмка 11.08): понятная причина отказа провайдера вместо голого
 * сообщения SDK.
 *
 * ЖИВОЙ ФАКТ. kimi-coding с протухшей подпиской Павла упал за 1.5 с, и в
 * карточку ошибки уехало сырое сообщение — по нему не понять ни причину
 * («подписка неактивна»), ни что делать («проверь ключ»).
 *
 * ГРАНИЦА. Переводим только то, что понимаем: 401/403 (ключ отклонён —
 * подписка неактивна / ключ отозван) и 402/insufficient_* (деньги/квота).
 * Всё остальное (429, 5xx, сеть) → null: сырое сообщение честнее выдуманного
 * перевода, а ретраи/фолбэк этих статусов живут в with-retry и route-policy.
 * Verstak Gateway сюда не ходит — у него свой mapGatewayError (gateway-meta.ts).
 */

export function mapProviderAuthError(
  providerName: string,
  status: number | undefined,
  code?: string | undefined,
): string | null {
  const c = (code ?? '').toLowerCase()
  if (status === 401 || status === 403 || c === 'invalid_api_key' || c === 'account_deactivated') {
    return `${providerName}: ключ отклонён провайдером (HTTP ${status ?? 401}). ` +
      'Обычные причины: подписка неактивна или истекла, ключ отозван либо протух. ' +
      'Проверь подписку в кабинете провайдера и ключ в Настройках → Модели.'
  }
  if (status === 402 || c === 'insufficient_balance' || c === 'insufficient_quota' || c === 'insufficient_user_quota') {
    return `${providerName}: у провайдера закончились средства или квота (HTTP ${status ?? 402}). ` +
      'Пополни баланс или проверь лимиты тарифа в кабинете провайдера.'
  }
  return null
}
