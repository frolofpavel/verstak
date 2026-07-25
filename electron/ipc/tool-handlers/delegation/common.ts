import type { ToolContext } from '../shared'
import type { ProviderId, CreateOptions } from '../../../ai/registry'
import { isCodexAuthProvider } from '../../../ai/registry'

export const MAX_WORKTREE_DIFF_CHARS = 6000

// Таймаут на одну делегированную подзадачу. Поднят с 60с (one-shot эра) до 180с:
// субагент теперь крутит agent-loop с tool-вызовами (read/patch/run_command),
// что требует заметно больше времени. Лимит итераций (MAX_SUB_ITERATIONS) —
// вторая, независимая граница; таймаут страхует от зависшего провайдера/команды.
export const SUB_TASK_TIMEOUT_MS = 180_000

// Cost-cap на ОДИН delegate_parallel вызов (помимо cap всей сессии из Settings).
// Защищает от батча из 30 задач, который один пожрёт весь бюджет: при превышении
// оставшиеся задачи батча не стартуют. В центах. Дефолт $3 — можно переопределить
// аргументом cost_cap_usd у delegate_parallel.
export const DEFAULT_BATCH_COST_CAP_CENTS = 300

// ============================================================================

/**
 * Собрать опции для createProvider субагента. grok-версия ограничивалась
 * {apiKey, model, cwd, signal} — для verstak этого мало: российские и custom
 * провайдеры требуют дополнительные секреты:
 *   - yandex-gpt    → yandexFolderId (yandex_folder_id)
 *   - gigachat      → gigachatClientSecret (gigachat_client_secret)
 *   - custom-openai → customBaseUrl/customModels (custom_openai_baseurl/_models)
 *   - verstak-gateway → customBaseUrl (verstak_gateway_baseurl kill-switch)
 *   - claude-cli    → claudeOauthToken (claude_code_oauth_token, для headless+Max)
 * Секреты добираются через ctx.getSecretForDelegate (тот же reader, что и в
 * главном ai.ts:405-427). Без этого суб на 4+ провайдерах падает «Folder ID
 * не задан / Client Secret не задан / Base URL не задан».
 */
// export — для прямого unit-теста Б2-гейта (e2e через handle() уходит в реальный
// CLI spawn и не завершается в тестовой среде).
export function buildSubCreateOptions(
  providerId: ProviderId,
  apiKey: string | null,
  model: string,
  signal: AbortSignal,
  ctx: ToolContext
): CreateOptions {
  const getSecret = ctx.getSecretForDelegate
  let customModels: string[] | undefined
  let customBaseUrl: string | undefined
  if (providerId === 'custom-openai') {
    const modelsRaw = getSecret?.('custom_openai_models')
    if (modelsRaw) customModels = modelsRaw.split(',').map(s => s.trim()).filter(Boolean)
    customBaseUrl = getSecret?.('custom_openai_baseurl') ?? undefined
  } else if (providerId === 'verstak-gateway') {
    customBaseUrl = getSecret?.('verstak_gateway_baseurl') ?? undefined
  }
  // EF-R1 Б2: sub-agent на подписочном провайдере идёт через ТОТ ЖЕ единый resolver,
  // что и родительский прогон. Аккаунт заблокирован/все неготовы → явный стоп ДО сети
  // (throw → человеческая карточка ошибки делегирования), а НЕ молчаливый default
  // credential (legacy env-токен / ~/.codex). Парка нет (resolver → null) → legacy-путь.
  let claudeOauthToken: string | null | undefined
  let codexHome: string | null | undefined
  if (providerId === 'claude-cli' || isCodexAuthProvider(providerId)) {
    const durableAccountId = ctx.parentJobId && ctx.agentJobs
      ? ctx.agentJobs.get(ctx.parentJobId)?.accountId ?? null
      : null
    const sub = ctx.resolveSubscriptionAccount?.(
      providerId,
      ctx.parentChatId ?? undefined,
      durableAccountId == null ? undefined : { accountId: durableAccountId },
    ) ?? null
    if (sub && 'unavailable' in sub) {
      throw new Error(`Делегирование остановлено: аккаунт ${providerId} был удалён. Выберите другой аккаунт в Настройки → Подписки.`)
    }
    if (sub && 'blocked' in sub) {
      throw new Error(sub.reason === 'cooling'
        ? `Делегирование остановлено: аккаунт «${sub.label}» остывает после лимита.`
        : `Делегирование остановлено: аккаунт «${sub.label}» требует входа.`)
    }
    if (sub && 'allBlocked' in sub) {
      throw new Error(sub.reason === 'cooling'
        ? `Делегирование остановлено: все аккаунты ${providerId} (${sub.count}) остывают после лимита.`
        : `Делегирование остановлено: все аккаунты ${providerId} (${sub.count}) требуют входа.`)
    }
    if (providerId === 'claude-cli') {
      claudeOauthToken = sub && 'secret' in sub ? sub.secret : (getSecret?.('claude_code_oauth_token') ?? null)
    } else {
      codexHome = sub && 'configDir' in sub ? (sub.configDir || null) : null
    }
  }
  return {
    apiKey,
    model,
    cwd: ctx.projectPath,
    signal,
    claudeOauthToken,
    codexHome,
    customBaseUrl,
    customModels,
    yandexFolderId: providerId === 'yandex-gpt' ? (getSecret?.('yandex_folder_id') ?? undefined) : undefined,
    gigachatClientSecret: providerId === 'gigachat' ? (getSecret?.('gigachat_client_secret') ?? undefined) : undefined,
    gigachatTlsVerify: providerId === 'gigachat' ? (getSecret?.('gigachat_tls_verify') === 'true') : undefined,
    agentMode: ctx.agentMode
  }
}

// ============================================================================
// delegate_task — мультиагент V1
// ============================================================================

/**
 * Нормализует и дедуплицирует поле `id` у элементов батча IN-PLACE. Пустой id →
 * `<prefix>-N`, повтор → `id#2`, `id#3`… Нужно потому что subCallId строится как
 * `${call.id}:${item.id}` — дубль id схлопывает карточки субагентов (upsert по
 * callId) и ломает дерево суб-сессий. id — модельный ввод, программно не уникален.
 */
export function dedupeTaskIds(items: Array<{ id: string }>, prefix = 'task'): void {
  const seen = new Set<string>()
  items.forEach((item, i) => {
    let id = String(item.id ?? '').trim() || `${prefix}-${i + 1}`
    if (seen.has(id)) {
      let n = 2
      while (seen.has(`${id}#${n}`)) n++
      id = `${id}#${n}`
    }
    seen.add(id)
    item.id = id
  })
}

