/**
 * CLI prompt builder — common logic for stuffing system layer + user layer +
 * context pack + history into a single stdin payload for CLI providers.
 *
 * Why this exists (and why we don't share runApiConversation):
 *
 * 1. CLI providers in `stream-json` mode are effectively ONE-SHOT — they don't
 *    support multi-turn back-and-forth over a single stdin session. So we
 *    must serialize the conversation into the prompt itself.
 *
 * 2. grok-cli (Grok Build) doesn't have an aggressive system prompt of its
 *    own; we send the full system layer.
 *
 * 3. Attachments — CLI's `stream-json` mode doesn't accept inline images.
 *    We mention attachment names as a textual hint and let the user know.
 */

import { SYSTEM_LAYER_PROMPT } from './system-layer'
import { prepareParts } from './compose-system'
import { serializeHistory, describeAttachments } from './history-serializer'
import { detectVerifyScriptsForHint } from './session-journal'
import type { ChatMessage } from './types'

export type CliProviderId = 'claude-cli' | 'gemini-cli' | 'grok-cli' | 'codex-cli'

/**
 * True if the CLI provider reads this user_layer file by itself on startup.
 * grok-cli — no documented convention file, always inject.
 */
function cliReadsLayerNatively(providerId: CliProviderId, layerPath: string | null): boolean {
  void providerId; void layerPath
  return false
}

interface BuildCliPromptOpts {
  providerId: CliProviderId
  projectPath: string | null
  messages: ChatMessage[]
  /** Optional override — caller may inject recent writes for context-pack. */
  recentWrites?: Array<{ filePath: string; createdAt: number }>
  /** Promt из Project Settings (см. compose-system.ts). Передаётся вниз в
   *  prepareParts, дописывается к user_layer. */
  projectSystemPrompt?: string | null
  /** Промпт активного скилла (специализация роли). Наслаивается секцией
   *  <skill_layer> поверх system/user/context — как в API-пути. */
  skillPrompt?: string | null
  /** Топ-5 воспоминаний проекта — те же что инжектятся API-провайдерам.
   *  Передаются в prepareParts → buildContextPack. */
  memories?: Array<{ type: string; content: string; tags: string[] }>
  /** memory-nudge консолидации — паритет с API-путём (передаётся в buildContextPack). */
  consolidationHint?: string
  /** Паритет с API-путём: после принятых write'ов API дописывает инлайн-хинт
   *  «запусти проверку (npm test/type)». CLI one-shot — не имеет цикла, поэтому
   *  вызывающий код выставляет флаг, когда в истории были write'ы. */
  appendVerifyHint?: boolean
}

/**
 * Build the full stdin payload for a CLI provider. Returns the assembled
 * string that should be written to the subprocess's stdin.
 */
