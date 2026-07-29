/**
 * Единый источник имени коннектора для ВЕРДИКТА и ИСПОЛНЕНИЯ (SEC-CMD-05).
 *
 * Гейт и хендлер обязаны судить и исполнять ОДНО И ТО ЖЕ значение. Пока это были
 * два независимых извлечения, между ними накопилось два расхождения, и оба
 * работали как обход:
 *
 *  1. Хендлер брал `args.id`, а гейты — `args.connector ?? args.id`. Вызов
 *     {id:'telegram', connector:'onec'} судился про `onec` (не ответственный,
 *     deny на telegram не матчится) и исполнялся в `telegram`.
 *  2. Канонизация алиаса (`ywordstat` → `yandex_wordstat`) жила в хендлере ПОСЛЕ
 *     гейта, поэтому правило на канонический id обходилось написанием алиаса.
 *
 * Поэтому здесь и алиасы, и извлечение: любой, кто судит или исполняет, зовёт
 * одну функцию. Модуль намеренно без зависимостей — его импортируют и слой
 * политики (permission-rules, responsible-action), и слой исполнения.
 */

/**
 * Исторические псевдонимы, которыми модель называет коннектор. Канонический id —
 * тот, что коннектор объявляет в `info().id` и по которому его знает реестр.
 */
const CONNECTOR_ID_ALIASES: Record<string, string> = {
  ywordstat: 'yandex_wordstat',
  yandex_wordstat_api: 'yandex_wordstat',
}

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** Привести имя к каноническому виду (алиасы + регистр). */
export function canonicalizeConnectorId(raw: string): string {
  const low = raw.trim().toLowerCase()
  return CONNECTOR_ID_ALIASES[low] ?? low
}

/**
 * Имя коннектора из аргументов вызова — то самое, которое будет исполнено.
 *
 * Источник ровно один: `id`. Схема инструмента другого поля не объявляет
 * (`tools.ts`, required:['id']), поэтому `connector` здесь НЕ читается: раньше
 * его чтение и создавало расхождение с исполнителем.
 */
export function canonicalConnectorId(args: Record<string, unknown> | undefined): string {
  return canonicalizeConnectorId(asText(args?.id))
}

/**
 * Аргументы называют коннектор двусмысленно? Возвращает текст отказа или null.
 *
 * Проверяем ровно идентификатор, а не весь набор ключей: параметры коннекторов
 * произвольны (entity/op/path/body/headers/…) и уходят в `rest` как есть, так что
 * allowlist ключей был бы либо неполным, либо ломал бы коннекторы. Двусмысленным
 * же был именно идентификатор — единственный ключ, по которому выносится вердикт.
 * Совпадающий дубль (после канонизации) конфликтом не считается: он безвреден.
 */
export function connectorIdConflict(args: Record<string, unknown> | undefined): string | null {
  const alt = asText(args?.connector)
  if (!alt) return null
  const canonicalAlt = canonicalizeConnectorId(alt)
  const canonicalId = canonicalConnectorId(args)
  if (canonicalAlt === canonicalId) return null
  return `connector_query: аргументы называют РАЗНЫЕ коннекторы — id="${asText(args?.id)}" и connector="${alt}". ` +
    'Схема инструмента объявляет только id; убери лишний ключ. ' +
    'Вызов отклонён целиком: иначе решение принималось бы про один коннектор, а запрос уходил бы в другой.'
}
