// Skill-промпты и task-контракты (фаза 5, срез 2): чистые функции, вынесенные
// из Chat.tsx (бывшие module-level строки ~298-546). Поведение 1-в-1. Chat.tsx
// импортирует отсюда skillDisplayName/toAppliedSkillRef/resolveAppliedSkillDetails/
// AUTO_BOUND_SKILL_MIN_SCORE; основной путь send() — остальное.
import type { AppliedSkillRef, ChatMessage, Skill } from '../../types/api'

const SKILL_ANTI_STALL_NUDGE = '\n\n---\nВАЖНО (Verstak): если пользователь дал ясный прямой запрос — выполни его прямо в этом чате и выдай результат. Не зацикливайся, прося оформить «пакет задачи», «одну фразу цели» или ждать отдельного «ок», если намерение уже понятно.'

export function skillDisplayName(skill: Pick<Skill, 'id' | 'name'> | AppliedSkillRef): string {
  return skill.name?.trim() || skill.id
}

function escapePromptAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function toAppliedSkillRef(skill: Skill): AppliedSkillRef {
  return {
    id: skill.id,
    ...(skill.name?.trim() ? { name: skill.name.trim() } : {}),
    ...(skill.icon?.trim() ? { icon: skill.icon.trim() } : {}),
    ...(skill.description?.trim() ? { description: skill.description.trim() } : {}),
  }
}

export function resolveAppliedSkillDetails(applied: AppliedSkillRef[], skills: Skill[]): Skill[] {
  const byId = new Map(skills.map(skill => [skill.id, skill]))
  return applied.flatMap(ref => {
    const skill = byId.get(ref.id)
    return skill ? [skill] : []
  })
}

export function uniqueSkills(skills: Array<Skill | null | undefined>): Skill[] {
  const seen = new Set<string>()
  const result: Skill[] = []
  for (const skill of skills) {
    if (!skill || seen.has(skill.id)) continue
    seen.add(skill.id)
    result.push(skill)
  }
  return result
}

export function mergeToolAllow(skills: Array<Skill | null | undefined>): string[] | undefined {
  const merged = new Set<string>()
  for (const skill of skills) {
    for (const tool of skill?.tools_allow ?? []) {
      if (tool.trim()) merged.add(tool.trim())
    }
  }
  return merged.size ? [...merged] : undefined
}

export function firstRecipe(skills: Array<Skill | null | undefined>) {
  return skills.find(skill => skill?.recipe)?.recipe
}

function buildAppliedSkillsSystemPrompt(appliedSkills: Skill[], userText: string): string {
  if (appliedSkills.length === 0) return ''
  const lines: string[] = [
    '## Скиллы, применённые к текущему пользовательскому сообщению',
    '',
    'Пользователь явно применил эти скиллы к последнему сообщению. Это не отдельные задачи и не глобальный режим чата.',
    'Используй инструкции скиллов строго для релевантных частей текущего запроса. Остальные части запроса не игнорируй: выполни их обычным способом или подбери подходящий общий подход.',
    'Если конкретный скилл не подходит к части запроса, коротко объясни почему и продолжай выполнять остальные части.',
    '',
    '<current_user_request>',
    userText.trim(),
    '</current_user_request>',
  ]

  appliedSkills.forEach((skill, index) => {
    lines.push(
      '',
      `<applied_skill index="${index + 1}" id="${escapePromptAttr(skill.id)}" name="${escapePromptAttr(skillDisplayName(skill))}">`,
      skill.description ? `Назначение: ${skill.description}` : 'Назначение: пользователь применил этот скилл к текущему сообщению.',
      'Инструкция: применяй этот регламент к той части пользовательского запроса, которая соответствует назначению скилла.',
      '<skill_instructions>',
      skill.systemPrompt.trim(),
      '</skill_instructions>',
      '</applied_skill>'
    )
  })

  return lines.join('\n')
}

export const AUTO_BOUND_SKILL_MIN_SCORE = 14

