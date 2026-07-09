import { spawn } from 'child_process'
import { platform } from 'os'
import { existsSync } from 'fs'
import { join } from 'path'
import type { ChatProvider, ChatMessage, ChatEvent, ToolDefinition, ToolResult } from './types'
import type { AgentMode } from './mode-policy'
import { buildCliPrompt } from './cli-prompt'
import { treeKill } from './child-kill'

interface CodexCliOptions {
  binary?: string
  cwd?: string
  signal?: AbortSignal
  model?: string
  projectSystemPrompt?: string | null
  /** Промпт активного скилла — наслаивается секцией <skill_layer> в buildCliPrompt. */
  skillPrompt?: string | null
  memories?: Array<{ type: string; content: string; tags: string[] }>
  /** Режим агента Verstak — маппится во флаги песочницы `codex exec`.
   *  Без него Codex стартует в read-only и не может писать/выполнять (auto «не встаёт»). */
  agentMode?: AgentMode
  /** 1.9.3 мультиаккаунт: изолированный CODEX_HOME активного аккаунта (auth/config/history
   *  Codex живут относительно него). undefined = дефолт ~/.codex. */
  codexHome?: string
}

/**
 * Перевести режим Verstak во флаги песочницы `codex exec` (он неинтерактивен,
 * approval-промптов нет — рычаг только sandbox-политика):
 *  ask/plan → read-only · accept-edits/auto → workspace-write · bypass → full bypass.
 *
 * Windows: дефолтная (elevated) песочница Codex валится на этапе подготовки
 * («windows sandbox: spawn setup refresh» — openai/codex#25497, #24098), из-за
 * чего не выполняется даже read-only команда (агент не может прочитать файл).
 * Unelevated-вариант рабочий, поэтому на Windows форсим `-c windows.sandbox=unelevated`,
 * сохраняя семантику режима. Для bypass песочница отключена целиком — фикс не нужен.
 */
export function sandboxArgsForMode(
  mode: AgentMode | undefined,
  isWindows: boolean = platform() === 'win32'
): string[] {
  if (mode === 'bypass') {
    return ['--dangerously-bypass-approvals-and-sandbox']
  }
  const winFix = isWindows ? ['-c', 'windows.sandbox=unelevated'] : []
  switch (mode) {
    case 'auto':
    case 'accept-edits':
      return [...winFix, '-s', 'workspace-write']
    case 'plan':
    case 'ask':
    default:
      return [...winFix, '-s', 'read-only']
  }
}

export const CODEX_CLI_MODELS = [
  'auto',
  'gpt-5-codex',
  'gpt-5',
  'gpt-5-mini',
  'o3',
  'o3-mini',
  'gpt-4o'
]

function findBinary(): string {
  if (platform() === 'win32' && process.env.APPDATA) {
    const candidates = [
      join(process.env.APPDATA, 'npm', 'codex.cmd'),
      join(process.env.APPDATA, 'npm', 'codex.ps1')
    ]
    for (const c of candidates) if (existsSync(c)) return c
  }
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (home) {
    const local = join(home, '.local', 'bin', 'codex')
    if (existsSync(local)) return local
  }
  return 'codex'
}

