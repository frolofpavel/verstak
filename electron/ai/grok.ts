import { createOpenAiCompatProvider } from './openai-compat'
import type { ChatProvider } from './types'

export const GROK_MODELS = [
  'grok-4',
  'grok-4-fast',
  'grok-3'
]

const DEFAULT_MODEL = GROK_MODELS[0]

export function createGrokProvider(opts: { apiKey: string; model?: string }): ChatProvider {
  return createOpenAiCompatProvider({
    id: 'grok',
    name: 'Grok',
    models: GROK_MODELS,
    defaultModel: DEFAULT_MODEL,
    apiKey: opts.apiKey,
    baseUrl: 'https://api.x.ai/v1',
    model: opts.model
  })
}
