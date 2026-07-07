import { spawn } from 'child_process'
import { platform } from 'os'
import { existsSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import type { ChatProvider, ChatMessage, ChatEvent, ToolDefinition, ToolResult } from './types'
import { buildCliPrompt } from './cli-prompt'
import { describeAttachments } from './history-serializer'
import { treeKill } from './child-kill'
import type { AgentMode } from './mode-policy'
import { logRuntime } from '../runtime-log'

/**
 * Grok-4 / Grok Build (xAI) в режиме `streaming-json` стримит ВСЁ как обычный
 * text — включая свои внутренние рассуждения. Типичный сырой вывод:
 *
 *   The user said "Привет", which is Russian for "Hello".
 *   <answer>Привет! Чем могу помочь?</answer>
 *   Explanation
 *   The response begins with a standard Russian-language greeting...
 *   \confidence{75}
 *
 * Это его "Heavy"-режим (multi-agent + judge с confidence-метрикой), и
 * отдельного канала для reasoning нет — всё в одном text-стриме. Парсим на
 * нашей стороне: выделяем чистый ответ → text, всё остальное → thought
 * (свёрнутая плашка 💭 в UI).
 *
 * Стратегия:
 *  1. Если есть <answer>...</answer> — берём содержимое тега.
 *  2. Иначе режем на параграфы, отбрасываем ведущие "почти английские"
 *     (cyrRatio < 0.3) — это reasoning преамбулы; всё с первого русского
 *     параграфа считаем ответом.
 *  3. Маркеры \confidence{N} и заголовки Explanation/Reasoning/Analysis
 *     убираем из ответа в reasoning.
 */
export function cleanGrokOutput(raw: string): { answer: string; reasoning: string } {
  const reasoningParts: string[] = []
  let work = raw

  // 1) <answer>...</answer> — приоритетный путь
  const answerMatches = [...work.matchAll(/<answer>([\s\S]*?)<\/answer>/gi)]
  if (answerMatches.length > 0) {
    const inner = answerMatches.map(m => m[1].trim()).filter(Boolean).join('\n\n')
    const rest = work.replace(/<answer>[\s\S]*?<\/answer>/gi, '').trim()
    if (rest) reasoningParts.push(rest)
    return { answer: inner, reasoning: reasoningParts.join('\n\n').trim() }
  }

  // 2) Убираем \confidence{N} (сохраняем в reasoning для прозрачности)
  work = work.replace(/\\confidence\{(\d+)\}/g, (_m, n) => {
    reasoningParts.push(`confidence: ${n}`)
    return ''
  })

  // 3) Разбиваем на параграфы, отбрасываем ведущие английские
  const cyrRatio = (s: string): number => {
    const letters = s.replace(/[^A-Za-zА-Яа-яЁё]/g, '')
    if (letters.length === 0) return 1 // не текст (код / цифры) — считаем «нейтральным», не выкидываем
    const cyr = (s.match(/[А-Яа-яЁё]/g) ?? []).length
    return cyr / letters.length
  }

  // Типичные английские reasoning-префиксы Grok'а. cyrRatio фейлится когда
  // он цитирует русские слова в кавычках («The user said "Привет"…») — там
  // 5-6 кириллических букв вытягивают ratio выше 0.15. Префиксы надёжнее.
  const REASONING_PREFIX = /^(The user |The response |The instruction|The format |The system |The directory |Why ["']|Since ["']|Since "|If |First[,.:]|Final answer|Confidence:|Context preservation|I need to|I should|Let me |Note:|Standard Electron|Only two chats|There are previous|Available tools|Looking at|Пользователь |Ответ пользователя|Инструкция|Формат |Система |Директория |Почему |Поскольку |Если |Сначала[,.:]|Итоговый ответ|Уверенность:|Сохранение контекста|Мне нужно|Я должен|Позвольте|Заметка:|Доступные инструменты|Смотрю на|Нужно (проверить|понять|сначала|разобрать))/i

  const paragraphs = work.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
  const answerPars: string[] = []
  let inAnswer = false
  for (const p of paragraphs) {
    // Заголовки-маркеры reasoning блоков. После них Grok часто продолжает
    // английский анализ — сбрасываем inAnswer чтобы следующие английские
    // параграфы тоже ушли в reasoning.
    if (/^(Explanation|Reasoning|Analysis|Thinking|Note|Confidence|Объяснение|Рассуждение|Анализ|Размышление|Заметка|Уверенность):?$/i.test(p)) {
      reasoningParts.push(p)
      inAnswer = false
      continue
    }
    // Reasoning-префикс — всегда reasoning (даже если параграф содержит
    // русские слова в цитатах).
    if (REASONING_PREFIX.test(p)) {
      reasoningParts.push(p)
      inAnswer = false
      continue
    }
    // Порог 0.15: чистый английский reasoning ≈ 0 кириллицы; русский ответ
    // с code-снипетами / URL / file paths остаётся выше (тест «Я Grok через
    // electron/ai/grok.ts» = 0.29). Применяем независимо от inAnswer —
    // английский «хвост» после русского ответа тоже выкидываем.
    if (cyrRatio(p) < 0.15) {
      reasoningParts.push(p)
      continue
    }
    inAnswer = true
    answerPars.push(p)
  }

  return {
    answer: answerPars.join('\n\n').trim(),
    reasoning: reasoningParts.join('\n\n').trim()
  }
}

interface GrokCliOptions {
  binary?: string
  cwd?: string
  signal?: AbortSignal
  model?: string
  projectSystemPrompt?: string | null
  /** Промпт активного скилла — наслаивается секцией <skill_layer> в buildCliPrompt. */
  skillPrompt?: string | null
  memories?: Array<{ type: string; content: string; tags: string[] }>
  agentMode?: AgentMode
}

export const GROK_CLI_MODELS = [
  'grok-composer-2.5-fast',
  'grok-build'
]

export const DEFAULT_GROK_CLI_MODEL = 'grok-composer-2.5-fast'

const GROK_COMPOSER_MODEL = 'grok-composer-2.5-fast'
const NO_VISIBLE_ANSWER_MESSAGE =
  'Grok CLI завершил ответ без видимого текста. Попробуй повторить запрос или переключи чат на Grok API.'

function stripAnsi(input: string): string {
  return input
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
}

function normalizePlainGrokOutput(raw: string): string {
  return stripAnsi(raw)
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim()
}

async function* runGrokComposerPlain(opts: {
  binary: string
  cwd: string
  payload: string
  model: string
  signal?: AbortSignal
}): AsyncIterable<ChatEvent> {
  const args = [
    '--output-format', 'plain',
    '--no-alt-screen',
    '--no-plan',
    '--no-subagents',
    '--no-wait-for-background',
    '--verbatim',
    '-m', opts.model
  ]
  const ARGV_CAP = 8000
  let promptFile: string | null = null
  if (opts.payload.length > ARGV_CAP) {
    promptFile = join(tmpdir(), `grok-composer-prompt-${randomUUID()}.txt`)
    writeFileSync(promptFile, opts.payload, 'utf8')
    args.push('--prompt-file', promptFile)
  } else {
    args.push('-p', opts.payload)
  }

  const child = spawn(opts.binary, args, {
    cwd: opts.cwd,
    shell: opts.binary.endsWith('.cmd') || opts.binary.endsWith('.ps1'),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  try { child.stdin.end() } catch { /* noop */ }

  let stdoutBuffer = ''
  let stderrBuffer = ''
  let closeCode: number | null = null
  let closed = false
  let wake: (() => void) | null = null
  let abortListener: (() => void) | null = null

  if (opts.signal) {
    abortListener = () => { treeKill(child) }
    opts.signal.addEventListener('abort', abortListener, { once: true })
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { stdoutBuffer += chunk })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderrBuffer += chunk })
  child.on('error', (err) => {
    stderrBuffer += `\n${err.message}`
    closed = true
    if (wake) { const r = wake; wake = null; r() }
  })
  child.on('close', (code) => {
    closeCode = code
    closed = true
    if (promptFile) {
      try { unlinkSync(promptFile) } catch { /* noop */ }
    }
    if (wake) { const r = wake; wake = null; r() }
  })

  try {
    while (!closed) await new Promise<void>(r => { wake = r })

    const answer = normalizePlainGrokOutput(stdoutBuffer)
    logRuntime('grok-cli.composer-plain.complete', {
      model: opts.model,
      code: closeCode,
      stdoutChars: stdoutBuffer.length,
      stderrChars: stderrBuffer.length
    }, closeCode === 0 ? 'info' : 'warn')

    if (closeCode !== 0) {
      yield { type: 'error', message: normalizeGrokCliError(stderrBuffer || `Grok CLI exit ${closeCode}`) }
      return
    }
    if (!answer) {
      logRuntime('grok-cli.no-visible-answer', {
        model: opts.model,
        reason: 'composer-plain-empty',
        code: closeCode,
        stderr: stderrBuffer.slice(0, 1000)
      }, 'warn')
      yield { type: 'error', message: NO_VISIBLE_ANSWER_MESSAGE }
      return
    }

    yield { type: 'text', text: answer }
    yield { type: 'done' }
  } finally {
    if (promptFile) {
      try { unlinkSync(promptFile) } catch { /* noop */ }
    }
    if (opts.signal && abortListener) {
      try { opts.signal.removeEventListener('abort', abortListener) } catch { /* noop */ }
    }
  }
}

function findBinary(): string {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  if (home) {
    const candidates = [
      join(home, '.grok', 'bin', 'grok'),
      join(home, '.grok', 'bin', 'grok.exe'),
      join(home, '.local', 'bin', 'grok')
    ]
    for (const c of candidates) if (existsSync(c)) return c
  }
  if (platform() === 'win32' && process.env.APPDATA) {
    const cand = join(process.env.APPDATA, 'npm', 'grok.cmd')
    if (existsSync(cand)) return cand
  }
  return 'grok'
}

interface CliEvent {
  type: string
  data?: string
  text?: string
  content?: string
  message?: string | { content?: string }
  /** For tool_call events */
  name?: string
  args?: Record<string, unknown>
  arguments?: Record<string, unknown>
  /** Error payload */
  error?: string
}

function eventText(ev: CliEvent): string | undefined {
  if (typeof ev.message === 'string') return ev.message
  return ev.error ?? ev.data ?? ev.text ?? ev.content ?? ev.message?.content
}

function normalizeGrokCliError(raw: string): string {
  let text = raw.trim()
  try {
    const parsed = JSON.parse(text) as { message?: string }
    if (typeof parsed.message === 'string') text = parsed.message
  } catch {
    /* raw is already plain text */
  }

  const subscriptionDenied =
    /403\s+Forbidden/i.test(text) ||
    /permission-denied/i.test(text) ||
    /requires a Grok subscription/i.test(text)

  if (subscriptionDenied) {
    const model = text.match(/model ['"`]([^'"`]+)['"`]/i)?.[1]
    return [
      `Grok CLI не может выполнить запрос${model ? ` через модель ${model}` : ''}: аккаунту нужна активная Grok/SuperGrok подписка для CLI.`,
      'grok.exe найден и логин есть, но сервер xAI возвращает 403 Forbidden.',
      'Проверь подписку в grok.com или переключи чат на Grok API с ключом из xAI Console.'
    ].join('\n')
  }

  return `Grok CLI error: ${text}`
}

export function createGrokCliProvider(opts: GrokCliOptions = {}): ChatProvider {
  const binary = opts.binary ?? findBinary()
  const cwd = opts.cwd ?? process.cwd()

  return {
    id: 'grok-cli',
    name: 'Grok Build',
    models: GROK_CLI_MODELS,

    async *send(messages: ChatMessage[], _tools: ToolDefinition[], _results?: ToolResult[]): AsyncIterable<ChatEvent> {
      // GROK CLI is unstable with large prompts AND with stdin through .cmd
      // shell wrappers — exit 0xC0000005 ACCESS_VIOLATION reported on both.
      // For grok specifically we fall back to MINIMAL payload (just the user
      // message, no system layer, no context pack) and use stdin without
      // shell when binary is a direct .exe / unix executable.
      const lastUser = messages.filter(m => m.role === 'user').at(-1)
      if (!lastUser?.content) {
        yield { type: 'error', message: 'Нет user-сообщения для отправки' }
        return
      }
      // Переключаем на FULL payload.
      // Если grok CLI упадёт с ACCESS_VIOLATION (Windows 0xC0000005 / 3221225477)
      // — поймаем в child.on('close') ниже и вернём user-friendly ошибку с
      // предложением переключиться на Grok API. Лучше пробовать, чем мириться
      // с обрезанным контекстом без системных правил.
      const minimalMode = false
      let payload: string
      if (minimalMode) {
        payload = lastUser.content
        const attachNote = describeAttachments(lastUser.attachments, 'inline')
        if (attachNote) payload += '\n\n' + attachNote
      } else {
        try {
          payload = await buildCliPrompt({
            providerId: 'grok-cli',
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
      }

      const requestedModel = opts.model && opts.model !== 'auto' ? opts.model : DEFAULT_GROK_CLI_MODEL
      const selectedModel = GROK_CLI_MODELS.includes(requestedModel)
        ? requestedModel
        : DEFAULT_GROK_CLI_MODEL
      if (selectedModel === GROK_COMPOSER_MODEL) {
        yield* runGrokComposerPlain({ binary, cwd, payload, model: selectedModel, signal: opts.signal })
        return
      }

      const args = ['--output-format', 'streaming-json', '--no-alt-screen']
      args.push('-m', selectedModel)
      // Back to -p argv (this is what worked before parity changes). stdin
      // through cmd.exe wrapper on Windows turned out to be even more unstable.
      // Soft cap to 8KB so we never trip CreateProcess limits or grok's own
      // internal buffers.
      const ARGV_CAP = 8000
      let promptFile: string | null = null
      if (payload.length > ARGV_CAP) {
        // Never slice(0, cap) — that drops <current_user_request> at the tail.
        promptFile = join(tmpdir(), `grok-desktop-prompt-${randomUUID()}.txt`)
        writeFileSync(promptFile, payload, 'utf8')
        args.push('--prompt-file', promptFile)
      } else {
        args.push('-p', payload)
      }

      const child = spawn(binary, args, {
        cwd,
        shell: binary.endsWith('.cmd') || binary.endsWith('.ps1'),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })

      try { child.stdin.end() } catch { /* noop */ }

      let abortListener: (() => void) | null = null
      if (opts.signal) {
        abortListener = () => { treeKill(child) }
        opts.signal.addEventListener('abort', abortListener, { once: true })
      }

      let stdoutBuffer = ''
      let stderrBuffer = ''
      let textBuffer = ''   // полный сырой text-стрим Grok'а; чистим в самом конце
      let thoughtChars = 0
      let textEvents = 0
      let thoughtEvents = 0
      let completionEvents = 0
      const queue: ChatEvent[] = []
      let done = false
      let finalQueued = false
      let resolve: (() => void) | null = null
      const wake = () => { if (resolve) { const r = resolve; resolve = null; r() } }

      function queueFinalFromBuffer(): boolean {
        if (finalQueued) return true
        const { answer, reasoning } = cleanGrokOutput(textBuffer)
        if (answer) {
          if (reasoning) queue.push({ type: 'thought', text: reasoning })
          queue.push({ type: 'text', text: answer })
        } else if (!reasoning && textBuffer.trim()) {
          queue.push({ type: 'text', text: textBuffer.trim() })
        } else {
          logRuntime('grok-cli.no-visible-answer', {
            model: selectedModel,
            reason: 'queue-final-empty',
            textChars: textBuffer.length,
            thoughtChars,
            textEvents,
            thoughtEvents,
            completionEvents,
            stderr: stderrBuffer.slice(0, 1000)
          }, 'warn')
          queue.push({
            type: 'error',
            message: NO_VISIBLE_ANSWER_MESSAGE
          })
          finalQueued = true
          textBuffer = ''
          done = true
          wake()
          return false
        }
        finalQueued = true
        textBuffer = ''
        queue.push({ type: 'done' })
        done = true
        wake()
        return true
      }

      function processLine(line: string) {
        const trimmed = line.trim()
        if (finalQueued) return
        if (!trimmed.startsWith('{')) return
        let ev: CliEvent
        try { ev = JSON.parse(trimmed) } catch { return }

        // type='thought' (если CLI вдруг эмитит явно) сразу в thought-канал.
        if (ev.type === 'thought') {
          const text = eventText(ev)
          if (text) {
            thoughtEvents += 1
            thoughtChars += text.length
          }
        }
        // Любой text-event — буферизуем, НЕ стримим. Grok всегда мешает
        // reasoning с ответом, поэтому чистим в самом конце через
        // cleanGrokOutput() и эмитим один раз: сначала thought, потом text.
        // Trade-off: теряем токен-by-токен стриминг для Grok, но получаем
        // чистый ответ. Для типичных Grok-ответов (1-3 параграфа) задержка
        // незаметна — он быстрый.
        else if (ev.type === 'text' || ev.type === 'assistant_message_delta' || ev.type === 'message_delta') {
          const text = eventText(ev)
          if (text) {
            textEvents += 1
            textBuffer += text
            if (/<answer>[\s\S]*?<\/answer>/i.test(textBuffer)) {
              queueFinalFromBuffer()
            }
          }
        }
        // Completion event — здесь разбираем буфер и эмитим
        else if (ev.type === 'turn_complete' || ev.type === 'done' || ev.type === 'message_complete' || ev.type === 'final') {
          completionEvents += 1
          const { answer, reasoning } = cleanGrokOutput(textBuffer)
          const rawVisible = !reasoning && textBuffer.trim() ? textBuffer.trim() : ''
          if (answer || rawVisible) {
            if (reasoning) queue.push({ type: 'thought', text: reasoning })
            queue.push({ type: 'text', text: answer || rawVisible })
          } else {
            // Защита: если парсер ничего не выделил, но текст был — отдаём как есть
            logRuntime('grok-cli.no-visible-answer', {
              model: selectedModel,
              reason: 'completion-empty',
              eventType: ev.type,
              textChars: textBuffer.length,
              thoughtChars,
              textEvents,
              thoughtEvents,
              completionEvents,
              stderr: stderrBuffer.slice(0, 1000)
            }, 'warn')
            queue.push({
              type: 'error',
              message: NO_VISIBLE_ANSWER_MESSAGE
            })
          }
          queue.push({ type: 'done' }); wake()
        }
        // Error event
        else if (ev.type === 'error' || ev.type === 'fatal') {
          const detail = eventText(ev)
          queue.push({
            type: 'error',
            message: detail ? normalizeGrokCliError(detail) : normalizeGrokCliError(JSON.stringify(ev).slice(0, 1000))
          })
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
        if (promptFile) {
          try { unlinkSync(promptFile) } catch { /* noop */ }
        }
        queue.push({ type: 'error', message: `Запуск Grok CLI не удался: ${err.message}` })
        done = true; wake()
      })
      child.on('close', (code) => {
        if (promptFile) {
          try { unlinkSync(promptFile) } catch { /* noop */ }
        }
        if (stdoutBuffer.length > 0) processLine(stdoutBuffer)
        // Если CLI закрылся БЕЗ turn_complete event'а (некоторые версии grok
        // так делают), но в буфере есть текст — флашим вручную.
        if (textBuffer.length > 0 && !queue.some(e => e.type === 'text' || e.type === 'done')) {
          const { answer, reasoning } = cleanGrokOutput(textBuffer)
          const rawVisible = !reasoning && textBuffer.trim() ? textBuffer.trim() : ''
          if (answer || rawVisible) {
            if (reasoning) queue.push({ type: 'thought', text: reasoning })
            queue.push({ type: 'text', text: answer || rawVisible })
          }
          textBuffer = ''
        }
        if (code === 0 && textBuffer.length === 0 && !queue.some(e => e.type === 'text' || e.type === 'done' || e.type === 'error')) {
          logRuntime('grok-cli.no-visible-answer', {
            model: selectedModel,
            reason: 'close-empty',
            code,
            thoughtChars,
            textEvents,
            thoughtEvents,
            completionEvents,
            stderr: stderrBuffer.slice(0, 1000)
          }, 'warn')
          queue.push({
            type: 'error',
            message: NO_VISIBLE_ANSWER_MESSAGE
          })
        }
        if (code !== 0 && !queue.some(e => e.type === 'done')) {
          // 0xC0000005 (3221225477) = Windows STATUS_ACCESS_VIOLATION.
          // Также 0xC0000409 (3221226505) = STACK_BUFFER_OVERRUN, и любой
          // другой 0xC000... код — нативный краш CLI на больших промптах
          // или unicode-кейсах. Сообщение: явно и понятно,
          // не молчим, не зависаем — предлагаем единственный воркэраунд.
          const isNativeCrash =
            code === 3221225477 || code === -1073741819 || // 0xC0000005
            code === 3221226505 || code === -1073740791 || // 0xC0000409
            (typeof code === 'number' && code !== null && (code >>> 0) >= 0xC0000000)
          if (isNativeCrash) {
            queue.push({
              type: 'error',
              message:
                'Grok CLI нестабилен на этой машине (нативный краш ' +
                `exit 0x${((code ?? 0) >>> 0).toString(16).toUpperCase()}). ` +
                'Используйте Grok API вместо CLI: открой Settings → Провайдеры → Grok (API) → ' +
                'добавь ключ от console.x.ai. Альтернативно — обнови grok CLI ' +
                'с сайта xAI, иногда помогает.' +
                (stderrBuffer ? '\n\nstderr: ' + stderrBuffer.slice(0, 400) : '')
            })
          } else {
            queue.push({
              type: 'error',
              message: `Grok CLI exit ${code}.${stderrBuffer ? ' ' + stderrBuffer.slice(0, 400) : ''}`
            })
          }
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
