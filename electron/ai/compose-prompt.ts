import { SYSTEM_LAYER_PROMPT, SYSTEM_LAYER_VERSION } from './system-layer'
import type { UserLayer } from './user-layer'

const SKILL_COMPLIANCE_CONTRACT = `<skill_compliance_contract>
If a <skill_layer> is present, it is mandatory execution guidance, not optional advice.
- Before acting, identify which parts/checklists of the skill apply to the user's request.
- Execute every applicable required step from the skill. Do not silently skip steps because they are inconvenient or time-consuming.
- If a skill step is impossible because data/tool/access is missing, stop and report the blocker instead of pretending it was optional.
- Before the final answer, self-check the completed work against the applicable skill steps. If something was missed, complete it or clearly report the blocker.
- Never answer that you "decided to skip", "ignored", or "did not follow" an applicable skill.
</skill_compliance_contract>`

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
    ? `\n\n${SKILL_COMPLIANCE_CONTRACT}\n\n<skill_layer>\n${trimmedSkill}\n</skill_layer>`
    : ''
  // Мягкий nudge: перед сложной/многофайловой/деструктивной задачей объявить
  // план через preflight. НЕ для тривиальных одиночных правок — иначе раздражает.
  const preflightHint = '\n\n<preflight_hint>\nПеред сложной, многофайловой или деструктивной задачей сначала вызови preflight (план: затронутые зоны, уровень риска, что проверить после, что вне scope / запреты), затем выполняй. Для тривиальной одиночной правки preflight не нужен.\n</preflight_hint>'
  const system = `${SYSTEM_LAYER_PROMPT}${userBlock}${packBlock}${skillBlock}${preflightHint}`

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
