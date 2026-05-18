import { ipcMain } from 'electron'
import { createGeminiProvider } from '../ai/gemini'
import { createGeminiCliProvider } from '../ai/gemini-cli'
import { createFileTools, TOOL_DEFS } from '../ai/tools'
import type { ChatMessage, ToolCall, ChatProvider } from '../ai/types'

export type ProviderId = 'gemini-api' | 'gemini-cli'

interface AiDeps {
  getApiKey: () => string | null
  getProviderId: () => ProviderId
}

let currentSendId = 0

interface PendingWrite {
  call: ToolCall
  projectPath: string
  resolve: (accept: boolean) => void
}
const pendingWrites = new Map<string, PendingWrite>()

export function registerAiIpc(deps: AiDeps): void {
  ipcMain.handle('ai:send', async (e, messages: ChatMessage[], projectPath: string | null) => {
    const providerId = deps.getProviderId()
    const sendId = ++currentSendId

    if (providerId === 'gemini-cli') {
      const provider = createGeminiCliProvider({ cwd: projectPath ?? process.cwd() })
      void runCliConversation(e.sender, sendId, provider, messages)
      return sendId
    }

    // API path
    const apiKey = deps.getApiKey()
    if (!apiKey) {
      e.sender.send('ai:event', { id: 0, event: { type: 'error', message: 'API ключ Gemini не задан. Открой настройки и вставь ключ или переключись на режим CLI (подписка).' } })
      return 0
    }
    const provider = createGeminiProvider({ apiKey })
    const tools = projectPath ? createFileTools(projectPath) : null
    void runApiConversation(e.sender, sendId, provider, tools, projectPath, messages)
    return sendId
  })

  ipcMain.handle('ai:resolve-write', (_e, callId: string, accept: boolean) => {
    const p = pendingWrites.get(callId)
    if (p) {
      p.resolve(accept)
      pendingWrites.delete(callId)
    }
  })
}

async function runCliConversation(
  sender: Electron.WebContents,
  sendId: number,
  provider: ChatProvider,
  messages: ChatMessage[]
): Promise<void> {
  for await (const event of provider.send(messages, [])) {
    sender.send('ai:event', { id: sendId, event })
    if (event.type === 'done' || event.type === 'error') return
  }
  sender.send('ai:event', { id: sendId, event: { type: 'done' } })
}

async function runApiConversation(
  sender: Electron.WebContents,
  sendId: number,
  provider: ChatProvider,
  tools: ReturnType<typeof createFileTools> | null,
  projectPath: string | null,
  initialMessages: ChatMessage[]
): Promise<void> {
  const currentMessages = [...initialMessages]
  const maxTurns = 5
  for (let turn = 0; turn < maxTurns; turn++) {
    const toolCalls: ToolCall[] = []
    let assistantText = ''
    for await (const event of provider.send(currentMessages, tools ? TOOL_DEFS : [])) {
      if (event.type === 'text') {
        assistantText += event.text
        sender.send('ai:event', { id: sendId, event })
      } else if (event.type === 'tool-call') {
        toolCalls.push(event.call)
      } else if (event.type === 'done') {
        if (toolCalls.length === 0) {
          sender.send('ai:event', { id: sendId, event })
          return
        }
      } else if (event.type === 'error') {
        sender.send('ai:event', { id: sendId, event })
        return
      }
    }
    if (!tools || toolCalls.length === 0) {
      sender.send('ai:event', { id: sendId, event: { type: 'done' } })
      return
    }
    if (assistantText) currentMessages.push({ role: 'assistant', content: assistantText })

    for (const call of toolCalls) {
      if (call.name === 'write_file' && projectPath) {
        const path = String(call.args.path)
        const after = String(call.args.content)
        let before = ''
        try {
          before = await tools.execute('read_file', { path }) as string
        } catch {
          before = ''
        }
        sender.send('ai:event', { id: sendId, event: { type: 'pending-write', callId: call.id, path, before, after } })
        const accepted = await new Promise<boolean>(resolve => {
          pendingWrites.set(call.id, { call, projectPath, resolve })
        })
        if (accepted) {
          try {
            await tools.execute('write_file', call.args)
            currentMessages.push({ role: 'user', content: `[tool write_file applied to ${path}]` })
          } catch (err) {
            currentMessages.push({ role: 'user', content: `[tool write_file error]\n${err instanceof Error ? err.message : String(err)}` })
          }
        } else {
          currentMessages.push({ role: 'user', content: `[user rejected write to ${path}]` })
        }
        continue
      }
      try {
        const result = await tools.execute(call.name, call.args)
        currentMessages.push({
          role: 'user',
          content: `[tool ${call.name} result]\n${JSON.stringify(result).slice(0, 5000)}`
        })
      } catch (err) {
        currentMessages.push({
          role: 'user',
          content: `[tool ${call.name} error]\n${err instanceof Error ? err.message : String(err)}`
        })
      }
    }
  }
  sender.send('ai:event', { id: sendId, event: { type: 'done' } })
}
