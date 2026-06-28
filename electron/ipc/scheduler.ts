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
  type ScheduledTask,
} from '../storage/scheduled-tasks'
import { createTelegramConnector } from '../connectors/telegram'

export interface SchedulerDeps {
  getSecret: (key: string) => string | null
  getProviderId: () => ProviderId
  getProviderModel: (id: ProviderId) => string | null
  recordJournal: (projectPath: string, kind: 'tool' | 'session' | 'note', title: string, detail?: string | null) => void
  runHeadless: (opts: { projectPath: string; prompt: string; providerId: ProviderId; model: string | null; signal: AbortSignal }) => Promise<{ ok: boolean; text: string; error?: string }>
}

/**
 * Какие задачи запускать в данную минуту: cron совпал И не запускались уже в эту
 * минуту (last_run_minute !== minuteIdx — анти-двойное срабатывание, в т.ч. после
 * рестарта приложения в ту же минуту). Чистая логика — тестируемо.
 */
export function selectDueTasks(tasks: ScheduledTask[], parts: TimeParts, minuteIdx: number): ScheduledTask[] {
  return tasks.filter(t => t.enabled && t.last_run_minute !== minuteIdx && cronMatches(t.cron, parts))
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
  const task = getScheduledTask(db, taskId)
  if (!task) return
  const providerId = (task.provider_id as ProviderId | null) ?? deps.getProviderId()
  const model = task.model ?? deps.getProviderModel(providerId)
  const ac = new AbortController()
  const timeout = setTimeout(() => ac.abort(), 5 * 60_000) // 5 мин потолок на unattended-прогон
  try {
    const res = await deps.runHeadless({ projectPath: task.project_path, prompt: task.prompt, providerId, model, signal: ac.signal })
    const status: 'ok' | 'error' = res.ok ? 'ok' : 'error'
    const summary = (res.ok ? res.text : (res.error ?? 'ошибка')) || '(пустой ответ)'
    recordScheduledRun(db, taskId, { status, summary, minute: minuteIdx, at: Date.now() })
    deps.recordJournal(task.project_path, 'note', `🕒 Расписание: ${task.human || task.cron}`, summary.slice(0, 1000))
    const header = res.ok
      ? `🕒 Verstak — расписание «${task.human || task.cron}»`
      : `🕒 Verstak — расписание УПАЛО («${task.human || task.cron}»)`
    await pushTelegram(deps, `${header}\n\n${summary}`.slice(0, 3500), ac.signal)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    recordScheduledRun(db, taskId, { status: 'error', summary: msg, minute: minuteIdx, at: Date.now() })
  } finally {
    clearTimeout(timeout)
  }
}

let timer: NodeJS.Timeout | null = null

function tick(db: Database, deps: SchedulerDeps): void {
  const now = new Date()
  const minuteIdx = Math.floor(now.getTime() / 60_000)
  const due = selectDueTasks(listEnabledScheduledTasks(db), nowParts(now), minuteIdx)
  for (const task of due) void runOne(db, deps, task.id, minuteIdx)
}

export function registerSchedulerIpc(db: Database, deps: SchedulerDeps): void {
  ipcMain.handle('scheduler:list', (_e, projectPath?: string) => listScheduledTasks(db, projectPath))
  ipcMain.handle('scheduler:create', (_e, input: { projectPath: string; prompt: string; nl: string }) => {
    const prompt = (input.prompt ?? '').trim()
    if (!prompt) return { error: 'Пустая задача.' }
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
