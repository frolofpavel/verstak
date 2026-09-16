import { readdir } from 'node:fs/promises'
import type { Chats } from '../storage/chats'
import type { ChatSessions } from '../storage/chat-sessions'
import { isComputerUseComposerAttempt } from '../ai/computer/intent'
import type { RootCapabilities } from './roots'
import type { MobileCommandHandlers } from './types'

interface AdapterDeps {
  roots: RootCapabilities
  sessions: ChatSessions
  chats: Chats
  startRun: (input: { chatId: number; projectPath: string; text: string }) => Promise<{ runId: string }>
  stopRun: (runId: string) => Promise<boolean>
  listChanges?: (projectPath: string) => Promise<unknown>
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid command payload')
  return value as Record<string, unknown>
}
function textField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || !field.trim()) throw new Error(`invalid ${key}`)
  return field.trim()
}
function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key]
  if (typeof field !== 'number' || !Number.isInteger(field)) throw new Error(`invalid ${key}`)
  return field
}

export function createMobileHandlers(deps: AdapterDeps): MobileCommandHandlers {
  const sessionForRoot = (rootId: string, chatId: number) => {
    const projectPath = deps.roots.projectPath(rootId)
    const session = deps.sessions.get(chatId)
    if (!session || session.projectPath !== projectPath || session.kind !== 'main') throw new Error('chat is outside the selected root')
    return { projectPath, session }
  }
  return {
    'device.snapshot': async () => ({ roots: deps.roots.list() }),
    'roots.list': async () => deps.roots.list(),
    'files.list': async payload => {
      const input = record(payload)
      const rootId = textField(input, 'rootId')
      const relativePath = typeof input.relativePath === 'string' ? input.relativePath : '.'
      const path = await deps.roots.resolve(rootId, relativePath)
      const entries = await readdir(path, { withFileTypes: true })
      return entries.filter(entry => !entry.name.startsWith('.')).map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' }))
    },
    'chats.list': async payload => deps.sessions.list(deps.roots.projectPath(textField(record(payload), 'rootId'))),
    'chat.create': async payload => {
      const input = record(payload)
      const projectPath = deps.roots.projectPath(textField(input, 'rootId'))
      const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'Мобильный чат'
      return deps.sessions.create(projectPath, { title })
    },
    'chat.history': async payload => {
      const input = record(payload)
      const chatId = numberField(input, 'chatId')
      sessionForRoot(textField(input, 'rootId'), chatId)
      return deps.chats.listBySession(chatId)
    },
    'chat.send': async payload => {
      const input = record(payload)
      const rootId = textField(input, 'rootId')
      const chatId = numberField(input, 'chatId')
      const { projectPath } = sessionForRoot(rootId, chatId)
      const text = textField(input, 'text')
      // Desktop input authority is minted only by the visible desktop composer.
      // A relay command must not first become durable chat text and then rely on
      // a downstream provider/tool guard to contain it.
      if (isComputerUseComposerAttempt(text)) {
        throw new Error('COMPUTER_USE_FRESH_COMPOSER_REQUIRED: Computer Use доступен только из нового сообщения в desktop composer.')
      }
      deps.chats.appendToSession(chatId, projectPath, 'user', text)
      return deps.startRun({ chatId, projectPath, text })
    },
    'run.stop': async payload => ({ stopped: await deps.stopRun(textField(record(payload), 'runId')) }),
    'changes.list': async payload => deps.listChanges?.(deps.roots.projectPath(textField(record(payload), 'rootId'))) ?? [],
  }
}
