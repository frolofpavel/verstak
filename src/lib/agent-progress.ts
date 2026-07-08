export type AgentProgressPhase =
  | 'understand'
  | 'context'
  | 'model'
  | 'reasoning'
  | 'tool'
  | 'command'
  | 'write'
  | 'verify'
  | 'final'

export type AgentProgressStatus = 'pending' | 'running' | 'done' | 'error' | 'blocked'

export interface AgentProgressEntry {
  id: string
  phase: AgentProgressPhase
  title: string
  detail?: string
  status: AgentProgressStatus
  timestamp: number
}

export interface AgentProgressEventPayload {
  type: 'agent-progress'
  id?: string
  phase: AgentProgressPhase
  title: string
  detail?: string
  status?: AgentProgressStatus
}

const MAX_AGENT_PROGRESS = 36
const TASK_FOCUS_ID = 'task-focus'

function now(): number {
  return Date.now()
}

function compact(text: unknown, max = 180): string | undefined {
  if (typeof text !== 'string') return undefined
  const clean = text
    .replace(/```[\s\S]*?```/g, ' фрагмент кода ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return undefined
  return clean.length > max ? clean.slice(0, max - 1) + '...' : clean
}

function hasCyrillic(text: string): boolean {
  return /[А-Яа-яЁё]/.test(text)
}

function taskFocus(progress: AgentProgressEntry[]): string | undefined {
  const focus = progress.find(item => item.id === TASK_FOCUS_ID)
  if (!focus?.detail) return undefined
  return focus.detail.replace(/^Фокус:\s*/i, '').trim()
}

function commandSummary(command: unknown): string | undefined {
  return compact(command, 160)
}

function toolTitle(name: unknown, fallback: unknown): string {
  const n = typeof name === 'string' ? name : ''
  if (n === 'read_file' || n === 'browser_read_page' || n === 'connector_query') return 'Читаю нужные данные'
  if (n === 'list_directory' || n === 'list_connectors') return 'Смотрю доступные разделы'
  if (n === 'find_files' || n === 'search_project') return 'Ищу по проекту'
  if (n === 'write_file' || n === 'apply_patch' || n === 'propose_edits') return 'Готовлю изменение'
  if (n === 'attest_verification' || n === 'verify_changes') return 'Проверяю результат'
  return compact(fallback, 80) ?? 'Выполняю инструмент'
}

function statusFromTool(status: unknown): AgentProgressStatus {
  if (status === 'error') return 'error'
  if (status === 'rejected') return 'blocked'
  return 'done'
}

function trimProgress(entries: AgentProgressEntry[]): AgentProgressEntry[] {
  if (entries.length <= MAX_AGENT_PROGRESS) return entries
  const focus = entries.find(item => item.id === TASK_FOCUS_ID)
  const tail = entries.filter(item => item.id !== TASK_FOCUS_ID).slice(-(MAX_AGENT_PROGRESS - (focus ? 1 : 0)))
  return focus ? [focus, ...tail] : tail
}

function finishRunning(progress: AgentProgressEntry[], status: AgentProgressStatus): AgentProgressEntry[] {
  const ts = now()
  return progress.map(item => (
    item.status === 'running' || item.status === 'pending'
      ? { ...item, status, timestamp: ts }
      : item
  ))
}

function thoughtNarrative(rawThought: unknown, focus?: string): string {
  const clean = compact(rawThought, 220)
  if (!clean) {
    return focus
      ? `Сверяю следующий шаг с задачей: ${focus}`
      : 'Уточняю смысл запроса и выбираю следующий шаг.'
  }

  const lower = clean.toLowerCase()
  if (hasCyrillic(clean)) {
    return compact(clean, 200) ?? clean
  }
  if (/(the user is asking|current_user_request|user request|user wants)/i.test(clean)) {
    return focus
      ? `Разбираю, что именно нужно сделать по запросу: ${focus}`
      : 'Разбираю, что именно просит пользователь.'
  }
  if (/(need to|i need|i should|i will|first,|next,|let me)/i.test(clean)) {
    return focus
      ? `Планирую следующий шаг по задаче: ${focus}`
      : 'Планирую следующий шаг перед видимым ответом.'
  }
  if (/(search|check|verify|inspect|read)/i.test(lower)) {
    return 'Проверяю контекст и факты, чтобы не ответить вслепую.'
  }
  return focus
    ? `Сопоставляю внутренний черновик с задачей: ${focus}`
    : 'Сопоставляю внутренний черновик с задачей.'
}

export function upsertAgentProgress(
  progress: AgentProgressEntry[],
  entry: AgentProgressEntry
): AgentProgressEntry[] {
  const idx = progress.findIndex(item => item.id === entry.id)
  if (idx === -1) return trimProgress([...progress, entry])
  const next = progress.slice()
  next[idx] = { ...next[idx], ...entry, timestamp: entry.timestamp || next[idx].timestamp }
  return trimProgress(next)
}

export function markAgentProgress(
  progress: AgentProgressEntry[],
  ids: string[],
  status: AgentProgressStatus
): AgentProgressEntry[] {
  if (ids.length === 0) return progress
  const set = new Set(ids)
  const ts = now()
  return progress.map(item => set.has(item.id) ? { ...item, status, timestamp: ts } : item)
}

export function buildInitialAgentProgress(taskText: string, providerLabel?: string): AgentProgressEntry[] {
  const ts = now()
  const focus = compact(taskText, 240) ?? 'Новый запрос пользователя'
  return [
    {
      id: TASK_FOCUS_ID,
      phase: 'understand',
      title: 'Разбираю задачу',
      detail: `Фокус: ${focus}`,
      status: 'running',
      timestamp: ts
    },
    {
      id: 'context',
      phase: 'context',
      title: 'Подбираю контекст',
      detail: 'Смотрю историю этого чата, настройки проекта и доступные данные, которые могут повлиять на ответ.',
      status: 'pending',
      timestamp: ts + 1
    },
    {
      id: 'model',
      phase: 'model',
      title: providerLabel ? `Готовлю запуск ${providerLabel}` : 'Готовлю запуск модели',
      detail: 'Собираю запрос для модели с учётом текущего режима и выбранного провайдера.',
      status: 'pending',
      timestamp: ts + 2
    }
  ]
}

export function activateModelProgress(progress: AgentProgressEntry[], providerLabel?: string): AgentProgressEntry[] {
  const ts = now()
  const focus = taskFocus(progress)
  let next = markAgentProgress(progress, ['context'], 'done')
  next = upsertAgentProgress(next, {
    id: 'model',
    phase: 'model',
    title: providerLabel ? `${providerLabel} начал работу` : 'Модель начала работу',
    detail: focus
      ? `Передал задачу модели. Жду первые признаки работы по запросу: ${focus}`
      : 'Передал задачу модели. Жду рассуждение, инструмент или видимый текст ответа.',
    status: 'running',
    timestamp: ts
  })
  return next
}

export function reduceAgentProgress(
  progress: AgentProgressEntry[],
  event: { type: string; [key: string]: unknown }
): AgentProgressEntry[] {
  const ts = now()
  const focus = taskFocus(progress)

  if (event.type === 'agent-progress') {
    const payload = event as Partial<AgentProgressEventPayload>
    if (!payload.title || !payload.phase) return progress
    return upsertAgentProgress(progress, {
      id: payload.id ?? `${payload.phase}-${payload.title}`,
      phase: payload.phase,
      title: payload.title,
      detail: compact(payload.detail, 220),
      status: payload.status ?? 'running',
      timestamp: ts
    })
  }

  if (event.type === 'thought') {
    const next = markAgentProgress(progress, ['model'], 'done')
    return upsertAgentProgress(next, {
      id: 'reasoning',
      phase: 'reasoning',
      title: 'Осмысливаю задачу',
      detail: thoughtNarrative(event.text, focus),
      status: 'running',
      timestamp: ts
    })
  }

  if (event.type === 'text') {
    const next = markAgentProgress(progress, ['context', 'model', 'reasoning'], 'done')
    return upsertAgentProgress(next, {
      id: 'final',
      phase: 'final',
      title: 'Пишу видимый ответ',
      detail: compact(event.text, 120)
        ? 'Начал отдавать ответ в чат.'
        : 'Формирую текст, который пользователь увидит в сообщении.',
      status: 'running',
      timestamp: ts
    })
  }

  if (event.type === 'pending-write') {
    return upsertAgentProgress(progress, {
      id: `write-${String(event.callId ?? ts)}`,
      phase: 'write',
      title: 'Нужно подтвердить изменение файла',
      detail: compact(event.path, 180),
      status: 'running',
      timestamp: ts
    })
  }

  if (event.type === 'pending-command') {
    return upsertAgentProgress(progress, {
      id: `command-${String(event.callId ?? ts)}`,
      phase: 'command',
      title: 'Нужно подтвердить команду',
      detail: commandSummary(event.command),
      status: 'running',
      timestamp: ts
    })
  }

  if (event.type === 'command-result') {
    const status = statusFromTool(event.status)
    return upsertAgentProgress(progress, {
      id: `command-${String(event.callId ?? ts)}`,
      phase: 'command',
      title: status === 'done' ? 'Команда выполнена' : status === 'blocked' ? 'Команда отклонена' : 'Команда завершилась ошибкой',
      detail: status === 'error' ? commandSummary(event.error) ?? commandSummary(event.command) : commandSummary(event.command),
      status,
      timestamp: ts
    })
  }

  if (event.type === 'tool-activity') {
    const status = statusFromTool(event.status)
    return upsertAgentProgress(progress, {
      id: `tool-${String(event.callId ?? ts)}-${String(event.name ?? 'tool')}`,
      phase: event.name === 'attest_verification' || event.name === 'verify_changes' ? 'verify' : 'tool',
      title: toolTitle(event.name, event.label),
      detail: compact(event.detail, 180),
      status,
      timestamp: ts
    })
  }

  if (event.type === 'tool-blocked') {
    return upsertAgentProgress(progress, {
      id: `blocked-${String(event.callId ?? ts)}`,
      phase: 'tool',
      title: 'Инструмент заблокирован',
      detail: compact(event.reason, 180),
      status: 'blocked',
      timestamp: ts
    })
  }

  if (event.type === 'plan-created') {
    return upsertAgentProgress(progress, {
      id: `plan-${String(event.planId ?? ts)}`,
      phase: 'tool',
      title: 'Собрал план действий',
      detail: `${compact(event.title, 120) ?? 'План'}${typeof event.stepCount === 'number' ? `, ${event.stepCount} шагов` : ''}`,
      status: 'done',
      timestamp: ts
    })
  }

  if (event.type === 'preflight') {
    return upsertAgentProgress(progress, {
      id: `preflight-${String(event.callId ?? ts)}`,
      phase: 'verify',
      title: 'Проверяю действие перед выполнением',
      detail: compact(event.summary, 180),
      status: 'done',
      timestamp: ts
    })
  }

  if (event.type === 'subagent-run') {
    const rawStatus = event.status
    const status: AgentProgressStatus = rawStatus === 'running' ? 'running' : rawStatus === 'error' ? 'error' : 'done'
    return upsertAgentProgress(progress, {
      id: `subagent-${String(event.callId ?? ts)}`,
      phase: 'tool',
      title: status === 'running' ? 'Передал подзадачу агенту' : status === 'error' ? 'Подзадача завершилась ошибкой' : 'Подзадача завершена',
      detail: compact(event.task, 180),
      status,
      timestamp: ts
    })
  }

  if (event.type === 'artifact-created') {
    return upsertAgentProgress(progress, {
      id: `artifact-${String(event.callId ?? ts)}`,
      phase: 'final',
      title: 'Создал артефакт',
      detail: compact(event.filename, 140),
      status: 'done',
      timestamp: ts
    })
  }

  if (event.type === 'verification-attested') {
    const ok = event.overall === 'passed'
    return upsertAgentProgress(progress, {
      id: `verify-${String(event.callId ?? ts)}`,
      phase: 'verify',
      title: ok ? 'Проверка пройдена' : 'Проверка требует внимания',
      detail: typeof event.checksPassed === 'number' && typeof event.checksTotal === 'number'
        ? `${event.checksPassed}/${event.checksTotal} проверок`
        : undefined,
      status: ok ? 'done' : 'error',
      timestamp: ts
    })
  }

  if (event.type === 'context-compact') {
    const phase = event.phase
    return upsertAgentProgress(progress, {
      id: 'context-compact',
      phase: 'context',
      title: phase === 'done' ? 'Контекст сжат' : phase === 'cancel' ? 'Сжатие контекста отменено' : 'Сжимаю контекст',
      detail: phase === 'done'
        ? `Сохранил ${String(event.keptTurns ?? '?')} сообщений, убрал ${String(event.droppedTurns ?? '?')}.`
        : 'Освобождаю место в истории, чтобы модель продолжила задачу без переполнения.',
      status: phase === 'done' ? 'done' : phase === 'cancel' ? 'blocked' : 'running',
      timestamp: ts
    })
  }

  if (event.type === 'info') {
    const text = compact(event.text ?? event.message, 190)
    return upsertAgentProgress(progress, {
      id: `info-${ts}`,
      phase: 'tool',
      title: 'Обновляю статус',
      detail: text,
      status: 'done',
      timestamp: ts
    })
  }

  if (event.type === 'done') {
    const next = finishRunning(progress, 'done')
    return upsertAgentProgress(next, {
      id: 'done',
      phase: 'final',
      title: 'Ответ готов',
      detail: 'Работа завершена, результат записан в чат.',
      status: 'done',
      timestamp: ts
    })
  }

  if (event.type === 'error') {
    const next = finishRunning(progress, 'error')
    return upsertAgentProgress(next, {
      id: 'error',
      phase: 'final',
      title: 'Работа остановлена',
      detail: compact(event.message, 220),
      status: 'error',
      timestamp: ts
    })
  }

  return progress
}
