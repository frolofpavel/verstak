/**
 * Выбор провайдера для ГЕНЕРАЦИИ ПЛАНА (дефект 1 живой приёмки, 29.07).
 *
 * ЧТО СЛОМАЛОСЬ У ЖИВОГО ПОЛЬЗОВАТЕЛЯ. Генерация плана переиспользует
 * `runScheduledHeadless` — и это правильное решение (второй agent loop запрещён
 * ТЗ §2). Но у переиспользованного пути есть ограничение, которого у НОВОЙ
 * функции быть не должно: он рассчитан на прогон БЕЗ НАДЗОРА, поэтому отсекает
 * всё, кроме `transport === 'API'` с ключом. У Павла активный провайдер —
 * `codex-cli`, то есть подписка. Кнопка «Сгенерировать план» отвечала
 * «Провайдер codex-cli не годится для unattended (нужен API + ключ)», планов
 * ноль. На тестах было зелено, потому что в фикстурах провайдер API.
 *
 * ПОЧЕМУ ФОЛБЭК, А НЕ «ЗАПУСТИТЬ НА CLI». Здесь не вкусовщина, а свойство
 * рантайма: план создаётся ВЫЗОВОМ ИНСТРУМЕНТА `create_plan`, а инструменты
 * Verstak доступны только тем провайдерам, у которых `capabilities.tools` —
 * то есть `transport === 'API' && supportsTools` (см. `capabilitiesFor` в
 * shared/contracts/provider.ts). CLI и Tunnel исполняют инструменты ВНУТРИ
 * своего бинаря, наружу они их не отдают, и `runSubAgentLoop` от них вызова
 * `create_plan` не получит никогда. Значит выбор такой: осознанный фолбэк на
 * настроенный API-провайдер с честным объяснением — или отказ. Отказ мы уже
 * видели, он стоил приёмки.
 *
 * Модуль намеренно ЧИСТЫЙ: ни настроек, ни electron, ни сети — только реестр
 * провайдеров и предикат «есть ли ключ». Так решение проверяется на CLI-провайдере
 * без поднятия половины приложения.
 */
import { PROVIDERS, providerCapabilities, type ProviderDescriptor, type ProviderId } from './registry'

export interface PlanProviderChoice {
  /** На чём генерировать. null — генерировать не на чем, смотри `error`. */
  providerId: ProviderId | null
  /** Объяснение для интерфейса, если план собран НЕ на активном провайдере. */
  notice: string | null
  /** Что человеку сделать, если провайдера нет вовсе. Без внутренних терминов. */
  error: string | null
}

export interface PlanProviderInput {
  /** Провайдер, выбранный человеком в чате. */
  active: ProviderId
  /** Настроен ли ключ настройки (main отдаёт сюда getSecret). */
  hasSecret: (settingsKey: string) => boolean
}

/**
 * Что, КРОМЕ ключа, обязано быть настроено, иначе провайдер неработоспособен.
 *
 * Дефект живой проверки 29.07: у «Своего провайдера» ключ есть, значит он
 * проходил предикат «ключ задан» и считался настроенным — а без Base URL
 * `createProvider` бросает «укажи Base URL в Settings → Провайдеры», и фолбэка
 * не происходило вовсе. Тот же класс, что с `ollama`: «ключ есть» — такое же
 * «мы не знаем, настроен ли он», если провайдеру нужен ещё и адрес.
 */
export const EXTRA_REQUIRED_SETTINGS: Partial<Record<ProviderId, readonly string[]>> = {
  'custom-openai': ['custom_openai_baseurl'],
  'yandex-gpt': ['yandex_folder_id'],
  gigachat: ['gigachat_client_secret'],
}

/** Почему провайдер не годится для генерации плана. null — годится. */
type Unfit = 'no-tools' | 'no-key' | 'not-configured' | 'unknown'

