import { createGeminiProvider } from './gemini'
import { createGeminiCliProvider, GEMINI_CLI_MODELS } from './gemini-cli'
import { createClaudeProvider, CLAUDE_MODELS } from './claude'
import { createClaudeCliProvider, CLAUDE_CLI_MODELS } from './claude-cli'
import { createGrokProvider, GROK_MODELS } from './grok'
import { createGrokCliProvider, DEFAULT_GROK_CLI_MODEL, GROK_CLI_MODELS } from './grok-cli'
import { createOpenAiProvider, OPENAI_MODELS } from './openai'
import { createCodexCliProvider, CODEX_CLI_MODELS } from './codex-cli'
import { createExtraProvider, EXTRA_PROVIDERS, type ExtraProviderSpec } from './extra-providers'
import { createYandexGptProvider, YANDEX_GPT_MODELS } from './yandex-gpt'
import { createGigaChatProvider, GIGACHAT_MODELS } from './gigachat'
import type { ChatProvider } from './types'
import type { AgentMode } from './mode-policy'

export type ProviderId =
  | 'gemini-api' | 'gemini-cli'
  | 'claude' | 'claude-cli'
  | 'grok' | 'grok-cli'
  | 'openai' | 'codex-cli'
  | 'yandex-gpt' | 'gigachat'
  | ExtraProviderSpec['id']

export interface ProviderDescriptor {
  id: ProviderId
  name: string
  /** Short transport tag shown to the user: "API" / "CLI" / "—" */
  transport: 'API' | 'CLI'
  /** Settings key for the API key (null if not key-based, e.g. CLI). */
  secretKey: string | null
  /** Available model ids; "auto" for CLI where the binary picks. */
  models: string[]
  defaultModel: string
  /** Whether function calling / file tools are supported in this build. */
  supportsTools: boolean
  /** Human-readable model label shown in the chat status pill. */
  shortLabel: string
}

/**
 * Ревью F3: формальная матрица возможностей провайдера. Раньше контроль был
 * только в двух полях (transport/supportsTools), а остальное (verification,
 * tick, resume, mcp, delegation, attachments) подразумевалось разрозненно — и
 * пользователь не видел, что на CLI moat «контроль» деградирует.
 */
export interface ProviderCapabilities {
  /** Агентный tool-loop ПОД контролем Verstak (read/write/run_command/apply_patch). */
  tools: boolean
  /** attest_verification artifact + DoD-доказательство выполнения. */
  verification: boolean
  /** Живой таймлайн прогресса (tick) в Tasks / AgentRuns. */
  liveTimeline: boolean
  /** Crash-resume безопасен (авто-доигрывание не повторит деструктив). */
  resumeSafe: boolean
  /** MCP-инструменты внешних серверов. */
  mcp: boolean
  /** Делегирование подзадач (delegate / orchestrate / swarm). */
  delegation: boolean
  /** Вложения (картинки/файлы); иначе деградируют в текстовый хинт. */
  attachments: boolean
}

/**
 * Единый источник правды о возможностях провайдера. Выводится из transport +
 * supportsTools — реальных детерминантов в коде (не хардкод-таблица на 18 строк,
 * которая бы дрейфовала). На CLI инструменты и проверка идут ВНУТРИ бинаря, и
 * Verstak их не видит: runPlainConversation физически не зовёт tools/verification/
 * tick (см. ipc/ai.ts), а CLI-прогоны не auto-resumable (agent-runs.ts).
 */
export function providerCapabilities(d: Pick<ProviderDescriptor, 'transport' | 'supportsTools'>): ProviderCapabilities {
  const full = d.transport === 'API' && d.supportsTools
  return {
    tools: full,
    verification: full,
    liveTimeline: full,
    resumeSafe: d.transport === 'API',
    mcp: full,
    delegation: full,
    attachments: d.transport === 'API'
  }
}

