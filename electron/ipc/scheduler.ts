/**
 * NL-cron планировщик (флагман, часть 3/3). Раз в минуту опрашивает enabled-задачи,
 * запускает headless-прогон для тех, у кого cron совпал с текущей минутой, и пушит
 * итог наружу (Telegram) + в журнал. Только ИСХОДЯЩАЯ автоматизация (ноль inbound).
 *
 * Чистое ядро решения «что запускать» (selectDueTasks) вынесено и тестируемо;
 * сам прогон/таймер/пуш — интеграция.
 */

import { ipcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import type { ProviderId } from '../ai/registry'
import { parseSchedule, cronMatches, type TimeParts } from '../ai/schedule-parse'
import {
  createScheduledTask, listScheduledTasks, listEnabledScheduledTasks,
  setScheduledTaskEnabled, deleteScheduledTask, recordScheduledRun, getScheduledTask,
  recordSchedulerHeartbeat, getSchedulerHeartbeat, markScheduledTaskClaimed,
  type ScheduledTask,
} from '../storage/scheduled-tasks'
import { createTelegramConnector } from '../connectors/telegram'
import { isWithinKnownRoots } from '../ai/path-policy'
import { scanText } from '../ai/secret-scanner'

export interface SchedulerDeps {
  getSecret: (key: string) => string | null
  getProviderId: () => ProviderId
  getProviderModel: (id: ProviderId) => string | null
  getKnownRoots: () => string[]
  recordJournal: (projectPath: string, kind: 'tool' | 'session' | 'note', title: string, detail?: string | null) => void
  runHeadless: (opts: { projectPath: string; prompt: string; providerId: ProviderId; model: string | null; signal: AbortSignal }) => Promise<{ ok: boolean; text: string; error?: string }>
}

// In-flight guard: id выполняющихся задач. last_run_minute пишется ПОСЛЕ прогона (может
// длиться >1 мин), поэтому одного его недостаточно — тик/run-now могли бы запустить ту же
// задачу повторно параллельно (ревью HIGH). Set отсекает уже бегущие.
const running = new Set<number>()
const STALLED_AFTER_MS = 3 * 60_000

export interface SchedulerHealth {
  lastHeartbeatAt: number | null
  heartbeatAgeMs: number | null
  stalled: boolean
}

/**
 * Какие задачи запускать в данную минуту: cron совпал И не запускались уже в эту
 * минуту (last_run_minute !== minuteIdx — анти-двойное срабатывание, в т.ч. после
 * рестарта приложения в ту же минуту). Чистая логика — тестируемо.
 */
export function selectDueTasks(tasks: ScheduledTask[], parts: TimeParts, minuteIdx: number): ScheduledTask[] {
  return tasks.filter(t => t.enabled && t.last_run_minute !== minuteIdx && cronMatches(t.cron, parts))
}

export function schedulerHealth(lastHeartbeatAt: number | null, now = Date.now()): SchedulerHealth {
  const heartbeatAgeMs = lastHeartbeatAt ? Math.max(0, now - lastHeartbeatAt) : null
  return {
    lastHeartbeatAt,
    heartbeatAgeMs,
    stalled: heartbeatAgeMs != null && heartbeatAgeMs > STALLED_AFTER_MS,
  }
}

const LIFECYCLE_GUARD_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(verstak\s+(stop|restart|shutdown)|(stop|restart|shutdown)\s+verstak)\b/i, reason: 'Команда управляет жизненным циклом Verstak.' },
  { pattern: /\b(shutdown|poweroff|reboot)\b/i, reason: 'Команда может выключить или перезапустить систему.' },
  { pattern: /\bkill\s+(scheduler|verstak)\b/i, reason: 'Команда может остановить планировщик.' },
  { pattern: /\b(taskkill|pkill|killall)\b/i, reason: 'Команда может завершить процесс приложения.' },
  { pattern: /\bsystemctl\s+(stop|restart|kill)\b/i, reason: 'Команда может остановить системный сервис.' },
]

export function schedulerPromptLifecycleRisk(prompt: string): string | null {
  const text = prompt.trim()
  if (!text) return null
  return LIFECYCLE_GUARD_PATTERNS.find(rule => rule.pattern.test(text))?.reason ?? null
}

function nowParts(d: Date): TimeParts {
  return { minute: d.getMinutes(), hour: d.getHours(), dom: d.getDate(), month: d.getMonth() + 1, dow: d.getDay() }
}

async function pushTelegram(deps: SchedulerDeps, text: string, signal: AbortSignal): Promise<void> {
  try {
    const chatId = deps.getSecret('telegram_notify_chat_id')
    if (!chatId || !deps.getSecret('telegram_bot_token')) return // не настроено → no-op
    await createTelegramConnector().query({ op: 'send_message', chat_id: chatId, text }, { getSecret: deps.getSecret, signal })
  } catch { /* пуш не критичен */ }
}

