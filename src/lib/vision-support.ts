import type { ProviderId } from '../hooks/useProvider'

/** Провайдеры, куда картинки не уходят (CLI — только текст; API без image-parts). */
const NO_VISION = new Set<ProviderId>([
  'gemini-cli', 'claude-cli', 'grok-cli', 'codex-cli',
  'yandex-gpt', 'gigachat',
])

/** Семейство бренда: CLI и API одного вендора в одной группе. */
export function providerFamily(id: ProviderId): string {
  if (id === 'gemini-api' || id === 'gemini-cli') return 'gemini'
  if (id === 'claude' || id === 'claude-cli') return 'claude'
  if (id === 'grok' || id === 'grok-cli') return 'grok'
  if (id === 'openai' || id === 'codex-cli') return 'openai'
  return id
}

export const FAMILY_LABELS: Record<string, string> = {
  gemini: 'Gemini',
  claude: 'Claude',
  grok: 'Grok',
  openai: 'ChatGPT',
}

/** API-провайдер того же семейства, что и CLI (для подсказки «переключитесь на…»). */
export const CLI_API_SIBLING: Partial<Record<ProviderId, ProviderId>> = {
  'grok-cli': 'grok',
  'claude-cli': 'claude',
  'gemini-cli': 'gemini-api',
  'codex-cli': 'openai',
}

export function providerSupportsVision(id: ProviderId): boolean {
  return !NO_VISION.has(id)
}

export function isImageAttachment(mimeType: string): boolean {
  return mimeType.startsWith('image/')
}

export interface VisionProviderLite {
  id: ProviderId
  name: string
  shortLabel?: string
  models: string[]
  defaultModel: string
  transport: 'API' | 'CLI' | 'Tunnel'
}

export interface VisionAlternative {
  providerId: ProviderId
  providerLabel: string
  model: string
  authorized: boolean
}

function modelKey(providerId: string, model: string): string {
  return `${providerId}::${model}`
}

/**
 * Модели с vision в том же семействе, что и текущий провайдер.
 * Сначала включённые в enabled_models, иначе default провайдера.
 */
export function buildVisionAlternatives(
  currentProviderId: ProviderId,
  providers: VisionProviderLite[],
  enabledModels: Set<string>,
  authorizedIds: Set<string>,
): VisionAlternative[] {
  if (providerSupportsVision(currentProviderId)) return []

  const family = providerFamily(currentProviderId)
  const out: VisionAlternative[] = []

  for (const p of providers) {
    if (providerFamily(p.id) !== family) continue
    if (!providerSupportsVision(p.id)) continue
    if (p.id === currentProviderId) continue

    const label = p.shortLabel || p.name
    const authorized = authorizedIds.has(p.id)
    const models = p.models.length > 0 ? p.models : [p.defaultModel].filter(Boolean)
    const enabled = models.filter(m => enabledModels.has(modelKey(p.id, m)))
    const list = enabled.length > 0 ? enabled : [p.defaultModel || models[0]].filter(Boolean)

    for (const m of list) {
      out.push({ providerId: p.id, providerLabel: label, model: m, authorized })
    }
  }

  if (out.length === 0) {
    const siblingId = CLI_API_SIBLING[currentProviderId]
    if (siblingId) {
      const p = providers.find(x => x.id === siblingId)
      if (p && !authorizedIds.has(siblingId)) {
        out.push({
          providerId: siblingId,
          providerLabel: p.shortLabel || p.name,
          model: p.defaultModel,
          authorized: false,
        })
      }
    }
  }

  return out
}

export function familyLabelForProvider(id: ProviderId): string {
  return FAMILY_LABELS[providerFamily(id)] ?? id
}
