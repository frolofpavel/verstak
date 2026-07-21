/**
 * Auto Cross-Verify — после того как агент изменил файлы, автоматически
 * отправляем изменения ДРУГОМУ провайдеру для быстрого ревью.
 *
 * Цель: поймать баги которые основной агент мог пропустить,
 * без блокирования основного потока — результат приходит после done.
 */

import type { ProviderId } from './registry'
import { PROVIDERS, createProvider, isCodexAuthProvider } from './registry'

export interface TurnChange {
  file: string
  type: 'write' | 'patch'
  content: string
}

export interface CrossVerifyResult {
  provider: string
  result: string
  ok: boolean
}

// Priority order for picking review provider
const REVIEW_PRIORITY: ProviderId[] = ['claude', 'gemini-api', 'openai', 'grok']

/**
 * Pick a different provider for cross-verification.
 * Returns null if no suitable alternative is configured.
 */
export function pickReviewProvider(current: ProviderId, configuredProviders: ProviderId[]): ProviderId | null {
  const candidates = REVIEW_PRIORITY.filter(p => p !== current && configuredProviders.includes(p))
  if (candidates[0]) return candidates[0]
  // Fallback (найдено при добавлении тестов): если ни одного из priority-4
  // (claude/gemini/openai/grok) не сконфигурировано, берём ЛЮБОЙ другой
  // сконфигурированный API-провайдер — иначе cross-verify молча мёртв для
  // сетапов вроде «только DeepSeek/Qwen/Mistral» (все API, но не в priority).
  // EF-R1 Б2: codex-auth провайдеры исключены — им нужен изолированный аккаунт
  // (configDir), а cross-verify создаёт провайдера без resolver'а; молчаливый
  // default ~/.codex недопустим.
  return configuredProviders.find(p => p !== current && !isCodexAuthProvider(p)) ?? null
}

/**
 * Build the cross-verify prompt from the list of changed files in this turn.
 * Truncates each file to 3KB to keep the request fast.
 */
export function buildCrossVerifyPrompt(changes: TurnChange[]): string {
  const limited = changes.slice(0, 5)
  const filesSection = limited.map(c =>
    `### ${c.file}\n\`\`\`\n${c.content.slice(0, 3000)}\n\`\`\``
  ).join('\n\n')

  return `Быстрый ревью изменений кода. Найди только КРИТИЧЕСКИЕ проблемы — баги, потерю данных, security issues. Не комментируй стиль.

Изменённые файлы:

${filesSection}

Ответь кратко:
- Если всё ОК: "✅ Без замечаний"
- Если есть проблемы: "⚠️ N замечаний" + список`
}

/**
 * Run cross-verification against a different provider.
 * Never throws — on any error returns ok:true with a neutral message
 * so the UI doesn't show a scary error for a non-blocking feature.
 */
export async function runCrossVerify(
  providerId: ProviderId,
  prompt: string,
  getApiKey: (key: string) => string | null
): Promise<CrossVerifyResult> {
  const descriptor = PROVIDERS[providerId]
  if (!descriptor) {
    return { provider: providerId, result: 'Cross-verify: провайдер не найден', ok: true }
  }
  // EF-R1 Б2: codex-auth требует изолированного аккаунта (configDir из resolver'а);
  // здесь resolver'а нет — явный стоп ДО сети вместо молчаливого default ~/.codex.
  if (isCodexAuthProvider(providerId)) {
    return { provider: providerId, result: 'Cross-verify пропущен: аккаунт Codex требует изолированного запуска (default-вход не используем)', ok: true }
  }

  const apiKey = descriptor.secretKey ? getApiKey(descriptor.secretKey) : null
  if (descriptor.secretKey && !apiKey) {
    return { provider: providerId, result: 'Cross-verify: нет API ключа', ok: true }
  }

  // 15 second timeout
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15_000)

  try {
    const provider = createProvider(providerId, {
      apiKey,
      signal: ctrl.signal
    })

    const messages = [
      { role: 'user' as const, content: prompt }
    ]

    let resultText = ''
    for await (const event of provider.send(messages, [], undefined, ctrl.signal)) {
      if (event.type === 'text') {
        resultText += event.text
      }
      if (event.type === 'done' || event.type === 'error') break
      if (ctrl.signal.aborted) break
    }

    clearTimeout(timer)

    const text = resultText.trim() || 'Cross-verify: пустой ответ'
    const ok = text.startsWith('✅') || text.toLowerCase().includes('без замечаний')
    return { provider: descriptor.name, result: text, ok }
  } catch (err) {
    clearTimeout(timer)
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[cross-verify] failed:', msg.slice(0, 200))
    // Graceful degradation: error in cross-verify doesn't affect main flow
    return { provider: descriptor.name, result: 'Cross-verify недоступен', ok: true }
  }
}

/**
 * Determine which providers are currently configured (have API keys).
 * Only API providers can be used for cross-verify (CLI providers spawn processes
 * which is too heavy for a background fire-and-forget check).
 */
export function getConfiguredApiProviders(getApiKey: (key: string) => string | null): ProviderId[] {
  const result: ProviderId[] = []
  for (const [id, desc] of Object.entries(PROVIDERS) as Array<[ProviderId, typeof PROVIDERS[ProviderId]]>) {
    if (desc.transport !== 'API') continue
    if (!desc.secretKey) continue
    if (getApiKey(desc.secretKey)) result.push(id)
  }
  return result
}