export async function buildCliPrompt(opts: BuildCliPromptOpts): Promise<string> {
  const { providerId, projectPath, messages, recentWrites, projectSystemPrompt, skillPrompt, memories, consolidationHint, appendVerifyHint } = opts

  const lastUser = messages.filter(m => m.role === 'user').at(-1)
  if (!lastUser) throw new Error('CLI prompt: нет user-сообщения')

  const sections: string[] = []

  // 1. user_layer + context_pack — assembled by the shared helper so we don't
  //    drift away from how ipc/ai.ts does it for API providers.
  const { userLayer, contextPack } = await prepareParts({
    projectPath,
    messages,
    recentWrites: recentWrites ?? [],
    projectSystemPrompt,
    memories,
    consolidationHint
  })
  const trimmedUser = userLayer.content.trim()
  // Skip re-injecting user_layer when the CLI is known to read this exact file
  // itself. Otherwise we burn tokens twice and risk version drift between the
  // inline copy and the file the CLI re-read from disk.
  const skipUserLayer = cliReadsLayerNatively(providerId, userLayer.path)
  const effectiveUserLayer = skipUserLayer ? '' : trimmedUser
  const nativeLayerHint = skipUserLayer
    ? `\n[gg-runtime: твой нативный ${userLayer.path} уже прочитан CLI на старте — не повторяю здесь.]`
    : ''

  // 2. System envelope — grok-cli is neutral (no aggressive system prompt of
  //    its own), gets the full system_layer.
  {
    const userBlock = effectiveUserLayer
      ? `\n\n<user_layer source="${userLayer.path}">\n${effectiveUserLayer}\n</user_layer>`
      : nativeLayerHint
    sections.push(`${SYSTEM_LAYER_PROMPT}${userBlock}`)
  }

  // 3. Context pack — same content as API providers get, just appended as
  //    a separate section in stdin payload.
  if (contextPack) sections.push(contextPack)

  // 3.5. Skill layer — специализация роли агента (активный скилл). Наслаивается
  //      ПОВЕРХ system/user/context, как в API-пути (compose-prompt.ts
  //      <skill_layer>): это выбор пользователя, а не наш базовый регламент.
  const trimmedSkill = (skillPrompt ?? '').trim()
  if (trimmedSkill) sections.push(`<skill_layer>\n${trimmedSkill}\n</skill_layer>`)

  // 3. Conversation history — единый сериализатор (history-serializer.ts).
  //    NEVER include system messages here (they're already above).
  //
  // Audit 2026-05-21 (vop B):
  //  - Previously slice(-10) was count-based: long sessions silently lost
  //    everything past turn-10. Replaced with a TOTAL_CHAR_BUDGET walk so
  //    short turns can pull in more history, while a single megaturn doesn't
  //    starve the rest. Floor: always include the last MIN_TURNS turns even
  //    if oversized — losing them outright is worse than blowing the budget.
  //  - Previously tool calls/results were serialized as `[tool calls: read_file]`
  //    name-only — CLI was BLIND to what the agent had already read. Now
  //    each tool_result body is included (truncated per-call) so a follow-up
  //    in CLI can reference earlier reads. Same for tool_call args.
  //  - serializeHistory теперь учитывает r.error (раньше игнорировался) и
  //    умное сжатие через smartCompressResult.
  const turns = messages.filter(m => m.role !== 'system')
  // Drop the very last user message — we'll send it separately as the prompt
  const candidates = turns.slice(0, -1)
  const { transcript, includedCount, droppedCount } = serializeHistory(candidates)
  if (includedCount > 0) {
    const droppedNote = droppedCount > 0
      ? ` dropped="${droppedCount}" reason="budget"`
      : ''
    sections.push(
      `<conversation_history turns="${includedCount}"${droppedNote}>\n${transcript}\n</conversation_history>`
    )
  }

  // 3.7. Verify-hint — паритет с API-путём. После принятых write'ов API
  //      дописывает инлайн-напоминание «запусти проверку». CLI one-shot не
  //      имеет цикла, поэтому: если флаг appendVerifyHint задан явно — уважаем
  //      его; если не задан (undefined) — авто-детект по истории (были ли
  //      write_file / apply_patch в прошлых turn'ах).
  const WRITE_TOOLS = new Set(['write_file', 'apply_patch'])
  const historyHadWrites = candidates.some(m => m.toolCalls?.some(c => WRITE_TOOLS.has(c.name)))
  const wantVerifyHint = appendVerifyHint ?? historyHadWrites
  if (wantVerifyHint && projectPath) {
    try {
      const hints = await detectVerifyScriptsForHint(projectPath)
      if (hints.length > 0) {
        sections.push(
          `<verify_hint>\nПеред "готово" запусти проверку: ${hints.slice(0, 3).join(' / ')}. ` +
          `Если уверен что проверка избыточна — объясни почему.\n</verify_hint>`
        )
      }
    } catch { /* detect failed — verify-hint не критичен */ }
  }

  // 4. The actual user prompt — last message
  let userMessage = lastUser.content
  const attachNote = describeAttachments(lastUser.attachments, 'text')
  if (attachNote) {
    userMessage = userMessage ? `${userMessage}\n\n${attachNote}` : attachNote
  }
  sections.push(wrapCurrentUserRequest(userMessage))

  return sections.join('\n\n')
}

export const CURRENT_USER_REQUEST_OPEN = '<current_user_request>'
export const CURRENT_USER_REQUEST_CLOSE = '</current_user_request>'

export function wrapCurrentUserRequest(userMessage: string): string {
  return `${CURRENT_USER_REQUEST_OPEN}\n${userMessage}\n${CURRENT_USER_REQUEST_CLOSE}`
}

const CURRENT_USER_REQUEST_RE =
  /<current_user_request>\n([\s\S]*?)\n<\/current_user_request>\s*$/

/**
 * Fit a CLI payload into argv length cap WITHOUT dropping the latest user turn.
 * Naive slice(0, cap) keeps system/context at the start and cuts the current
 * user message at the end — model then answers the first turn forever.
 */
export function fitCliPayloadToArgvCap(payload: string, cap: number): string {
  if (payload.length <= cap) return payload
  const match = payload.match(CURRENT_USER_REQUEST_RE)
  if (!match || match.index == null) {
    // Fallback: keep tail (better than head for one-shot CLI)
    return payload.slice(payload.length - cap)
  }
  const userMsg = match[1]
  const wrappedUser = wrapCurrentUserRequest(userMsg)
  const head = payload.slice(0, match.index).trimEnd()
  const marker = '\n\n[truncated]\n\n'
  const headBudget = cap - wrappedUser.length - marker.length
  if (headBudget < 0) {
    return wrappedUser.slice(0, cap)
  }
  const trimmedHead = head.length > headBudget ? head.slice(0, headBudget) : head
  return trimmedHead + marker + wrappedUser
}
