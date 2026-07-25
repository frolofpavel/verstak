import { prepareSystemContext } from '../ai/compose-system'
import { stripCacheBreakpoint } from '../ai/compose-prompt'
import { PROVIDERS, type ProviderId } from '../ai/registry'
import type { ChatMessage } from '../ai/types'

interface CountTokensDeps {
  getProviderId: () => ProviderId
  getProviderModel: (id: ProviderId) => string | null
  getSecret: (key: string) => string | null
  recentWrites: (projectPath: string, limit: number) => Array<{ filePath: string; createdAt: number }>
  searchMemories: (
    projectPath: string,
    query: string,
    limit: number,
  ) => Array<{ type: string; content: string; tags: string[] }>
}

interface CountTokensIpc {
  handle: (
    channel: string,
    listener: (
      event: unknown,
      text: string,
      projectPath: string | null,
      historyMessages?: ChatMessage[],
    ) => Promise<TokenCountResult>,
  ) => void
}

export interface TokenCountResult {
  tokens: number
  exact: boolean
  providerId: string
}

interface GeminiCountInput {
  apiKey: string
  model: string
  contents: Array<{ role: string; parts: Array<{ text: string }> }>
}

type GeminiCounter = (input: GeminiCountInput) => Promise<number>

function roughCount(text: string | null | undefined, providerId: ProviderId): TokenCountResult {
  return {
    tokens: Math.ceil((text?.length ?? 0) / 4),
    exact: false,
    providerId,
  }
}

async function countWithGemini(input: GeminiCountInput): Promise<number> {
  const { GoogleGenAI } = await import('@google/genai')
  const client = new GoogleGenAI({ apiKey: input.apiKey })
  const result = await (
    client.models as unknown as {
      countTokens: (options: {
        model: string
        contents: GeminiCountInput['contents']
      }) => Promise<{ totalTokens?: number }>
    }
  ).countTokens({ model: input.model, contents: input.contents })
  return result.totalTokens ?? 0
}

function loadCountMemories(
  deps: CountTokensDeps,
  projectPath: string | null,
): Array<{ type: string; content: string; tags: string[] }> {
  if (!projectPath) return []
  try {
    return deps.searchMemories(projectPath, '', 5)
  } catch {
    return []
  }
}

async function buildCountContents(
  deps: CountTokensDeps,
  projectPath: string | null,
  history: ChatMessage[],
  text: string,
): Promise<GeminiCountInput['contents']> {
  const composed = await prepareSystemContext({
    projectPath,
    messages: history,
    recentWrites: projectPath ? deps.recentWrites(projectPath, 8) : [],
    memories: loadCountMemories(deps, projectPath),
  })
  const contents: GeminiCountInput['contents'] = [
    { role: 'user', parts: [{ text: stripCacheBreakpoint(composed.system) }] },
  ]
  for (const message of history) {
    if (message.role === 'system') continue
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content ?? '' }],
    })
  }
  if (text) contents.push({ role: 'user', parts: [{ text }] })
  return contents
}

export async function countOutgoingTokens(
  deps: CountTokensDeps,
  text: string,
  projectPath: string | null,
  historyMessages?: ChatMessage[],
  geminiCounter: GeminiCounter = countWithGemini,
): Promise<TokenCountResult> {
  const providerId = deps.getProviderId()
  const descriptor = PROVIDERS[providerId]
  const apiKey = descriptor.secretKey ? deps.getSecret(descriptor.secretKey) : null
  if (!apiKey || descriptor.transport !== 'API' || providerId !== 'gemini-api') {
    return roughCount(text, providerId)
  }

  try {
    const model = deps.getProviderModel(providerId) ?? descriptor.defaultModel
    const history = Array.isArray(historyMessages) ? historyMessages : []
    const contents = await buildCountContents(deps, projectPath, history, text)
    const tokens = await geminiCounter({ apiKey, model, contents })
    return { tokens, exact: true, providerId }
  } catch (error) {
    console.error('[count-tokens]', error instanceof Error ? error.message : error)
    return roughCount(text, providerId)
  }
}

export function registerAiCountTokensIpc(ipc: CountTokensIpc, deps: CountTokensDeps): void {
  ipc.handle('ai:count-tokens', (_event, text, projectPath, historyMessages) =>
    countOutgoingTokens(deps, text, projectPath, historyMessages),
  )
}
