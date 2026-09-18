import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Computer Use untrusted-context production wiring', () => {
  it('derives consent only from a consumed main-owned composer ticket before model context expansion', () => {
    const source = readFileSync(join(process.cwd(), 'electron', 'ipc', 'ai.ts'), 'utf8')
    const intentSource = readFileSync(join(process.cwd(), 'electron', 'ai', 'computer', 'intent.ts'), 'utf8')
    const taint = source.indexOf('const durableComputerContextTainted =')
    const intent = source.indexOf('allowedComputerUseActionsForRun(verifiedComputerUseRequestText')
    const envelopeCheck = source.indexOf('COMPUTER_USE_COMPOSER_ENVELOPE_MISMATCH:')
    const expansion = source.indexOf('expandOfficeAttachments(ticketBoundMessages)')
    expect(taint).toBeGreaterThan(0)
    expect(intent).toBeGreaterThan(0)
    expect(envelopeCheck).toBeGreaterThan(intent)
    expect(taint).toBeLessThan(expansion)
    expect(intent).toBeLessThan(expansion)
    expect(envelopeCheck).toBeLessThan(expansion)
    expect(source).toContain('incomingUserContent !== verifiedUserContent')
    expect(source).not.toContain('allowedComputerUseActionsForRun(incomingMessages')
    expect(source).not.toContain('interactiveRendererSend')
    expect(intentSource).toContain("typeof value !== 'string'")
    expect(intentSource).toContain("Buffer.byteLength(value, 'utf8') > MAX_COMPUTER_USE_ORIGINAL_USER_TEXT_BYTES")
    expect(source).toContain("ipcMain.on?.('ai:mint-computer-use-composer-ticket'")
    expect(source).toMatch(/ai:mint-computer-use-composer-ticket',[^\n]*canonicalUserContentValue/u)
    expect(source).not.toMatch(/ai:mint-computer-use-composer-ticket',[^\n]*originalUserTextValue[^\n]*persistedUserContentValue/u)
    expect(source).toContain('consumeComputerUseComposerTicket(')
    expect(source).toContain('const COMPUTER_USE_COMPOSER_TICKET_TTL_MS = 60_000')
    expect(source).toContain('const MAX_PENDING_COMPUTER_USE_COMPOSER_TICKETS = 128')
    const consumed = source.indexOf('computerUseComposerTickets.delete(grant.ticket)')
    const persistedLookup = source.indexOf('deps.getLatestChatUserMessage?.(chatId)')
    expect(consumed).toBeGreaterThan(0)
    expect(consumed).toBeLessThan(persistedLookup)
    expect(source).toContain("latest.role !== 'user'")
    expect(source).toContain('latest.sessionId !== chatId')
    expect(source).toContain('latest.id !== grant.userMessageId')
    expect(source).toMatch(/ipcMain\.handle\('ai:send',[\s\S]*?computerUseGrant\?: unknown/u)
    expect(source).not.toMatch(/ipcMain\.handle\('ai:send',[^\n]*originalUserText/u)
    expect(source).toContain('const authorization = await authorizeComputerRun({')
    const intentTaint = source.indexOf('materializeChatComputerTaint(deps.browserTasks, chatIdNum')
    const unsupportedRoute = source.indexOf('COMPUTER_USE_TRANSPORT_UNSUPPORTED:')
    const authorize = source.indexOf('const authorization = await authorizeComputerRun({')
    const registered = source.indexOf('registerChatRun(sendId, chatIdNum)')
    expect(intentTaint).toBeGreaterThan(0)
    expect(intentTaint).toBeLessThan(unsupportedRoute)
    expect(authorize).toBeLessThan(registered)
    expect(source).toContain('return earlyRouteStop(`COMPUTER_USE_AUTHORIZATION_FAILED: ${authorization.error}`)')
    expect(source).toContain('computerUseAllowedActions,')
    expect(source).toContain('resumeFromRunId: null')
    expect(source).toContain('!composerOverridesPreserveFreshProvenance(overrides)')
    expect(source).toContain('COMPUTER_USE_FRESH_COMPOSER_REQUIRED:')
    expect(source).toContain("r3HandoffIntent.allowed && (!deps.browserController || !deps.browserTasks)")
  })

  it('wires durable taint through send, fork/delete and conversation search without raw content', () => {
    const ai = readFileSync(join(process.cwd(), 'electron', 'ipc', 'ai.ts'), 'utf8')
    const chats = readFileSync(join(process.cwd(), 'electron', 'ipc', 'chats.ts'), 'utf8')
    const main = readFileSync(join(process.cwd(), 'electron', 'main.ts'), 'utf8')
    const storage = readFileSync(join(process.cwd(), 'electron', 'storage', 'browser-tasks.ts'), 'utf8')

    expect(ai).toMatch(/projectMessagesForPersistence\(expandedMessages,\s*\{[\s\S]*?computerContextInitiallyExposed: true,[\s\S]*?omitConversationContent: true/u)
    expect(ai).toContain('computerContextExposed: durableComputerContextTainted')
    expect(ai).toMatch(/const contextSnapshot = hasDurableChat\s*&& !durableComputerContextTainted\s*&& !computerUseEnvelopeLocked/u)
    expect(ai).toMatch(/const computerUseRequestedActions = hasDurableChat[\s\S]*?: \[\]/u)
    expect(ai).toContain('const computerUseAllowedActions = freshComposerText ? computerUseRequestedActions : []')
    expect(ai).toContain('searchConversations: safeSearchConversations')
    expect(chats).toContain('materializeChatComputerTaint(')
    expect(chats).toContain('omitConversationContentForComputerTaint(messages, tainted)')
    expect(main).toContain('registerChatsIpc(chats, chatSessions, db, durableComputerTaintDeps)')
    expect(main).toContain('projectConversationSearchForComputerTaint(')
    expect(main).toContain('isChatComputerTainted: chatHasDurableComputerTaint')
    expect(main).toContain('isChatTainted: chatHasDurableComputerTaint')
    expect(storage).toContain("export const COMPUTER_CONTEXT_TAINT_CAP = 'computerContextTainted'")
    expect(storage).toMatch(/previous\[COMPUTER_CONTEXT_TAINT_CAP\] === true[\s\S]*?\[COMPUTER_CONTEXT_TAINT_CAP\]: true/u)
  })

  it('mints and forwards an opaque one-shot ticket only from the fresh main-chat composer', () => {
    const helper = readFileSync(join(process.cwd(), 'src', 'components', 'chat', 'send-chat-message.ts'), 'utf8')
    const chat = readFileSync(join(process.cwd(), 'src', 'components', 'Chat.tsx'), 'utf8')
    const preload = readFileSync(join(process.cwd(), 'electron', 'preload.ts'), 'utf8')
    const main = readFileSync(join(process.cwd(), 'electron', 'main.ts'), 'utf8')

    const mint = chat.indexOf('mintComputerUseComposerTicket(')
    const firstAwait = chat.indexOf('await sendHelpMessage(')
    expect(mint).toBeGreaterThan(0)
    expect(mint).toBeLessThan(firstAwait)
    expect(preload).toContain('installComputerUseComposerActivationLatch(window)')
    expect(preload).toContain('const activationProof = consumeComputerUseComposerActivation()')
    expect(preload).toContain('canonicalUserContent,\n        activationProof,')
    expect(main).toContain("mainWindow.webContents.on('input-event'")
    expect(main).toContain("mainWindow.webContents.on('before-input-event'")
    expect(main).toContain('computerUseComposerActivationGate.consume(proof)')
    expect(helper).toContain('computerUseComposerTicket')
    expect(helper).toContain('userMessageId: persistedUserRow.id')
    expect(helper.match(/\}, sendChatId, computerUseGrant\)/gu)).toHaveLength(3)
    expect(chat.match(/sendWithOverrides: \(messages, projectPath, overrides, chatId, computerUseGrant\)/gu)).toHaveLength(1)
    expect(chat.match(/void send\(\{ freshComposerSubmit: true \}\)/gu)).toHaveLength(1)
    expect(chat.match(/void send\(\)/gu)).toHaveLength(2)
    expect(preload).toMatch(/ipcRenderer\.sendSync\(\s*'ai:mint-computer-use-composer-ticket'/u)
    expect(preload).toMatch(/ipcRenderer\.invoke\('ai:send', messages, projectPath, undefined, overrides, chatId, computerUseGrant\)/u)
    expect(preload).not.toMatch(/sendWithOverrides:[\s\S]*?originalUserText\?: string/u)
  })

  it('routes retry, resend, pipeline and suspended events through non-composer auto-send', () => {
    const agentRuns = readFileSync(join(process.cwd(), 'src', 'components', 'AgentRunsPanel.tsx'), 'utf8')
    const resumeBanner = readFileSync(join(process.cwd(), 'src', 'components', 'ResumeBanner.tsx'), 'utf8')
    const chat = readFileSync(join(process.cwd(), 'src', 'components', 'Chat.tsx'), 'utf8')

    expect(agentRuns).toMatch(/status === 'suspended'[\s\S]*?\? \{ text: userMessage, resumeFromRunId: runId \}[\s\S]*?: userMessage[\s\S]*?gg-resume-send/u)
    expect(resumeBanner).toMatch(/gg-resume-send'[\s\S]*?detail: replayContext[\s\S]*?\? \{ text: run\.lastUserRequest, resumeFromRunId: run\.runId \}[\s\S]*?: \{ text: run\.lastUserRequest \}/u)
    expect(chat).toMatch(/function onResume[\s\S]*?resumeAutoSendRef\.current = true[\s\S]*?addEventListener\('gg-resume-send', onResume\)/u)
    expect(chat).toMatch(/resumeAutoSendRef\.current[\s\S]*?void send\(\)/u)
    expect(chat).toMatch(/pipelineSendModeRef\.current[\s\S]*?void send\(\)/u)
  })

  it.each([
    ['src/components/chat/send-help-message.ts'],
    ['src/components/SideChat.tsx'],
    ['src/components/PlanView.tsx'],
    ['src/store/projectStore.ts'],
    ['src/store/review-slice.ts'],
  ])('keeps non-composer renderer path safe-deny: %s', (relativePath) => {
    const source = readFileSync(join(process.cwd(), ...relativePath.split('/')), 'utf8')
    expect(source).not.toContain('originalUserText')
  })

  it.each([
    ['electron/storage/agent-runs.ts'],
    ['electron/ipc/ai-send/run-input.ts'],
    ['electron/ai/resume-checkpoint.ts'],
    ['electron/ai/tool-telemetry.ts'],
  ])('never adds raw composer provenance to a durable sink: %s', (relativePath) => {
    const source = readFileSync(join(process.cwd(), ...relativePath.split('/')), 'utf8')
    expect(source).not.toContain('originalUserText')
  })

  it('carries original-user consent into every tool turn without recomputing it from model context', () => {
    const source = readFileSync(join(process.cwd(), 'electron', 'ai', 'runner-api.ts'), 'utf8')
    const ai = readFileSync(join(process.cwd(), 'electron', 'ipc', 'ai.ts'), 'utf8')
    expect(source).toContain('computerUseAllowedActions,')
    expect(source).toMatch(/computerUseAllowedActions,\s*\/\/[^\n]*run-scoped/u)
    expect(source).toContain("computerUseProviderEnvelope?: 'fresh-composer-ticket-v1'")
    expect(ai).toContain("computerUseProviderEnvelope: computerUseEnvelopeLocked ? 'fresh-composer-ticket-v1' : undefined")
  })

  it('describes the runtime-selected exact target instead of requiring a Settings bind', () => {
    const system = readFileSync(join(process.cwd(), 'electron', 'ipc', 'ai-send', 'system-assembly.ts'), 'utf8')
    const tools = readFileSync(join(process.cwd(), 'electron', 'ai', 'tools.ts'), 'utf8')
    expect(system).toContain('runtime-selected exact native window')
    expect(system).not.toContain('one explicitly selected native window')
    expect(tools).not.toContain('Настройки → Браузер и Computer Use')
  })

  it('keeps the desktop gate across tool turns and fallback frames', () => {
    const source = readFileSync(join(process.cwd(), 'electron', 'ai', 'runner-api.ts'), 'utf8')
    expect(source).toContain('const computerRunState = {')
    expect(source).toMatch(/active:\s*\(computerUseAllowedActions\?\.length\s*\?\?\s*0\)\s*>\s*0/u)
    expect(source).toContain('messagesContainComputerContext(initialMessages)')
    expect(source).toContain('computerRunState,')
    expect(source.match(/computerContextExposed: computerRunState\.contextExposed/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps project todos, hooks and MCP definitions outside the active Computer provider envelope', () => {
    const source = readFileSync(join(process.cwd(), 'electron', 'ai', 'runner-api.ts'), 'utf8')
    expect(source).toContain('const activeSessionTodos = computerRunState.active ? undefined : sessionTodos')
    expect(source).toContain('const hooks: CompiledHooks | null = !computerRunState.active')
    expect(source).toContain('selectComputerToolDefs(TOOL_DEFS, computerUseAllowedActions)')
    expect(source).toContain('sessionTodos: activeSessionTodos,')
  })

  it('offers the R3 lane in server-owned browser -> artifact -> computer phases only', () => {
    const runner = readFileSync(join(process.cwd(), 'electron', 'ai', 'runner-api.ts'), 'utf8')
    const dispatcher = readFileSync(join(process.cwd(), 'electron', 'ai', 'runner-tool-turn.ts'), 'utf8')
    expect(runner).toContain("if (phase === 'artifact-ready') return computer.has(definition.name)")
    expect(runner).toContain("if (phase === 'browser-ready')")
    expect(runner).toContain("if (phase === null) return definition.name.startsWith('browser_')")
    expect(runner).toContain("browserRunState.r3Handoff?.phase ?? null")
    expect(dispatcher).toContain('createR3ServerHandoff(')
    expect(dispatcher).toContain('persistR3HandoffCheckpoint?.(browserRunState.r3Handoff)')
    expect(dispatcher).toContain('isR3BrowserMutationTool(toolName)')
  })

  it('fails route changes closed from active selected-window authority before any tool', () => {
    const source = readFileSync(join(process.cwd(), 'electron', 'ai', 'runner-api.ts'), 'utf8')
    expect(source).toContain('browserRunState.contextExposed || computerRunState.active')
    expect(source).toMatch(/!computerRunState\.active\s*&&\s*browserContextProviderAllowed\?\.\(candidateProviderId\) === true/)
  })

  it('projects desktop context before compaction and omits derived final text from durable sinks', () => {
    const source = readFileSync(join(process.cwd(), 'electron', 'ai', 'runner-api.ts'), 'utf8')
    expect(source.match(/buildCompactSummaryPrompt\(\s*projectMessagesForPersistence\(currentMessages,/gu))
      .toHaveLength(2)
    expect(source).toContain("const durableAssistantText = computerRunState.active ? '' : lastAssistantText")
    expect(source).toContain("const durableSummary = computerRunState.active ? '' : lastSummary")
    expect(source).toContain('lastAssistantText: durableAssistantText')
    expect(source).toContain('lastSummary: durableSummary')
  })
})
