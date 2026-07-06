import { createOpenAiCompatProvider } from './openai-compat'
import type { ChatProvider } from './types'

export const GROK_MODELS = [
  'grok-4.3',
  'grok-build-0.1'
]

const DEFAULT_MODEL = GROK_MODELS[0]

export function createGrokProvider(opts: { apiKey: string; model?: string; effortLevel?: 'quick' | 'standard' | 'deep' }): ChatProvider {
  const requestedModel = opts.model && opts.model !== 'auto' ? opts.model : DEFAULT_MODEL
  const model = GROK_MODELS.includes(requestedModel) ? requestedModel : DEFAULT_MODEL
  return createOpenAiCompatProvider({
    id: 'grok',
    name: 'Grok',
    models: GROK_MODELS,
    defaultModel: DEFAULT_MODEL,
    apiKey: opts.apiKey,
    baseUrl: 'https://api.x.ai/v1',
    model,
    effortLevel: opts.effortLevel
  })
}
