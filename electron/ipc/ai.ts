import { ipcMain } from 'electron'
import { createFileTools, TOOL_DEFS } from '../ai/tools'
import { createProvider, PROVIDERS, type ProviderId } from '../ai/registry'
import type { ChatMessage, ToolCall, ChatProvider } from '../ai/types'

export type { ProviderId } from '../ai/registry'

interface AiDeps {
  getSecret: (key: string) => string | null
  getProviderId: () => ProviderId
  getProviderModel: (id: ProviderId) => string | null
}

let currentSendId = 0
const activeAborts = new Map<number, AbortController>()

interface PendingWrite { resolve: (accept: boolean) => void }
const pendingWrites = new Map<string, PendingWrite>()

interface PendingCommand { resolve: (accept: boolean) => void }
const pendingCommands = new Map<string, PendingCommand>()

export function registerAiIpc(deps: AiDeps): void {
  ipcMain.handle('ai:send', async (e, messages: ChatMessage[], projectPath: string | null) => {
    const providerId = deps.getProviderId()
    const descriptor = PROVIDERS[providerId]
    const sendId = ++currentSendId
    const ctrl = new AbortController()
    activeAborts.set(sendId, ctrl)
    const cleanup = () => { activeAborts.delete(sendId) }

    // Resolve API key (or null for CLI)
    const apiKey = descriptor.secretKey ? deps.getSecret(descriptor.secretKey) : null
    if (descriptor.secretKey && !apiKey) {
      e.sender.send('ai:event', {
        id: 0,
        event: {
          type: 'error',
          message: `API ключ для ${descriptor.name} не задан. Открой настройки и добавь ключ или переключи провайдера.`
        }
      })
      cleanup()
      return 0
    }

    const model = deps.getProviderModel(providerId) ?? descriptor.defaultModel
    let provider: ChatProvider
    try {
      provider = createProvider(providerId, {
        apiKey,
        model,
        cwd: projectPath ?? process.cwd(),
        signal: ctrl.signal
      })
    } catch (err) {
      e.sender.send('ai:event', {
        id: 0,
        event: { type: 'error', message: err instanceof Error ? err.message : String(err) }
      })
      cleanup()
      return 0
    }

    if (descriptor.supportsTools && projectPath) {
      const tools = createFileTools(projectPath)
      void runApiConversation(e.sender, sendId, provider, tools, projectPath, messages, ctrl.signal).finally(cleanup)
    } else {
      void runPlainConversation(e.sender, sendId, provider, messages, ctrl.signal).finally(cleanup)
    }
    return sendId
  })

  ipcMain.handle('ai:stop', (_e, sendId: number) => {
    const ctrl = activeAborts.get(sendId)
    if (!ctrl) return false
    ctrl.abort()
    activeAborts.delete(sendId)
    for (const [k, p] of pendingWrites) { p.resolve(false); pendingWrites.delete(k) }
    for (const [k, p] of pendingCommands) { p.resolve(false); pendingCommands.delete(k) }
    return true
  })

  ipcMain.handle('ai:resolve-write', (_e, callId: string, accept: boolean) => {
    const p = pendingWrites.get(callId)
    if (p) { p.resolve(accept); pendingWrites.delete(callId) }
  })

  ipcMain.handle('ai:resolve-command', (_e, callId: string, accept: boolean) => {
    const p = pendingCommands.get(callId)
    if (p) { p.resolve(accept); pendingCommands.delete(callId) }
  })
}

/**
 * Plain streaming conversation — no tools, no multi-turn. Used for providers
 * that don't support function calling yet (Claude/Grok/OpenAI/Gemini CLI).
 */
async function runPlainConversation(
  sender: Electron.WebContents,
  sendId: number,
  provider: ChatProvider,
  messages: ChatMessage[],
  signal: AbortSignal
): Promise<void> {
  for await (const event of provider.send(messages, [])) {
    if (signal.aborted) {
      sender.send('ai:event', { id: sendId, event: { type: 'done' } })
      return
    }
    sender.send('ai:event', { id: sendId, event })
    if (event.type === 'done' || event.type === 'error') return
  }
  sender.send('ai:event', { id: sendId, event: { type: 'done' } })
}