function buildAutoBoundSkillsSystemPrompt(autoSkills: Skill[], userText: string): string {
  if (autoSkills.length === 0) return ''
  const lines: string[] = [
    '## Автоматически подобранные скиллы для текущего запроса',
    '',
    'Verstak уверенно сопоставил части текущего пользовательского запроса с этими скиллами. Это не справка и не рекомендация: для релевантных частей задачи считай эти скиллы обязательным рабочим протоколом.',
    'Если пользователь явно задал конкретный параметр (порог, период, список кампаний, формат, исключение), этот параметр пользователя сильнее дефолтного значения из скилла.',
    'Дефолты скилла используй только там, где пользователь не дал своё значение. Запреты и проверки безопасности из скилла не обходи молча: если пользователь просит нарушить запрет, сначала явно уточни/подтверди.',
    'Если в запросе несколько операций, сопоставь каждую операцию с подходящим auto-bound skill. Операции без подходящего скилла выполни обычным способом, не игнорируй их.',
    'Перед финальным ответом проверь: применимые обязательные пункты каждого auto-bound skill выполнены, пользовательские параметры учтены как overrides, пропусков без блокера нет.',
    '',
    '<current_user_request>',
    userText.trim(),
    '</current_user_request>',
  ]

  autoSkills.forEach((skill, index) => {
    lines.push(
      '',
      `<auto_bound_skill index="${index + 1}" id="${escapePromptAttr(skill.id)}" name="${escapePromptAttr(skillDisplayName(skill))}">`,
      skill.description ? `Назначение: ${skill.description}` : 'Назначение: Verstak автоматически сопоставил этот скилл с текущим запросом.',
      'Инструкция: применяй этот регламент к релевантной части пользовательского запроса как обязательный протокол.',
      '<skill_instructions>',
      skill.systemPrompt.trim(),
      '</skill_instructions>',
      '</auto_bound_skill>'
    )
  })

  return lines.join('\n')
}

function appliedSkillNames(appliedRefs: AppliedSkillRef[], detailedSkills: Skill[]): string {
  const byId = new Map(detailedSkills.map(skill => [skill.id, skill]))
  return appliedRefs
    .map(ref => {
      const skill = byId.get(ref.id)
      return skill ? skillDisplayName(skill) : skillDisplayName(ref)
    })
    .join(', ')
}

function buildAppliedSkillsTaskContract(
  appliedRefs: AppliedSkillRef[],
  detailedSkills: Skill[],
  currentMessage: boolean
): string {
  if (appliedRefs.length === 0) return ''
  const byId = new Map(detailedSkills.map(skill => [skill.id, skill]))
  const names = appliedSkillNames(appliedRefs, detailedSkills)
  if (!currentMessage) {
    return [
      '<historical_task_contract source="verstak_applied_skills">',
      `К предыдущему пользовательскому сообщению были применены скиллы: ${names}.`,
      'Это относится только к тому сообщению и помогает понять историю выполнения, но не включает эти скиллы как новый глобальный режим.',
      '</historical_task_contract>',
    ].join('\n')
  }

  const lines: string[] = [
    '<current_task_contract source="verstak_applied_skills" priority="required">',
    'ВАЖНО: это не справочный контекст и не внешняя заметка. Это часть текущего пользовательского запроса, созданная интерфейсом Verstak после явного нажатия пользователем "Применить скилл".',
    `Пользователь применил к текущему сообщению скиллы: ${names}.`,
    `Считай это эквивалентом прямой фразы пользователя: "Выполни текущую задачу с применением скиллов: ${names}".`,
    'Если пользователь просит сказать, что ты увидел в сообщении, обязательно назови эти применённые скиллы как часть задания.',
    'Не отвечай, что скиллы не указаны в сообщении или подключены "только через контекст". Они указаны через UI Verstak и являются обязательным регламентом для релевантных частей текущей задачи.',
    'Если в одном сообщении несколько операций, сопоставь каждую операцию с подходящим применённым скиллом; операции без подходящего скилла выполни обычным способом.',
    '<applied_skill_refs>',
  ]
  appliedRefs.forEach((ref, index) => {
    const skill = byId.get(ref.id)
    const name = skill ? skillDisplayName(skill) : skillDisplayName(ref)
    const description = skill?.description ?? ref.description ?? ''
    lines.push(
      `<skill index="${index + 1}" id="${escapePromptAttr(ref.id)}" name="${escapePromptAttr(name)}">`,
      description ? `Назначение: ${description}` : 'Назначение: пользователь применил этот скилл к текущему сообщению.',
      skill
        ? 'Полная инструкция этого скилла также передана в системном слое <skill_layer>.'
        : 'Полная инструкция скилла недоступна в текущем renderer-cache; ориентируйся на название и назначение.',
      '</skill>'
    )
  })
  lines.push('</applied_skill_refs>', '</current_task_contract>')
  return lines.join('\n')
}

