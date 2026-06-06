import { SYSTEM_LAYER_PROMPT, SYSTEM_LAYER_VERSION } from './system-layer'
import type { UserLayer } from './user-layer'

export interface ComposedPrompt {
  /** Final string to put in the API's `system` field (or system message). */
  system: string
  /** Metadata for telemetry / UI. */
  meta: {
    systemLayerVersion: string
    userLayerPath: string | null
    userLayerBytes: number
    contextPackBytes: number
  }
}

export function composeSystemPrompt(userLayer: UserLayer, contextPack = '', skillPrompt = ''): ComposedPrompt {
  const trimmedUser = userLayer.content.trim()
  const trimmedPack = contextPack.trim()
  const trimmedSkill = skillPrompt.trim()
  const userBlock = trimmedUser
    ? `\n\n<user_layer source="${userLayer.path}">\n${trimmedUser}\n</user_layer>`
    : ''
  const packBlock = trimmedPack ? `\n\n${trimmedPack}` : ''
  // Слой 4 — специализация активного скилла. Наслаивается ПОВЕРХ базового
  // протокола (system-layer + user-layer + context-pack), не заменяя его:
  // скилл уточняет роль и стиль, но 7-шаговый цикл выполнения остаётся.
  const skillBlock = trimmedSkill
    ? `\n\n<skill_layer>\n${trimmedSkill}\n</skill_layer>`
    : ''
  const system = `${SYSTEM_LAYER_PROMPT}${userBlock}${packBlock}${skillBlock}`

  return {
    system,
    meta: {
      systemLayerVersion: SYSTEM_LAYER_VERSION,
      userLayerPath: userLayer.path,
      userLayerBytes: trimmedUser.length,
      contextPackBytes: trimmedPack.length
    }
  }
}