interface CliEvent {
  type: string
  item?: { type?: string; text?: string }
  error?: string
  /** Codex token counts. Field names track OpenAI completions API:
   *  prompt_tokens (input), completion_tokens (output), cache hits as
   *  prompt_tokens_details.cached_tokens. May arrive on turn.completed
   *  or on dedicated token_count events. */
  usage?: {
    input_tokens?: number
    output_tokens?: number
    prompt_tokens?: number
    completion_tokens?: number
    cached_input_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  token_usage?: {
    input_tokens?: number
    output_tokens?: number
    cached_input_tokens?: number
  }
}

export function createCodexCliProvider(opts: CodexCliOptions = {}): ChatProvider {
  const binary = opts.binary ?? findBinary()
  const cwd = opts.cwd ?? process.cwd()

  return {
    id: 'codex-cli',
    name: 'Codex',
    models: CODEX_CLI_MODELS,

    async *send(messages: ChatMessage[], _tools: ToolDefinition[], _results?: ToolResult[]): AsyncIterable<ChatEvent> {
      let payload: string
      try {
        payload = await buildCliPrompt({
          providerId: 'codex-cli',
          projectPath: cwd ?? null,
          messages,
          projectSystemPrompt: opts.projectSystemPrompt,
          skillPrompt: opts.skillPrompt,
          memories: opts.memories,
          agentMode: opts.agentMode
        })
      } catch (err) {
        yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
        return
      }

      // --skip-git-repo-check: разрешает работу вне доверенной git-директории.
      // Без этого Codex CLI exit 1 с "Not inside a trusted directory".
      const args = ['exec', '--json', '--skip-git-repo-check', ...sandboxArgsForMode(opts.agentMode)]
      if (opts.model && opts.model !== 'auto') {
        args.push('-m', opts.model)
      }
      const child = spawn(binary, args, {
        cwd,
        shell: binary.endsWith('.cmd') || binary.endsWith('.ps1'),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Мультиаккаунт: изолируем стейт Codex через CODEX_HOME активного аккаунта.
        env: opts.codexHome ? { ...process.env, CODEX_HOME: opts.codexHome } : process.env
      })

      try {
        child.stdin.write(payload)
        child.stdin.end()
      } catch (err) {
        yield { type: 'error', message: `Codex CLI stdin error: ${err instanceof Error ? err.message : String(err)}` }
        treeKill(child)
        return
      }

      let abortListener: (() => void) | null = null
      if (opts.signal) {
        abortListener = () => { treeKill(child) }
        opts.signal.addEventListener('abort', abortListener, { once: true })
      }

      let stdoutBuffer = ''
      let stderrBuffer = ''
      const queue: ChatEvent[] = []
      let done = false
      let resolve: (() => void) | null = null
      const wake = () => { if (resolve) { const r = resolve; resolve = null; r() } }
      // Был ли эмитнут хоть один agent_message с текстом за этот прогон. Если нет
      // — на завершении турна отдаём reasoning как запасной ответ (см. ниже).
      let emittedAgentText = false
      // Последний reasoning-item турна. Codex на повторных ходах / reasoning-
      // моделях иногда завершает турн БЕЗ финального agent_message — ответ висит
      // только в reasoning. Раньше это давало пустой ответ в чате при пришедшем
      // уведомлении («пуш есть, текста нет»). Держим как fallback.
      let lastReasoning = ''
      // Гарантия единственного done: turn.completed И close могут оба сработать.
      let doneEmitted = false
      function pushDone() {
        if (doneEmitted) return
        doneEmitted = true
        queue.push({ type: 'done' })
      }
      // Если за весь турн не было agent_message — выкидываем reasoning как ответ,
      // чтобы пользователь не остался с пустым пузырём. Вызывается перед done.
      function flushReasoningFallback() {
        if (!emittedAgentText && lastReasoning.trim()) {
          queue.push({ type: 'text', text: lastReasoning.trim() })
          emittedAgentText = true
        }
      }

      function processLine(line: string) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) return
        let ev: CliEvent
        try { ev = JSON.parse(trimmed) } catch { return }

        if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) {
          emittedAgentText = true
          queue.push({ type: 'text', text: ev.item.text })
          wake()
        } else if (ev.type === 'item.completed' && ev.item?.type === 'reasoning' && ev.item.text) {
          // Не стримим reasoning сразу — он может быть промежуточным. Запоминаем
          // последний; используем как ответ только если финального agent_message
          // так и не пришло (flushReasoningFallback на завершении турна).
          lastReasoning = ev.item.text
        } else if (ev.type === 'turn.completed') {
          // turn.completed carries final token usage in some Codex versions.
          // Field names vary: `usage.{input,output,cached_input}_tokens` OR
          // `usage.{prompt,completion}_tokens` OR `token_usage.*`. Accept all.
          const u = ev.usage ?? ev.token_usage
          if (u) {
            const input = u.input_tokens ?? (u as { prompt_tokens?: number }).prompt_tokens
            const output = u.output_tokens ?? (u as { completion_tokens?: number }).completion_tokens
            const cached = u.cached_input_tokens ?? (u as { prompt_tokens_details?: { cached_tokens?: number } }).prompt_tokens_details?.cached_tokens
            if ((input ?? 0) > 0 || (output ?? 0) > 0) {
              queue.push({
                type: 'usage',
                usage: { inputTokens: input, outputTokens: output, cachedInputTokens: cached, model: opts.model ?? 'codex-cli' }
              })
            }
          }
          flushReasoningFallback()
          pushDone()
          wake()
        } else if (ev.type === 'error') {
          queue.push({ type: 'error', message: ev.error ?? 'Codex CLI вернул error' })
          wake()
        }
      }

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk
        let idx
        while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, idx)
          stdoutBuffer = stdoutBuffer.slice(idx + 1)
          processLine(line)
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => { stderrBuffer += chunk })

      child.on('error', (err) => {
        queue.push({ type: 'error', message: `Запуск Codex CLI не удался: ${err.message}` })
        done = true; wake()
      })
      child.on('close', (code) => {
        if (stdoutBuffer.length > 0) processLine(stdoutBuffer)
        if (code !== 0 && !doneEmitted && !queue.some(e => e.type === 'done' || e.type === 'error')) {
          queue.push({ type: 'error', message: `Codex CLI exit ${code}. ${stderrBuffer.slice(0, 400)}` })
        } else if (!doneEmitted && !queue.some(e => e.type === 'error')) {
          // Чистый выход без turn.completed (некоторые версии codex закрываются
          // сразу после agent_message). Отдаём reasoning-fallback если ответа не
          // было и завершаем стрим done — иначе провайдер «зависал» без терминала.
          flushReasoningFallback()
          pushDone()
        }
        done = true; wake()
      })

      try {
        while (!done || queue.length > 0) {
          if (queue.length === 0) {
            await new Promise<void>(r => { resolve = r })
            continue
          }
          const ev = queue.shift()!
          yield ev
          if (ev.type === 'done' || ev.type === 'error') {
            treeKill(child)
            return
          }
        }
      } finally {
        if (opts.signal && abortListener) {
          try { opts.signal.removeEventListener('abort', abortListener) } catch { /* noop */ }
        }
      }
    }
  }
}
