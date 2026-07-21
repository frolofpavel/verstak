/**
 * Autonomous improvement loop — фоновый цикл который без участия пользователя
 * читает журнал + project map проекта, отправляет AI задачу "предложи 3
 * улучшения", парсит ответ и пишет предложения в journal как 'note' entries.
 *
 * Безопасный режим: только генерация идей, БЕЗ автоматического write_file /
 * run_command. Пользователь утром открывает Journal, видит N предложений
 * с обоснованием из истории работы и решает что брать в работу.
 *
 * Зачем: дать пользователю готовые предложения по улучшению проекта без
 * ручного запроса — прямая реализация continuous improvement loop.
 */

import { ipcMain } from 'electron'
import { createProvider, PROVIDERS, type ProviderId } from '../ai/registry'
import { prepareSystemContext } from '../ai/compose-system'
import { systemForProvider } from '../ai/compose-prompt'
import type { ChatMessage } from '../ai/types'
import type { ResolvedSubscription } from '../ai/resolve-subscription-account'

export interface AutonomousDeps {
  getSecret: (key: string) => string | null
  getProviderId: () => ProviderId
  getProviderModel: (id: ProviderId) => string | null
  recordJournal: (projectPath: string, kind: 'tool' | 'session' | 'note', title: string, detail?: string | null) => void
  readJournal: (projectPath: string, limit: number) => Array<{ kind: string; title: string; detail: string | null; createdAt: number }>
  recentWrites: (projectPath: string, limit: number) => Array<{ filePath: string; createdAt: number }>
  /** Currently-active project path. The loop only operates on this. */
  getActiveProject: () => string | null
  /** EF-R1 Б2: единый резолвер подписочного аккаунта (как в ai:send/scheduled). */
  resolveSubscriptionAccount?: (providerId: string, chatId?: number) => ResolvedSubscription | null
}

export interface AutonomousStatus {
  enabled: boolean
  intervalMin: number
  lastRunAt: number | null
  lastRunSuggestions: number
  lastRunError: string | null
  nextRunAt: number | null
}

const PROMPT = `Я работаю autonomous-циклом улучшения проекта. Без вмешательства пользователя.

ЗАДАЧА:
1. Прочитай 50 последних записей моего журнала (kind="session" + "note" + "tool").
2. Прочитай project_map.
3. Найди 3 КОНКРЕТНЫХ улучшения которые имеют смысл прямо сейчас. Каждое:
   - где (file:line если применимо)
   - что (одна-две строки)
   - почему (привязка к конкретной записи в журнале или паттерну в коде)
   - размер (small / medium / large)

ВЫВЕДИ СТРОГО в формате (без markdown, без преамбулы):

SUGGESTION 1:
WHERE: <file:line или зона>
WHAT: <что сделать>
WHY: <обоснование из журнала или кода>
SIZE: <small|medium|large>

SUGGESTION 2:
...

SUGGESTION 3:
...

OUT_OF_SCOPE — пропускай: общие best practices, рефакторинги ради красоты, переименования, добавления "feature parity" без обоснования.`

interface ParsedSuggestion {
  where: string
  what: string
  why: string
  size: string
}

function parseSuggestions(text: string): ParsedSuggestion[] {
  const out: ParsedSuggestion[] = []
  // Split by SUGGESTION N: header
  const blocks = text.split(/SUGGESTION\s+\d+\s*:/i).slice(1)
  for (const block of blocks) {
    const where = /WHERE\s*:\s*([^\n]+)/i.exec(block)?.[1]?.trim() ?? ''
    const what = /WHAT\s*:\s*([^\n]+)/i.exec(block)?.[1]?.trim() ?? ''
    const why = /WHY\s*:\s*([^\n]+)/i.exec(block)?.[1]?.trim() ?? ''
    const size = /SIZE\s*:\s*([^\n]+)/i.exec(block)?.[1]?.trim() ?? ''
    if (where || what) out.push({ where, what, why, size })
  }
  return out
}

let timer: NodeJS.Timeout | null = null
let status: AutonomousStatus = {
  enabled: false,
  intervalMin: 30,
  lastRunAt: null,
  lastRunSuggestions: 0,
  lastRunError: null,
  nextRunAt: null
}