export const PROVIDERS: Record<ProviderId, ProviderDescriptor> = {
  'gemini-api': {
    id: 'gemini-api',
    name: 'Gemini',
    transport: 'API',
    secretKey: 'gemini_api_key',
    models: ['gemini-3-pro', 'gemini-3.5-flash', 'gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    defaultModel: 'gemini-3.5-flash',
    supportsTools: true,
    shortLabel: 'Gemini'
  },
  'gemini-cli': {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    transport: 'CLI',
    secretKey: null,
    models: GEMINI_CLI_MODELS,
    defaultModel: 'auto',
    supportsTools: false,
    shortLabel: 'Gemini Ultra'
  },
  claude: {
    id: 'claude',
    name: 'Claude',
    transport: 'API',
    secretKey: 'anthropic_api_key',
    models: CLAUDE_MODELS,
    defaultModel: 'claude-sonnet-4-6',
    supportsTools: true,
    shortLabel: 'Claude'
  },
  'claude-cli': {
    id: 'claude-cli',
    name: 'Claude Code',
    transport: 'CLI',
    secretKey: null,
    models: CLAUDE_CLI_MODELS,
    defaultModel: 'auto',
    supportsTools: false,
    shortLabel: 'Claude Code'
  },
  grok: {
    id: 'grok',
    name: 'Grok',
    transport: 'API',
    secretKey: 'xai_api_key',
    models: GROK_MODELS,
    defaultModel: 'grok-4.3',
    supportsTools: true,
    shortLabel: 'Grok'
  },
  'grok-cli': {
    id: 'grok-cli',
    name: 'Grok Build',
    transport: 'CLI',
    secretKey: null,
    models: GROK_CLI_MODELS,
    defaultModel: DEFAULT_GROK_CLI_MODEL,
    supportsTools: false,
    shortLabel: 'Grok Build'
  },
  openai: {
    id: 'openai',
    name: 'ChatGPT',
    transport: 'API',
    secretKey: 'openai_api_key',
    models: OPENAI_MODELS,
    defaultModel: 'gpt-5',
    supportsTools: true,
    shortLabel: 'ChatGPT'
  },
  'codex-cli': {
    id: 'codex-cli',
    name: 'Codex',
    transport: 'CLI',
    secretKey: null,
    models: CODEX_CLI_MODELS,
    defaultModel: 'auto',
    supportsTools: false,
    shortLabel: 'Codex'
  },
  // 🇷🇺 Российские провайдеры (152-ФЗ). secretKey = primary key для enabled_models;
  // дополнительные поля (yandex_folder_id, gigachat_client_secret) читаются
  // в ipc/ai.ts из settings и пробрасываются через CreateOptions.
  'yandex-gpt': {
    id: 'yandex-gpt',
    name: 'YandexGPT',
    transport: 'API',
    secretKey: 'yandex_api_key',
    models: YANDEX_GPT_MODELS,
    defaultModel: 'yandexgpt/latest',
    supportsTools: true,
    shortLabel: 'YandexGPT'
  },
  gigachat: {
    id: 'gigachat',
    name: 'GigaChat',
    transport: 'API',
    secretKey: 'gigachat_client_id',
    models: GIGACHAT_MODELS,
    defaultModel: 'GigaChat',
    supportsTools: true,
    shortLabel: 'GigaChat'
  },
  // OpenAI-compatible extra-провайдеры (генерим из EXTRA_PROVIDERS).
  ...Object.fromEntries(
    EXTRA_PROVIDERS.map(spec => [spec.id, {
      id: spec.id,
      name: spec.name,
      transport: 'API' as const,
      secretKey: spec.secretKey,
      models: spec.models,
      defaultModel: spec.defaultModel,
      supportsTools: true, // OpenAI-compat по протоколу поддерживает tool-calling
      shortLabel: spec.name
    }])
  ) as Record<ExtraProviderSpec['id'], ProviderDescriptor>
}

export interface CreateOptions {
  apiKey?: string | null
  model?: string
  cwd?: string
  signal?: AbortSignal
  /** Промпт из Project Settings UI — пробрасывается до buildCliPrompt чтобы
   *  попасть в payload CLI-провайдеров. Для API-провайдеров не нужен (там
   *  ipc/ai.ts напрямую вызывает prepareSystemContext с этим полем). */
  projectSystemPrompt?: string | null
  /** Промпт активного скилла — пробрасывается до buildCliPrompt (<skill_layer>),
   *  чтобы CLI-провайдеры видели активный скилл, как и API-провайдеры. */
  skillPrompt?: string | null
  /** OAuth token для Claude Code (из `claude setup-token`). Передаётся как
   *  env var CLAUDE_CODE_OAUTH_TOKEN — решает headless+Max ограничение. */
  claudeOauthToken?: string | null
  /** Для custom-openai: переопределённый baseUrl из settings. */
  customBaseUrl?: string
  /** Для custom-openai: список моделей из settings (comma-separated parsed). */
  customModels?: string[]
  /** Для yandex-gpt: ID Yandex Cloud folder (из settings). */
  yandexFolderId?: string
  /** Для gigachat: client_secret (primary key=clientId; secret в SafeStorage отдельно). */
  gigachatClientSecret?: string
  /** Аудит M3: проверять TLS-сертификат GigaChat (нужен Russian Trusted Root CA
   *  в системном хранилище). По умолчанию выкл — иначе CERT_UNTRUSTED. */
  gigachatTlsVerify?: boolean
  /** Топ-5 воспоминаний проекта — пробрасываются в buildCliPrompt для CLI-провайдеров,
   *  чтобы они получали тот же контекст памяти что и API-провайдеры. */
  memories?: Array<{ type: string; content: string; tags: string[] }>
  /** Уровень усилий модели: влияет на max_tokens и extended thinking.
   *  'quick' — короткие ответы; 'standard' (default) — без изменений; 'deep' — максимальное мышление. */
  effortLevel?: 'quick' | 'standard' | 'deep'
  /** Режим агента — CLI-провайдеры (Codex) маппят его во флаги песочницы.
   *  Для API-провайдеров режим применяется в ipc/ai.ts через mode-policy.decide. */
  agentMode?: AgentMode
}

export function createProvider(id: ProviderId, opts: CreateOptions): ChatProvider {
  switch (id) {
    case 'gemini-api': {
      if (!opts.apiKey) throw new Error('Gemini API key not set')
      return createGeminiProvider({ apiKey: opts.apiKey, model: opts.model, effortLevel: opts.effortLevel })
    }
    case 'gemini-cli':
      return createGeminiCliProvider({ cwd: opts.cwd, signal: opts.signal, model: opts.model, projectSystemPrompt: opts.projectSystemPrompt, skillPrompt: opts.skillPrompt, memories: opts.memories, agentMode: opts.agentMode })
    case 'claude': {
      if (!opts.apiKey) throw new Error('Anthropic API key not set')
      return createClaudeProvider({ apiKey: opts.apiKey, model: opts.model, effortLevel: opts.effortLevel })
    }
    case 'claude-cli':
      return createClaudeCliProvider({
        cwd: opts.cwd,
        signal: opts.signal,
        model: opts.model,
        projectSystemPrompt: opts.projectSystemPrompt,
        skillPrompt: opts.skillPrompt,
        oauthToken: opts.claudeOauthToken,
        memories: opts.memories,
        agentMode: opts.agentMode
      })
    case 'grok': {
      if (!opts.apiKey) throw new Error('xAI (Grok) API key not set')
      return createGrokProvider({ apiKey: opts.apiKey, model: opts.model, effortLevel: opts.effortLevel })
    }
    case 'grok-cli':
      return createGrokCliProvider({ cwd: opts.cwd, signal: opts.signal, model: opts.model, projectSystemPrompt: opts.projectSystemPrompt, skillPrompt: opts.skillPrompt, memories: opts.memories, agentMode: opts.agentMode })
    case 'openai': {
      if (!opts.apiKey) throw new Error('OpenAI API key not set')
      return createOpenAiProvider({ apiKey: opts.apiKey, model: opts.model, effortLevel: opts.effortLevel })
    }
    case 'codex-cli':
      return createCodexCliProvider({ cwd: opts.cwd, signal: opts.signal, model: opts.model, projectSystemPrompt: opts.projectSystemPrompt, skillPrompt: opts.skillPrompt, memories: opts.memories, agentMode: opts.agentMode })
    case 'yandex-gpt': {
      if (!opts.apiKey) throw new Error('YandexGPT: API ключ не задан')
      if (!opts.yandexFolderId) throw new Error('YandexGPT: Folder ID не задан (Settings → Провайдеры → YandexGPT)')
      return createYandexGptProvider({ apiKey: opts.apiKey, folderId: opts.yandexFolderId, model: opts.model })
    }
    case 'gigachat': {
      if (!opts.apiKey) throw new Error('GigaChat: Client ID не задан')
      if (!opts.gigachatClientSecret) throw new Error('GigaChat: Client Secret не задан (Settings → Провайдеры → GigaChat)')
      return createGigaChatProvider({ clientId: opts.apiKey, clientSecret: opts.gigachatClientSecret, model: opts.model, tlsVerify: opts.gigachatTlsVerify })
    }
    case 'openrouter':
    case 'deepseek':
    case 'moonshot':
    case 'qwen':
    case 'mistral':
    case 'groq':
    case 'ollama':
    case 'verstak-gateway':
    case 'custom-openai': {
      // Для Ollama (local) ключ необязателен; для остальных — нужен.
      const spec = EXTRA_PROVIDERS.find(p => p.id === id)!
      if (spec.secretKey && id !== 'custom-openai' && !opts.apiKey) {
        throw new Error(`${spec.name}: API ключ не задан`)
      }
      if (id === 'custom-openai' && !opts.customBaseUrl) {
        throw new Error('Custom OpenAI-compatible: укажи Base URL в Settings → Провайдеры.')
      }
      return createExtraProvider(id, {
        apiKey: opts.apiKey ?? '',
        model: opts.model,
        customBaseUrl: opts.customBaseUrl,
        customModels: opts.customModels
      })
    }
  }
}