function buildAutoBoundSkillsTaskContract(autoSkills: Skill[], userText: string): string {
  if (autoSkills.length === 0) return ''
  const names = autoSkills.map(skill => skillDisplayName(skill)).join(', ')
  const lines: string[] = [
    '<current_task_contract source="verstak_auto_bound_skills" priority="required">',
    `Verstak автоматически и с высокой уверенностью привязал к текущему запросу скиллы: ${names}.`,
    'Эти скиллы обязательны для тех частей текущей задачи, к которым они относятся. Не считай их необязательными подсказками.',
    'Раздели пользовательский запрос на операции и сопоставь каждую релевантную операцию с подходящим скиллом из списка.',
    'Явные параметры пользователя имеют приоритет над дефолтными параметрами скилла: суммы, периоды, списки, пороги, исключения и формат ответа бери из текущего запроса.',
    'Если параметр пользователя отличается от дефолта скилла, используй параметр пользователя и считай его override. Не возвращайся к дефолту скилла без причины.',
    'Обязательные проверки, запреты и критерии завершения из скилла не пропускай. Если выполнить пункт невозможно из-за доступа/данных/инструментов, назови это блокером.',
    'Перед финальным ответом сделай self-check по применимым пунктам auto-bound skills. Если что-то пропущено, сначала доделай или честно сообщи блокер.',
    '<current_user_request>',
    userText.trim(),
    '</current_user_request>',
    '<auto_bound_skill_refs>',
  ]
  autoSkills.forEach((skill, index) => {
    lines.push(
      `<skill index="${index + 1}" id="${escapePromptAttr(skill.id)}" name="${escapePromptAttr(skillDisplayName(skill))}">`,
      skill.description ? `Назначение: ${skill.description}` : 'Назначение: скилл автоматически выбран по смыслу текущего запроса.',
      'Полная инструкция этого скилла также передана в системном слое <skill_layer>.',
      '</skill>'
    )
  })
  lines.push('</auto_bound_skill_refs>', '</current_task_contract>')
  return lines.join('\n')
}

export function buildSkillBindingProgressDetail(manualSkills: Skill[], autoSkills: Skill[]): string | undefined {
  const manualNames = manualSkills.map(skillDisplayName)
  const autoNames = autoSkills.map(skillDisplayName)
  const parts: string[] = []
  if (manualNames.length) {
    parts.push(`пользователь применил: ${manualNames.join(', ')}`)
  }
  if (autoNames.length) {
    parts.push(`Verstak подключил автоматически: ${autoNames.join(', ')}`)
  }
  if (parts.length === 0) return undefined
  return `К задаче подключены скиллы — ${parts.join('; ')}. Они будут использованы как рабочий протокол для подходящих частей запроса.`
}

export function withAppliedSkillContextForModel(messages: ChatMessage[], skills: Skill[], autoBoundSkills: Skill[] = []): ChatMessage[] {
  const lastUserIndex = messages.map(message => message.role).lastIndexOf('user')
  return messages.map((message, index) => {
    if (message.role !== 'user') return message
    if (message.content.includes('<current_task_contract') || message.content.includes('<historical_task_contract')) return message
    const isCurrent = index === lastUserIndex
    const payloads: string[] = []
    if (message.appliedSkills?.length) {
      const detailedSkills = resolveAppliedSkillDetails(message.appliedSkills, skills)
      payloads.push(buildAppliedSkillsTaskContract(message.appliedSkills, detailedSkills, isCurrent))
    }
    if (isCurrent && autoBoundSkills.length) {
      payloads.push(buildAutoBoundSkillsTaskContract(autoBoundSkills, message.content))
    }
    const payload = payloads.filter(Boolean).join('\n\n')
    if (!payload) return message
    return {
      ...message,
      content: `${message.content}\n\n---\n\n${payload}`,
    }
  })
}

export function composeSkillSystemPrompt(activeSkill: Skill | null, appliedSkills: Skill[], userText: string, autoBoundSkills: Skill[] = []): string | undefined {
  const parts = [
    activeSkill ? activeSkill.systemPrompt : '',
    buildAppliedSkillsSystemPrompt(appliedSkills, userText),
    buildAutoBoundSkillsSystemPrompt(autoBoundSkills, userText),
  ].filter(part => part.trim())
  if (parts.length > 0) parts.push(SKILL_ANTI_STALL_NUDGE)
  return parts.length ? parts.join('\n\n---\n\n') : undefined
}
