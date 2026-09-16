import type { BrowserTasks } from '../../storage/browser-tasks'
import { COMPUTER_CONTEXT_TAINT_CAP } from '../../storage/browser-tasks'
import { COMPUTER_CONTEXT_OMITTED } from '../tool-telemetry'

const MAX_CHAT_ANCESTOR_DEPTH = 64

type TaintBrowserTasks = Partial<Pick<BrowserTasks, 'get' | 'listActions'>>

export interface DurableComputerTaintDeps {
  browserTasks?: TaintBrowserTasks | null
  getChatParentChatId?: ((chatId: number) => number | null) | null
}

function validChatId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * Durable, content-free provenance for selected-window context.
 *
 * A chat is tainted when its deterministic browser task (or any bounded
 * ancestor) has either a real `computer:*` ledger action or the reserved cap
 * materialized while forking. Storage read failures and malformed ancestry
 * fail closed; missing optional storage keeps non-desktop/headless fixtures
 * backward compatible.
 */
export function isChatComputerTainted(
  chatId: number | null | undefined,
  deps: DurableComputerTaintDeps,
): boolean {
  if (!validChatId(chatId) || !deps.browserTasks) return false

  const visited = new Set<number>()
  let current: number | null = chatId
  for (let depth = 0; current != null && depth < MAX_CHAT_ANCESTOR_DEPTH; depth++) {
    if (!validChatId(current) || visited.has(current)) return true
    visited.add(current)
    const browserTaskId = `bt-${current}`
    try {
      const task = typeof deps.browserTasks.get === 'function'
        ? deps.browserTasks.get(browserTaskId)
        : null
      if (task?.caps?.[COMPUTER_CONTEXT_TAINT_CAP] === true) return true
      if (typeof deps.browserTasks.listActions === 'function') {
        const actions = deps.browserTasks.listActions(browserTaskId)
        if (actions.some(action => typeof action.actionType === 'string' && action.actionType.startsWith('computer:'))) {
          return true
        }
      }
    } catch {
      return true
    }

    if (!deps.getChatParentChatId) return false
    try {
      current = deps.getChatParentChatId(current)
    } catch {
      return true
    }
  }
  return current != null
}

/** Materialize inherited taint without inventing a browser/UI action. */
export function materializeChatComputerTaint(
  browserTasks: BrowserTasks,
  chatId: number,
  projectPath: string,
): void {
  if (!validChatId(chatId)) throw new Error('invalid chat id for Computer Use taint')
  const browserTaskId = `bt-${chatId}`
  const existing = browserTasks.get(browserTaskId)
  if (existing) {
    browserTasks.setCaps(browserTaskId, {
      ...existing.caps,
      [COMPUTER_CONTEXT_TAINT_CAP]: true,
    })
  } else {
    browserTasks.create({
      browserTaskId,
      projectPath,
      chatId,
      browserMode: 'watch',
      caps: { [COMPUTER_CONTEXT_TAINT_CAP]: true },
      dataPolicy: {},
    })
  }
  if (browserTasks.get(browserTaskId)?.caps?.[COMPUTER_CONTEXT_TAINT_CAP] !== true) {
    throw new Error('Computer Use taint marker was not persisted')
  }
}

export function omitConversationContentForComputerTaint<T extends { role: string; content: string; thinking?: string }>(
  messages: T[],
  tainted: boolean,
): T[] {
  if (!tainted) return messages
  return messages.map(message => ({
    ...message,
    content: '',
    ...(message.thinking ? { thinking: '' } : {}),
  }))
}

export function projectConversationSearchForComputerTaint<
  T extends { session_id: number; role: string; content: string },
>(results: T[], isTainted: (chatId: number) => boolean): T[] {
  return results.map(result => {
    let tainted = true
    try {
      tainted = isTainted(result.session_id)
    } catch {
      tainted = true
    }
    return tainted ? { ...result, content: COMPUTER_CONTEXT_OMITTED } : result
  })
}
