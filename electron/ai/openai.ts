import { createOpenAiCompatProvider } from './openai-compat'
import type { ChatProvider } from './types'

export const OPENAI_MODELS = [
  'gpt-5',
  'gpt-5-mini',
  'gpt-4o',
  'gpt-4o-mini',
  'o1',
  'o1-mini'
]

const DEFAULT_MODEL = OPENAI_MODELS[0]

export function createOpenAiProvider(opts: { apiKey: string; model?: string }): ChatProvider {
  return createOpenAiCompatProvider({
    id: 'openai',
    name: 'ChatGPT',
    models: OPENAI_MODELS,
    defaultModel: DEFAULT_MODEL,
    apiKey: opts.apiKey,
    model: opts.model
  })
}