function unfitReason(d: ProviderDescriptor | undefined, hasSecret: (k: string) => boolean): Unfit | null {
  if (!d) return 'unknown'
  // Инструменты — не украшение: без них `create_plan` не вызвать, а плана не будет.
  if (!providerCapabilities(d).tools) return 'no-tools'
  if (d.secretKey && !hasSecret(d.secretKey)) return 'no-key'
  const extra = EXTRA_REQUIRED_SETTINGS[d.id]
  if (extra && !extra.every(hasSecret)) return 'not-configured'
  return null
}

/**
 * Кандидаты на АВТОМАТИЧЕСКУЮ подмену.
 *
 * Сознательно строже, чем `unfitReason`: сюда попадают только провайдеры с
 * заданным ключом. Провайдер без ключа (локальный `ollama`) формально годится
 * всегда — но «годится всегда» здесь означает «мы не знаем, настроен ли он и
 * запущен ли вообще». Подменять молча на догадку значит менять одну непонятную
 * ошибку на другую. Ключ — это доказательство, что человек провайдер настраивал;
 * зашитый localhost доказательством не является.
 *
 * На АКТИВНЫЙ выбор человека это не распространяется: если он сам выбрал ollama,
 * генерация пойдёт на нём (см. `unfitReason`) — это его решение, а не наша догадка.
 */
function fallbackCandidates(hasSecret: (k: string) => boolean): ProviderDescriptor[] {
  return (Object.keys(PROVIDERS) as ProviderId[])
    .map(id => PROVIDERS[id])
    // Ключ обязателен ИМЕННО для автоподмены, плюс все прочие обязательные поля:
    // провайдер, которому кроме ключа нужен адрес, без адреса не настроен.
    .filter(d => !!d.secretKey && hasSecret(d.secretKey) && unfitReason(d, hasSecret) === null)
}

/** Имена провайдеров, которым достаточно добавить ключ, — для подсказки «что сделать». */
function candidateNames(): string[] {
  return (Object.keys(PROVIDERS) as ProviderId[])
    .map(id => PROVIDERS[id])
    .filter(d => providerCapabilities(d).tools && d.secretKey)
    .map(d => d.name)
    .slice(0, 3)
}

export function choosePlanGenerationProvider(input: PlanProviderInput): PlanProviderChoice {
  const active = PROVIDERS[input.active]
  const reason = unfitReason(active, input.hasSecret)
  if (reason === null) return { providerId: input.active, notice: null, error: null }

  const activeName = active?.name ?? input.active
  const fallback = fallbackCandidates(input.hasSecret)[0]

  if (!fallback) {
    // §(б): ни слова «unattended» и ни одного внутреннего термина — только действие.
    const names = candidateNames().join(', ')
    const why = reason === 'no-tools'
      ? `«${activeName}» выполняет инструменты внутри себя, и Verstak не может попросить его сохранить план.`
      : reason === 'not-configured'
        ? `Для «${activeName}» заполнены не все обязательные поля.`
        : `Ключ для «${activeName}» пока не задан.`
    return {
      providerId: null,
      notice: null,
      error: `${why} Откройте Настройки → Провайдеры и добавьте ключ любого из: ${names}. `
        + 'После этого нажмите «Сгенерировать план» ещё раз — текст задачи сохранён.',
    }
  }

  // §(а): фолбэк ОСОЗНАННЫЙ — человек видит, на чём собран план и почему не на его провайдере.
  const notice = reason === 'no-tools'
    ? `План собран на «${fallback.name}»: «${activeName}» работает по подписке через свой интерфейс `
      + 'и не отдаёт Verstak вызовы инструментов, которыми план сохраняется. На вашей работе в чате это никак не сказывается.'
    : reason === 'not-configured'
      ? `План собран на «${fallback.name}»: у «${activeName}» заполнены не все обязательные поля — проверьте Настройки → Провайдеры.`
      : `План собран на «${fallback.name}»: ключ для «${activeName}» пока не задан.`

  return { providerId: fallback.id, notice, error: null }
}