async function runOne(db: Database, deps: SchedulerDeps, taskId: number, minuteIdx: number): Promise<void> {
  if (running.has(taskId)) return // уже бежит — не дублируем (in-flight guard)
  const task = getScheduledTask(db, taskId)
  if (!task) return
  running.add(taskId)
  const claimedAt = Date.now()
  const claimed = markScheduledTaskClaimed(db, taskId, {
    minute: minuteIdx,
    at: claimedAt,
    nextRunAt: (minuteIdx + 1) * 60_000,
  })
  if (!claimed) {
    running.delete(taskId)
    return
  }
  const providerId = (task.provider_id as ProviderId | null) ?? deps.getProviderId()
  const model = task.model ?? deps.getProviderModel(providerId)
  const ac = new AbortController()
  const timeout = setTimeout(() => ac.abort(), 5 * 60_000) // 5 мин потолок на unattended-прогон
  try {
    const res = await deps.runHeadless({ projectPath: task.project_path, prompt: task.prompt, providerId, model, signal: ac.signal })
    const status: 'ok' | 'error' = res.ok ? 'ok' : 'error'
    // scanText: итог может содержать секрет (из кода/данных) → редактируем перед персистом
    // и пушем в Telegram (внешний канал) — тот же класс, что ревью утечки в session-summary.
    const raw = (res.ok ? res.text : (res.error ?? 'ошибка')) || '(пустой ответ)'
    const summary = scanText(raw).redacted
    recordScheduledRun(db, taskId, { status, summary, minute: minuteIdx, at: Date.now() })
    deps.recordJournal(task.project_path, 'note', `🕒 Расписание: ${task.human || task.cron}`, summary.slice(0, 1000))
    const header = res.ok
      ? `🕒 Verstak — расписание «${task.human || task.cron}»`
      : `🕒 Verstak — расписание УПАЛО («${task.human || task.cron}»)`
    await pushTelegram(deps, `${header}\n\n${summary}`.slice(0, 3500), ac.signal)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    recordScheduledRun(db, taskId, { status: 'error', summary: scanText(msg).redacted, minute: minuteIdx, at: Date.now() })
  } finally {
    clearTimeout(timeout)
    running.delete(taskId)
  }
}

let timer: NodeJS.Timeout | null = null

function tick(db: Database, deps: SchedulerDeps): void {
  const now = new Date()
  recordSchedulerHeartbeat(db, now.getTime())
  const minuteIdx = Math.floor(now.getTime() / 60_000)
  const due = selectDueTasks(listEnabledScheduledTasks(db), nowParts(now), minuteIdx)
  for (const task of due) void runOne(db, deps, task.id, minuteIdx)
}

export function registerSchedulerIpc(db: Database, deps: SchedulerDeps): void {
  ipcMain.handle('scheduler:list', (_e, projectPath?: string) => listScheduledTasks(db, projectPath))
  ipcMain.handle('scheduler:health', () => schedulerHealth(getSchedulerHeartbeat(db)))
  ipcMain.handle('scheduler:create', (_e, input: { projectPath: string; prompt: string; nl: string }) => {
    const prompt = (input.prompt ?? '').trim()
    const lifecycleRisk = schedulerPromptLifecycleRisk(prompt)
    if (lifecycleRisk) return { error: `Cron-задача отклонена: ${lifecycleRisk}` }
    if (!prompt) return { error: 'Пустая задача.' }
    if (!isWithinKnownRoots(input.projectPath, deps.getKnownRoots())) return { error: 'Путь проекта не зарегистрирован.' }
    const parsed = parseSchedule(input.nl ?? '')
    if (!parsed) return { error: 'Не распознал расписание. Примеры: «каждое утро», «каждый день в 9:30», «по будням в 8», «каждые 2 часа».' }
    return { task: createScheduledTask(db, { projectPath: input.projectPath, prompt, cron: parsed.cron, human: parsed.human }) }
  })
  ipcMain.handle('scheduler:toggle', (_e, id: number, enabled: boolean) => { setScheduledTaskEnabled(db, id, enabled); return true })
  ipcMain.handle('scheduler:delete', (_e, id: number) => deleteScheduledTask(db, id))
  ipcMain.handle('scheduler:run-now', async (_e, id: number) => {
    await runOne(db, deps, id, Math.floor(Date.now() / 60_000))
    return getScheduledTask(db, id)
  })

  // Тик раз в минуту — лёгкий: только enabled-задачи + cronMatches.
  if (timer) clearInterval(timer)
  timer = setInterval(() => { try { tick(db, deps) } catch { /* тик не должен падать */ } }, 60_000)
}
