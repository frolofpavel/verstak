export type AgentModeSuitability = 'recommended' | 'allowed' | 'not-recommended'

export interface ModelRegistryEntry {
  providerId: string
  model: string
  contextLimit: number
  pricePerM?: {
    input: number
    output: number
    cached?: number
  }
  agentMode: AgentModeSuitability
  defaultRoles?: string[]
  aliasOf?: string
}

export const MODEL_REGISTRY: ModelRegistryEntry[] = [
  {
    providerId: 'verstak-gateway',
    model: 'kimi-k2.7-code',
    contextLimit: 256_000,
    pricePerM: { input: 0.95, output: 4.00 },
    agentMode: 'recommended',
    defaultRoles: ['coding', 'planner', 'reviewer']
  },
  {
    providerId: 'verstak-gateway',
    model: 'deepseek-chat',
    contextLimit: 1_000_000,
    pricePerM: { input: 0.28, output: 0.42 },
    agentMode: 'allowed',
    defaultRoles: ['fallback', 'fast-edit']
  },
  {
    providerId: 'verstak-gateway',
    model: 'qwen3-coder',
    contextLimit: 256_000,
    pricePerM: { input: 1.00, output: 5.00 },
    agentMode: 'allowed'
  },
  { providerId: 'verstak-gateway', model: 'verstak/economy', contextLimit: 1_000_000, agentMode: 'allowed', aliasOf: 'deepseek-chat' },
  { providerId: 'verstak-gateway', model: 'verstak/free', contextLimit: 128_000, agentMode: 'not-recommended' },
  { providerId: 'verstak-gateway', model: 'verstak/balanced', contextLimit: 256_000, agentMode: 'allowed', aliasOf: 'kimi-k2.7-code' },
  { providerId: 'verstak-gateway', model: 'verstak/coder', contextLimit: 256_000, agentMode: 'allowed', aliasOf: 'kimi-k2.7-code' },
  { providerId: 'verstak-gateway', model: 'verstak/long', contextLimit: 1_000_000, agentMode: 'allowed' },
  { providerId: 'verstak-gateway', model: 'verstak/fast', contextLimit: 1_000_000, agentMode: 'not-recommended', aliasOf: 'deepseek-chat' },
  { providerId: 'verstak-gateway', model: 'verstak/private', contextLimit: 128_000, agentMode: 'allowed' },

  {
    providerId: 'moonshot',
    model: 'kimi-k2.7-code',
    contextLimit: 256_000,
    pricePerM: { input: 0.95, output: 4.00 },
    agentMode: 'recommended',
    defaultRoles: ['coding', 'planner', 'reviewer']
  },
  { providerId: 'moonshot', model: 'kimi-k2.6', contextLimit: 256_000, pricePerM: { input: 0.60, output: 2.50 }, agentMode: 'allowed' },
  { providerId: 'moonshot', model: 'kimi-k2.5', contextLimit: 256_000, pricePerM: { input: 0.60, output: 2.50 }, agentMode: 'allowed' },
  { providerId: 'moonshot', model: 'moonshot-v1-128k', contextLimit: 128_000, pricePerM: { input: 2.00, output: 5.00 }, agentMode: 'allowed' },
  { providerId: 'moonshot', model: 'moonshot-v1-32k', contextLimit: 32_000, pricePerM: { input: 1.00, output: 3.00 }, agentMode: 'allowed' },
  { providerId: 'moonshot', model: 'moonshot-v1-8k', contextLimit: 8_000, pricePerM: { input: 0.20, output: 2.00 }, agentMode: 'allowed' },

  // Подписочные coding-планы: цена за токен 0 (фикс-подписка, лимиты в промптах).
  // kimi-for-coding = K2.7 Code через членство kimi.com; контекст 262144 из доков Kimi Code.
  { providerId: 'kimi-coding', model: 'kimi-for-coding', contextLimit: 262_144, pricePerM: { input: 0, output: 0 }, agentMode: 'recommended', defaultRoles: ['coding'] },
  // GLM Coding Plan заявляет до 1M у GLM-5.2 — держим консервативно 200K, пока не проверено вживую.
  { providerId: 'zai-coding', model: 'glm-5.2', contextLimit: 200_000, pricePerM: { input: 0, output: 0 }, agentMode: 'allowed' },
  { providerId: 'zai-coding', model: 'glm-5-turbo', contextLimit: 128_000, pricePerM: { input: 0, output: 0 }, agentMode: 'allowed' },

  { providerId: 'deepseek', model: 'deepseek-v4-flash', contextLimit: 1_000_000, pricePerM: { input: 0.28, output: 0.42 }, agentMode: 'allowed' },
  { providerId: 'deepseek', model: 'deepseek-v4-pro', contextLimit: 1_000_000, pricePerM: { input: 0.55, output: 2.19 }, agentMode: 'allowed' },
  { providerId: 'deepseek', model: 'deepseek-chat', contextLimit: 1_000_000, pricePerM: { input: 0.28, output: 0.42 }, agentMode: 'allowed', defaultRoles: ['fallback', 'fast-edit'] },
  { providerId: 'deepseek', model: 'deepseek-reasoner', contextLimit: 1_000_000, pricePerM: { input: 0.55, output: 2.19 }, agentMode: 'allowed' },

  { providerId: 'qwen', model: 'qwen3-max', contextLimit: 256_000, pricePerM: { input: 1.60, output: 6.40 }, agentMode: 'allowed' },
  { providerId: 'qwen', model: 'qwen3-coder-plus', contextLimit: 256_000, pricePerM: { input: 1.00, output: 5.00 }, agentMode: 'allowed' },
  { providerId: 'qwen', model: 'qwen3-coder-flash', contextLimit: 256_000, pricePerM: { input: 0.30, output: 1.50 }, agentMode: 'allowed' },
  { providerId: 'qwen', model: 'qwen-max', contextLimit: 32_000, pricePerM: { input: 1.60, output: 6.40 }, agentMode: 'allowed' },
  { providerId: 'qwen', model: 'qwen-plus', contextLimit: 128_000, pricePerM: { input: 0.40, output: 1.20 }, agentMode: 'allowed' },
  { providerId: 'qwen', model: 'qwen-flash', contextLimit: 1_000_000, pricePerM: { input: 0.05, output: 0.40 }, agentMode: 'allowed' }
]

export function modelRegistryForProvider(providerId: string): ModelRegistryEntry[] {
  return MODEL_REGISTRY.filter(entry => entry.providerId === providerId)
}

export function modelRegistryEntry(providerId: string, model: string): ModelRegistryEntry | undefined {
  return MODEL_REGISTRY.find(entry => entry.providerId === providerId && entry.model === model)
}

export function getRegisteredContextLimit(model: string): number | undefined {
  return MODEL_REGISTRY.find(entry => entry.model === model)?.contextLimit
}

export function getRegisteredModelPrice(model: string): ModelRegistryEntry['pricePerM'] | undefined {
  return MODEL_REGISTRY.find(entry => entry.model === model)?.pricePerM
}
