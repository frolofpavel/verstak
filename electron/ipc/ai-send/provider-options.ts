// Распил ai.ts (2.1.10-G): провайдер-специфичные опции createProvider для ai:send.
//
// Вынесено из registerAiIpc БЕЗ изменения логики. Раньше это был плоский участок из
// семи условных чтений секретов внутри try-блока создания провайдера — по одному
// на особенность конкретного провайдера (OAuth-токен Claude Code, изолированный
// CODEX_HOME, custom endpoint, вторые секреты YandexGPT/GigaChat, TLS-политика,
// гейт живого каталога grok-cli).
//
// Инвариант, ради которого блок стоит держать одной функцией (EF-R2 Б1): credentials
// и codexHome берутся ТОЛЬКО из уже разрезолвленного аккаунта попытки (mainAcct), а не
// повторным resolve после await'ов — иначе провайдер ушёл бы на аккаунт B при
// run.accountId = A.

import { isCodexAuthProvider, type ProviderId } from '../../ai/registry'
import { loadLiveCatalog, checkModelAvailable } from '../../ai/model-catalog-service'
import { resolveCodexHome } from './route-selection'
import type { SubscriptionSuccess } from './account-preflight'

export interface ProviderRuntimeOptions {
  claudeOauthToken: string | null
  codexHome: string | null
  customBaseUrl: string | undefined
  customModels: string[] | undefined
  yandexFolderId: string | undefined
  gigachatClientSecret: string | undefined
  gigachatTlsVerify: boolean | undefined
  checkModel: ((model: string) => ReturnType<typeof checkModelAvailable>) | undefined
}

export function buildProviderRuntimeOptions(input: {
  providerId: ProviderId
  /** Аккаунт попытки — единый resolve (EF-R2 Б1). null → legacy-путь одиночных секретов. */
  account: SubscriptionSuccess | null
  chatId?: number
  getSecret: (key: string) => string | null
  /** Тот же резолвер, что принимает resolveCodexHome — берём его тип, чтобы legacy-путь
   *  не потребовал приведения. */
  resolveSubscriptionAccount?: Parameters<typeof resolveCodexHome>[1]
}): ProviderRuntimeOptions {
  const { providerId, account, getSecret } = input
  // Claude Code OAuth token (из `claude setup-token`) — для headless+Max.
  // 1.9.3 мультиаккаунт: токен ИМЕННО аккаунта прогона (mainAcct — единый resolve
  // EF-R2 Б1, тот же, что дал run.accountId); парка нет → legacy-одиночный токен settings.
  const claudeOauthToken = providerId === 'claude-cli'
    ? (account?.secret ?? getSecret('claude_code_oauth_token'))
    : null
  // Codex мультиаккаунт (2.0.8-C): CODEX_HOME аккаунта прогона (тот же mainAcct —
  // никакого повторного resolve после await, EF-R2 Б1). Парка нет (mainAcct=null) →
  // прежний legacy-путь resolveCodexHome (дефолтный ~/.codex вне управляемого парка).
  const codexHome = isCodexAuthProvider(providerId)
    ? (account
        ? (account.configDir || null)
        : resolveCodexHome(providerId, input.resolveSubscriptionAccount, input.chatId))
    : null
  // custom-openai: baseUrl + список моделей задаются юзером в Settings.
  // models приходят как comma-separated string; парсим в массив.
  let customBaseUrl: string | undefined
  let customModels: string[] | undefined
  if (providerId === 'custom-openai') {
    customBaseUrl = getSecret('custom_openai_baseurl') ?? undefined
    const modelsRaw = getSecret('custom_openai_models')
    if (modelsRaw) {
      customModels = modelsRaw.split(',').map(s => s.trim()).filter(Boolean)
    }
  } else if (providerId === 'verstak-gateway') {
    // Override РФ-релея без релиза (kill-switch): задан verstak_gateway_baseurl —
    // используем его вместо дефолтного релея. Пусто → дефолт из spec.
    customBaseUrl = getSecret('verstak_gateway_baseurl') ?? undefined
  }
  // YandexGPT и GigaChat имеют по второму секрету: yandex_folder_id и
  // gigachat_client_secret. Они хранятся отдельно в SafeStorage и
  // пробрасываются в registry.createProvider() через extension options.
  const yandexFolderId = providerId === 'yandex-gpt'
    ? (getSecret('yandex_folder_id') ?? undefined)
    : undefined
  const gigachatClientSecret = providerId === 'gigachat'
    ? (getSecret('gigachat_client_secret') ?? undefined)
    : undefined
  // Аудит M3: TLS-верификация GigaChat по настройке (по умолчанию выкл).
  const gigachatTlsVerify = providerId === 'gigachat'
    ? (getSecret('gigachat_tls_verify') === 'true')
    : undefined
  // 2.0.7-E: гейт живого каталога для grok-cli. Читает кешированный каталог (settings)
  // и решает, блокировать ли запрошенную модель. Только для grok-cli (первый live-адаптер).
  const checkModel = providerId === 'grok-cli'
    ? (m: string) => checkModelAvailable(loadLiveCatalog({ get: getSecret, set: () => {} }, 'grok-cli'), m, Date.now())
    : undefined
  return {
    claudeOauthToken,
    codexHome,
    customBaseUrl,
    customModels,
    yandexFolderId,
    gigachatClientSecret,
    gigachatTlsVerify,
    checkModel,
  }
}
