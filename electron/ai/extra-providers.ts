/**
 * OpenAI-compatible провайдеры через universal client. Все они говорят на
 * OpenAI API — добавляются мгновенно потому что у нас уже есть
 * createOpenAiCompatProvider({apiKey, baseUrl, models, model}).
 *
 * Дополнительные провайдеры в стиле OpenCode — Available стоят OpenRouter,
 * DeepSeek, Vercel Gateway, Custom, etc. Выбраны наиболее полезные
 * для русского рынка:
 *  - OpenRouter (один ключ → все модели)
 *  - DeepSeek (дешёвый, R1 reasoning)
 *  - Mistral (европейский, без санкционных рисков)
 *  - Groq (быстрый inference для Llama/Mixtral)
 *  - Ollama (локальный — для self-hosted моделей)
 *  - Custom — универсальный слот: baseUrl + key + список моделей вручную
 */

import { createOpenAiCompatProvider } from './openai-compat'
import type { ChatProvider } from './types'

export interface ExtraProviderSpec {
  /** ID для use в registry. */
  id: 'openrouter' | 'deepseek' | 'moonshot' | 'qwen' | 'mistral' | 'groq' | 'ollama' | 'custom-openai'
  /** Человекочитаемое имя. */
  name: string
  /** Описание для UI карточки. */
  description: string
  /** Settings key для API key (null если local, как Ollama). */
  secretKey: string | null
  /** Где взять ключ — URL для UI hint'а. */
  keyLink?: { url: string; label: string }
  /** Plaaceholder для поля ключа. */
  keyHint: string
  /** Дефолтный список моделей (для Custom — из settings). */
  models: string[]
  /** Модель по умолчанию. */
  defaultModel: string
  /** baseUrl для OpenAI SDK. Для Custom — из settings.custom_openai_baseurl. */
  baseUrl: string | null
}