/**
 * Full agentic loop with file tools + diff confirmation + command sandbox.
 * Only providers that support function calling go through here.
 */
async function runApiConversation(
  sender: Electron.WebContents,
  sendId: number,
  provider: ChatProvider,
  tools: ReturnType<typeof createFileTools>,
  projectPath: string,
  initialMessages: ChatMessage[],
  signal: AbortSignal
): Promise<void> {
  const currentMessages = [...initialMessages]
  const maxTurns = 5
  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal.aborted) {
      sender.send('ai:event', { id: sendId, event: { type: 'done' } })
      return
    }
    const toolCalls: ToolCall[] = []
    let assistantText = ''
    for await (const event of provider.send(currentMessages, TOOL_DEFS)) {
      if (signal.aborted) {
        sender.send('ai:event', { id: sendId, event: { type: 'done' } })
        return
      }
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
    if (toolCalls.length === 0) {
      sender.send('ai:event', { id: sendId, event: { type: 'done' } })
      return
    }
    if (assistantText) currentMessages.push({ role: 'assistant', content: assistantText })

    for (const call of toolCalls) {
      if (call.name === 'write_file') {
        await handleWriteFile(sender, sendId, tools, call, currentMessages)
        continue
      }
      if (call.name === 'run_command') {
        await handleRunCommand(sender, sendId, tools, call, currentMessages)
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
    void projectPath  // silence unused
  }
  sender.send('ai:event', { id: sendId, event: { type: 'done' } })
}

async function handleWriteFile(
  sender: Electron.WebContents,
  sendId: number,
  tools: ReturnType<typeof createFileTools>,
  call: ToolCall,
  messages: ChatMessage[]
): Promise<void> {
  const path = String(call.args.path)
  const after = String(call.args.content)
  let before = ''
  try { before = await tools.execute('read_file', { path }) as string } catch { before = '' }
  void after
  sender.send('ai:event', { id: sendId, event: { type: 'pending-write', callId: call.id, path, before, after } })
  const accepted = await new Promise<boolean>(resolve => { pendingWrites.set(call.id, { resolve }) })
  if (accepted) {
    try {
      await tools.execute('write_file', call.args)
      messages.push({ role: 'user', content: `[tool write_file applied to ${path}]` })
    } catch (err) {
      messages.push({ role: 'user', content: `[tool write_file error]\n${err instanceof Error ? err.message : String(err)}` })
    }
  } else {
    messages.push({ role: 'user', content: `[user rejected write to ${path}]` })
  }
}

async function handleRunCommand(
  sender: Electron.WebContents,
  sendId: number,
  tools: ReturnType<typeof createFileTools>,
  call: ToolCall,
  messages: ChatMessage[]
): Promise<void> {
  const command = String(call.args.command ?? '')
  const verdict = tools.classifyCommand(command)
  if (!verdict.allowed) {
    sender.send('ai:event', {
      id: sendId,
      event: { type: 'tool-blocked', callId: call.id, name: 'run_command', command, reason: verdict.reason ?? 'denylist' }
    })
    messages.push({
      role: 'user',
      content: `[tool run_command blocked by safety policy]\nКоманда: ${command}\nПричина: ${verdict.reason ?? 'denylist'}`
    })
    return
  }

  sender.send('ai:event', { id: sendId, event: { type: 'pending-command', callId: call.id, command } })
  const accepted = await new Promise<boolean>(resolve => { pendingCommands.set(call.id, { resolve }) })
  if (!accepted) {
    sender.send('ai:event', {
      id: sendId,
      event: { type: 'command-result', callId: call.id, command, status: 'rejected' }
    })
    messages.push({ role: 'user', content: `[user rejected run_command]\nКоманда: ${command}` })
    return
  }

  try {
    const result = await tools.runCommand(command)
    sender.send('ai:event', {
      id: sendId,
      event: { type: 'command-result', callId: call.id, command, status: 'ok', exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
    })
    messages.push({
      role: 'user',
      content: `[tool run_command result]\n${JSON.stringify(result).slice(0, 5000)}`
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sender.send('ai:event', {
      id: sendId,
      event: { type: 'command-result', callId: call.id, command, status: 'error', error: msg }
    })
    messages.push({ role: 'user', content: `[tool run_command error]\n${msg}` })
  }
}