async function runCycle(deps: AutonomousDeps): Promise<void> {
  const projectPath = deps.getActiveProject()
  if (!projectPath) {
    status.lastRunError = 'No active project'
    return
  }
  const providerId = deps.getProviderId()
  const descriptor = PROVIDERS[providerId]
  if (descriptor.transport !== 'API' || !descriptor.secretKey) {
    status.lastRunError = `Provider ${providerId} not usable for autonomous run (need API + key)`
    return
  }
  const apiKey = deps.getSecret(descriptor.secretKey)
  if (!apiKey) {
    status.lastRunError = `No API key for ${providerId}`
    return
  }
  // EF-R1 Б2: autonomous проходит тот же единый resolver, что и ai:send/scheduled.
  // Заблокированный/отсутствующий аккаунт → человеческий стоп ДО сети; молчаливый
  // default credential (~/.codex) запрещён. Парка нет (null) → прежний путь.
  const sub = deps.resolveSubscriptionAccount?.(providerId) ?? null
  if (sub && 'unavailable' in sub) {
    status.lastRunError = 'Закреплённый аккаунт провайдера удалён — автономный прогон отменён'
    return
  }
  if (sub && 'blocked' in sub) {
    status.lastRunError = sub.reason === 'cooling'
      ? `Аккаунт «${sub.label}» остывает после лимита — автономный прогон отменён`
      : `Аккаунт «${sub.label}» требует входа — автономный прогон отменён`
    return
  }
  if (sub && 'allBlocked' in sub) {
    status.lastRunError = sub.reason === 'cooling'
      ? `Все аккаунты провайдера (${sub.count}) остывают — автономный прогон отменён`
      : `Все аккаунты провайдера (${sub.count}) требуют входа — автономный прогон отменён`
    return
  }
  const codexHome = sub && 'configDir' in sub ? (sub.configDir || null) : null

  const model = deps.getProviderModel(providerId) ?? descriptor.defaultModel
  const ctrl = new AbortController()
  try {
    const provider = createProvider(providerId, { apiKey, model, cwd: projectPath, signal: ctrl.signal, codexHome })
    const messages: ChatMessage[] = [{ role: 'user', content: PROMPT }]
    // Wrap with system + context pack just like a normal ai:send
    const composed = await prepareSystemContext({
      projectPath,
      messages,
      recentWrites: deps.recentWrites(projectPath, 8)
    })
    const messagesWithSystem: ChatMessage[] = [
      // systemForProvider: снять кэш-маркер для не-claude (паритет с ai.ts:323/573),
      // иначе '<<VERSTAK_CACHE_BP>>' протекал бы литералом в system prompt (ревью LOW).
      { role: 'system', content: systemForProvider(composed.system, providerId) },
      ...messages
    ]

    let full = ''
    let runError: string | null = null
    // Run WITHOUT tools — we want plain text suggestions, not actual file edits
    for await (const event of provider.send(messagesWithSystem, [], undefined, ctrl.signal)) {
      if (event.type === 'text') full += event.text
      else if (event.type === 'error') {
        runError = 'message' in event ? String((event as { message: unknown }).message) : 'unknown error'
        break
      } else if (event.type === 'done') {
        break
      }
    }
    if (runError) {
      status.lastRunError = runError
      return
    }

    const suggestions = parseSuggestions(full)
    if (suggestions.length === 0) {
      status.lastRunError = 'Model produced no parseable suggestions'
      deps.recordJournal(projectPath, 'note', '🌙 Autonomous: ответ без предложений',
        full.slice(0, 600))
      return
    }

    // Write each suggestion as a journal note so user sees them in the morning
    deps.recordJournal(projectPath, 'note',
      `🌙 Autonomous: ${suggestions.length} предложений`,
      suggestions.map((s, i) =>
        `[${i + 1}] ${s.what}\n   где: ${s.where}\n   почему: ${s.why}\n   размер: ${s.size}`
      ).join('\n\n')
    )

    status.lastRunSuggestions = suggestions.length
    status.lastRunError = null
  } catch (err) {
    status.lastRunError = err instanceof Error ? err.message : String(err)
  } finally {
    status.lastRunAt = Date.now()
    if (status.enabled) status.nextRunAt = Date.now() + status.intervalMin * 60_000
  }
}

export function registerAutonomousIpc(deps: AutonomousDeps): void {
  ipcMain.handle('autonomous:status', () => status)

  ipcMain.handle('autonomous:run-once', async () => {
    await runCycle(deps)
    return status
  })

  ipcMain.handle('autonomous:start', (_e, intervalMin: number) => {
    if (timer) clearInterval(timer)
    status.enabled = true
    status.intervalMin = Math.max(5, Math.min(240, Math.floor(intervalMin) || 30))
    status.nextRunAt = Date.now() + status.intervalMin * 60_000
    timer = setInterval(() => { void runCycle(deps) }, status.intervalMin * 60_000)
    // Also fire one immediately so user sees it works
    void runCycle(deps)
    return status
  })

  ipcMain.handle('autonomous:stop', () => {
    if (timer) clearInterval(timer)
    timer = null
    status.enabled = false
    status.nextRunAt = null
    return status
  })
}