export const EXTRA_PROVIDERS: ExtraProviderSpec[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'Один ключ → все модели (Claude, GPT, Gemini, Grok, open-source). Удобно когда не хочешь заводить N ключей.',
    secretKey: 'openrouter_api_key',
    keyLink: { url: 'https://openrouter.ai/keys', label: 'openrouter.ai/keys' },
    keyHint: 'sk-or-...',
    models: [
      'anthropic/claude-opus-4-5',
      'anthropic/claude-sonnet-4-6',
      'openai/gpt-5',
      'openai/gpt-5-mini',
      'google/gemini-3-pro',
      'google/gemini-3.5-flash',
      'x-ai/grok-4',
      'moonshotai/kimi-k2.7-code',
      'deepseek/deepseek-v3',
      'meta-llama/llama-3.3-70b-instruct'
    ],
    defaultModel: 'anthropic/claude-sonnet-4-6',
    baseUrl: 'https://openrouter.ai/api/v1'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'Китайские модели V4 — копейки за токен. v4-flash (быстрый) / v4-pro (reasoning). Лучший fallback для бюджета.',
    secretKey: 'deepseek_api_key',
    keyLink: { url: 'https://platform.deepseek.com/api_keys', label: 'platform.deepseek.com' },
    keyHint: 'sk-...',
    // Модели подтверждены: https://api-docs.deepseek.com/quick_start/pricing (V4, июнь 2026).
    // deepseek-chat / deepseek-reasoner — legacy-алиасы V4-Flash, deprecated 2026-07-24 (пока работают).
    models: [
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-chat',
      'deepseek-reasoner'
    ],
    defaultModel: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com/v1'
  },
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    description: 'Китайский Kimi — open-source SoTA по агентам и коду. K2.7-Code (coding-first, 256K, $0.95/$4) дёшев под рои; K2.6 — общий флагман. OpenAI-совместим.',
    secretKey: 'moonshot_api_key',
    keyLink: { url: 'https://platform.moonshot.ai/console/api-keys', label: 'platform.moonshot.ai' },
    keyHint: 'sk-...',
    // Модели подтверждены: https://platform.kimi.ai/docs/models.md (июнь 2026).
    // kimi-k2.7-code — coding-first (релиз 12.06.2026, open-source 1T MoE, 256K);
    // kimi-k2.6 — общий флагман; moonshot-v1-* — длинноконтекстная классика.
    models: [
      'kimi-k2.7-code',
      'kimi-k2.6',
      'kimi-k2.5',
      'moonshot-v1-128k',
      'moonshot-v1-32k',
      'moonshot-v1-8k'
    ],
    defaultModel: 'kimi-k2.7-code',
    baseUrl: 'https://api.moonshot.ai/v1'
  },
  {
    id: 'qwen',
    name: 'Qwen (Alibaba)',
    description: 'Alibaba Qwen3 через DashScope. qwen3-coder-plus — сильный кодер, qwen3-max — флагман. OpenAI-совместим.',
    secretKey: 'qwen_api_key',
    keyLink: { url: 'https://bailian.console.aliyun.com/', label: 'bailian.console.aliyun.com' },
    keyHint: 'sk-...',
    // Модели + intl base url подтверждены: https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope (июнь 2026).
    // Endpoint — международный (Singapore); ключи China и Intl не взаимозаменяемы.
    models: [
      'qwen3-max',
      'qwen3-coder-plus',
      'qwen3-coder-flash',
      'qwen-max',
      'qwen-plus',
      'qwen-flash'
    ],
    defaultModel: 'qwen3-coder-plus',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
  },
  {
    id: 'mistral',
    name: 'Mistral',
    description: 'Европейский провайдер. Без санкционных рисков. Codestral хорош для генерации кода.',
    secretKey: 'mistral_api_key',
    keyLink: { url: 'https://console.mistral.ai/api-keys', label: 'console.mistral.ai' },
    keyHint: '...',
    models: [
      'mistral-large-latest',
      'mistral-small-latest',
      'codestral-latest',
      'ministral-8b-latest'
    ],
    defaultModel: 'mistral-large-latest',
    baseUrl: 'https://api.mistral.ai/v1'
  },
  {
    id: 'groq',
    name: 'Groq',
    description: 'LPU-инференс: Llama/Mixtral на скорости 500+ tok/s. Для streaming-чатов где важна реакция.',
    secretKey: 'groq_api_key',
    keyLink: { url: 'https://console.groq.com/keys', label: 'console.groq.com' },
    keyHint: 'gsk_...',
    models: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'mixtral-8x7b-32768',
      'gemma2-9b-it'
    ],
    defaultModel: 'llama-3.3-70b-versatile',
    baseUrl: 'https://api.groq.com/openai/v1'
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    description: 'Локальный сервер. Запусти `ollama serve` и подключайся к localhost:11434. $0, без интернета, данные не уходят.',
    secretKey: null, // Локальный, ключ не нужен
    keyHint: '',
    models: [
      'llama3.3',
      'qwen2.5-coder',
      'deepseek-r1',
      'mistral',
      'gemma2'
    ],
    defaultModel: 'llama3.3',
    baseUrl: 'http://localhost:11434/v1'
  },
  {
    id: 'custom-openai',
    name: 'Свой провайдер (OpenAI-compatible)',
    description: 'Любой self-hosted endpoint совместимый с OpenAI API: vLLM, LM Studio, Text Generation WebUI, корпоративный шлюз.',
    secretKey: 'custom_openai_api_key',
    keyHint: '(опционально — если endpoint требует)',
    models: [], // Заполняется юзером в Settings → custom_openai_models
    defaultModel: '',
    baseUrl: null // Из settings.custom_openai_baseurl
  }
]

/**
 * Builder для extra-провайдера. Принимает providerId и runtime-конфиг
 * (apiKey + дополнительные опции для custom-openai из settings).
 */
export function createExtraProvider(
  id: ExtraProviderSpec['id'],
  opts: {
    apiKey: string
    model?: string
    /** Для custom-openai: переопределённый baseUrl из settings. */
    customBaseUrl?: string
    /** Для custom-openai: список моделей из settings (comma-separated парсится в caller'е). */
    customModels?: string[]
  }
): ChatProvider {
  const spec = EXTRA_PROVIDERS.find(p => p.id === id)
  if (!spec) throw new Error(`Unknown extra provider: ${id}`)

  const baseUrl = id === 'custom-openai' ? opts.customBaseUrl : spec.baseUrl
  if (!baseUrl) {
    throw new Error(`${spec.name}: baseUrl не настроен. Открой Settings → Провайдеры → ${spec.name}.`)
  }

  const models = id === 'custom-openai' && opts.customModels && opts.customModels.length > 0
    ? opts.customModels
    : spec.models

  const defaultModel = models[0] ?? spec.defaultModel

  return createOpenAiCompatProvider({
    id: spec.id,
    name: spec.name,
    models,
    defaultModel,
    apiKey: opts.apiKey,
    baseUrl,
    model: opts.model
  })
}
