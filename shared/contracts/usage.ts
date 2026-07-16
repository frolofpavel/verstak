// ЕДИНЫЙ КОНТРАКТ USAGE-ТОКЕНОВ — срез 2.0.8-E. Без рантайм-зависимостей (импортируют main и
// renderer). Нормализует usage всех провайдеров к одной модели с ЯВНОЙ семантикой кэша.
//
// Два дефекта, которые чинит контракт (см. карту адаптеров):
//  A. cache write (`cacheWriteTokens`) раньше эмитил только Claude API и не читал НИКТО →
//     стоимость записи кэша (~1.25× input у Claude) выпадала из cost-cap. Теперь поле сквозное.
//  B. `billableInput = max(0, input − cached)` в cost-guard/pricing ВЕРНО для inclusive-провайдеров
//     (OpenAI/Gemini/Codex-Responses: cached ⊂ reported input) и НЕВЕРНО для Claude (exclusive:
//     input_tokens УЖЕ без кэша → повторное вычитание занижало billable, клампилось в 0 на больших
//     cache-hit). Семантику фиксирует `inputAccounting`, а вычитание делает ОДИН helper billableInputTokens.

/** Входят ли cached-токены в reported input провайдера. */
export type InputAccounting =
  | 'exclusive' // cached НЕ входит в input (Claude: input_tokens отдельно от cache_read/creation)
  | 'inclusive' // cached ⊂ input (OpenAI/Gemini/Codex-Responses: cached — подмножество reported input)
  | 'unknown'   // семантика не подтверждена (не вычитать cached — каветат карточки)

export interface NormalizedUsage {
  /** Reported input провайдера. null = «провайдер не сообщил» (НЕ ноль). */
  inputTokens: number | null
  outputTokens: number | null
  /** Прочитано из кэша (cache read / cached prompt). null = не сообщил. */
  cacheReadTokens: number | null
  /** Записано в кэш (Claude cache_creation). null = не сообщил / провайдер не поддерживает. */
  cacheWriteTokens: number | null
  inputAccounting: InputAccounting
  /** Аудит: raw reported input до нормализации billable (= inputTokens когда сообщён). */
  providerReportedInputTokens?: number
  model?: string

  // ─── Deprecated-мост для 2-коммитного среза (commit 1 адаптеры → commit 2 потребители) ───
  // Старые потребители (cost-guard/pricing/journal/store) читают эти имена; commit 2 мигрирует их
  // на cacheReadTokens/cacheWriteTokens + billableInputTokens. Убрать после миграции (аудит 2.0.10-G).
  /** @deprecated старое имя cacheReadTokens. */
  cachedInputTokens?: number
  /** @deprecated старое имя cacheWriteTokens. */
  cacheCreationInputTokens?: number
}

/** Вход для сборки NormalizedUsage из raw-полей адаптера (undefined-able → null-нормализуется). */
export interface RawUsageParts {
  inputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  inputAccounting: InputAccounting
  model?: string
}

/**
 * Собирает NormalizedUsage из raw-частей адаптера. Нормализует null НА ГРАНИЦЕ (каветат #1:
 * `undefined`/не сообщено → null, а НЕ 0). Ставит deprecated-мост для старых потребителей.
 */
export function normalizedUsage(p: RawUsageParts): NormalizedUsage {
  const inputTokens = p.inputTokens ?? null
  const outputTokens = p.outputTokens ?? null
  const cacheReadTokens = p.cacheReadTokens ?? null
  const cacheWriteTokens = p.cacheWriteTokens ?? null
  const u: NormalizedUsage = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    inputAccounting: p.inputAccounting,
  }
  if (inputTokens != null) u.providerReportedInputTokens = inputTokens
  if (p.model) u.model = p.model
  // Deprecated-мост: старые потребители читают эти имена (0 — их прежний дефолт до commit 2).
  u.cachedInputTokens = cacheReadTokens ?? 0
  u.cacheCreationInputTokens = cacheWriteTokens ?? 0
  return u
}

/**
 * Billable (не-кэшированный «свежий») input — то, что pricing умножает на input-цену. ЕДИНСТВЕННОЕ
 * место, где вычитается cached, и только при ПОДТВЕРЖДЁННОЙ inclusive-семантике (каветат #4):
 *  · inclusive + оба сообщены → max(0, input − cacheRead);
 *  · exclusive → input как есть (cached уже вне input — вычитать НЕЛЬЗЯ, это дефект B у Claude);
 *  · unknown → input как есть (не вычитаем без подтверждения).
 * null (input не сообщён) → null (НЕ 0).
 */
export function billableInputTokens(
  u: Pick<NormalizedUsage, 'inputTokens' | 'cacheReadTokens' | 'inputAccounting'>,
): number | null {
  if (u.inputTokens == null) return null
  if (u.inputAccounting === 'inclusive' && u.cacheReadTokens != null) {
    return Math.max(0, u.inputTokens - u.cacheReadTokens)
  }
  return u.inputTokens
}
