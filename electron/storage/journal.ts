import type { Database } from 'better-sqlite3'

export type JournalKind = 'manual' | 'session' | 'tool' | 'note'

export interface JournalEntry {
  id: number
  kind: JournalKind
  title: string
  detail: string | null
  createdAt: number
}

export interface Journal {
  list: (projectPath: string, limit?: number) => JournalEntry[]
  append: (projectPath: string, kind: JournalKind, title: string, detail?: string | null) => JournalEntry
  currentSession: (projectPath: string, now?: number) => JournalEntry | null
  flushSessionSummaries: (reason?: 'close' | 'day', now?: number) => JournalEntry[]
  flushDailyRollovers: (now?: number) => JournalEntry[]
  updateManual: (id: number, title: string, detail?: string | null) => JournalEntry | null
  remove: (id: number) => void
  clear: (projectPath: string) => number
}

interface Row {
  id: number
  kind: JournalKind
  title: string
  detail: string | null
  createdAt: number
}

interface ChatRow {
  role: 'user' | 'assistant' | string
  content: string
  createdAt: number
}

interface SessionTurn {
  user: string | null
  assistant: string | null
  actions: string[]
  errors: string[]
}

interface SessionSummary {
  version: 1
  type: 'session-summary'
  startedAt: number
  endedAt: number
  reason: 'close' | 'day' | 'current'
  stats: {
    userMessages: number
    assistantMessages: number
    toolEvents: number
    errors: number
  }
  turns: SessionTurn[]
  created: string[]
  changed: string[]
  removed: string[]
  commands: string[]
  notes: string[]
  errors: string[]
}

export function createJournal(db: Database): Journal {
  const appSessionStart = Date.now()
  const activeSinceByProject = new Map<string, number>()

  const insertEntry = (projectPath: string, kind: JournalKind, title: string, detail: string | null, createdAt: number): JournalEntry => {
    const info = db.prepare(
      'INSERT INTO journal (project_path, kind, title, detail, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(projectPath, kind, title, detail, createdAt)
    return { id: Number(info.lastInsertRowid), kind, title, detail, createdAt }
  }

  const ensureActive = (projectPath: string, now: number) => {
    if (!activeSinceByProject.has(projectPath)) {
      activeSinceByProject.set(projectPath, Math.max(appSessionStart, startOfLocalDay(now)))
    }
  }

  const seedActiveProjectsFromChats = (now: number) => {
    const rows = db.prepare(`
      SELECT project_path as projectPath, MIN(created_at) as firstAt
      FROM chats
      WHERE created_at >= ?
        AND created_at <= ?
      GROUP BY project_path
    `).all(appSessionStart, now) as Array<{ projectPath: string; firstAt: number }>
    for (const row of rows) {
      if (!activeSinceByProject.has(row.projectPath)) {
        activeSinceByProject.set(row.projectPath, Math.max(appSessionStart, startOfLocalDay(row.firstAt)))
      }
    }
  }

  const isSummaryTitle = (title: string) =>
    title.startsWith('Сводка сессии')
    || title.startsWith('Сводка дня')
    || title.startsWith('РЎРІРѕРґРєР° СЃРµСЃСЃРёРё')
    || title.startsWith('РЎРІРѕРґРєР° РґРЅСЏ')
    || title.startsWith('Р РЋР Р†Р С•Р Т‘Р С”Р В° РЎРѓР ВµРЎРѓРЎРѓР С‘Р С‘')
    || title.startsWith('Р РЋР Р†Р С•Р Т‘Р С”Р В° Р Т‘Р Р…РЎРЏ')
  const isLegacySessionTitle = (title: string) => !isSummaryTitle(title)

  const buildProjectSummary = (projectPath: string, start: number, end: number, reason: 'close' | 'day' | 'current'): SessionSummary | null => {
    if (end < start) return null
    const events = db.prepare(`
      SELECT id, kind, title, detail, created_at as createdAt
      FROM journal
      WHERE project_path = ?
        AND created_at >= ?
        AND created_at <= ?
        AND kind != 'session'
      ORDER BY id ASC
    `).all(projectPath, start, end) as Row[]
    const messages = db.prepare(`
      SELECT role, content, created_at as createdAt
      FROM chats
      WHERE project_path = ?
        AND created_at >= ?
        AND created_at <= ?
        AND role IN ('user', 'assistant')
      ORDER BY id ASC
    `).all(projectPath, start, end) as ChatRow[]
    if (events.length === 0 && messages.length === 0) return null
    return buildSessionSummary(messages, events, start, end, reason)
  }

  const flushProjectWindow = (projectPath: string, start: number, end: number, reason: 'close' | 'day'): JournalEntry | null => {
    const summary = buildProjectSummary(projectPath, start, end, reason)
    if (!summary) return null
    const title = reason === 'day'
      ? `Сводка дня · ${formatDate(start)}`
      : `Сводка сессии · ${formatDate(start)} ${formatClock(start)}-${formatClock(end)}`

    const exists = db.prepare(
      'SELECT id FROM journal WHERE project_path = ? AND kind = ? AND title = ? LIMIT 1'
    ).get(projectPath, 'session', title) as { id: number } | undefined
    if (exists) return null

    return insertEntry(projectPath, 'session', title, JSON.stringify(summary), end)
  }

  const flushProjectRollover = (projectPath: string, now: number): JournalEntry[] => {
    const start = activeSinceByProject.get(projectPath)
    if (!start) return []
    const todayStart = startOfLocalDay(now)
    if (start >= todayStart) return []
    const flushed = flushProjectWindow(projectPath, start, todayStart - 1, 'day')
    activeSinceByProject.set(projectPath, todayStart)
    return flushed ? [flushed] : []
  }

  return {
    list(projectPath, limit = 200) {
      const rows = db.prepare(`
        SELECT id, kind, title, detail, created_at as createdAt
        FROM journal
        WHERE project_path = ?
          AND (
            kind = 'manual'
            OR (kind = 'session' AND (
              title LIKE 'Сводка сессии%'
              OR title LIKE 'Сводка дня%'
              OR title LIKE 'РЎРІРѕРґРєР° СЃРµСЃСЃРёРё%'
              OR title LIKE 'РЎРІРѕРґРєР° РґРЅСЏ%'
              OR title LIKE 'Р РЋР Р†Р С•Р Т‘Р С”Р В° РЎРѓР ВµРЎРѓРЎРѓР С‘Р С‘%'
              OR title LIKE 'Р РЋР Р†Р С•Р Т‘Р С”Р В° Р Т‘Р Р…РЎРЏ%'
            ))
          )
        ORDER BY id DESC
        LIMIT ?
      `).all(projectPath, limit) as Row[]
      return rows
    },
    append(projectPath, kind, title, detail = null) {
      const now = Date.now()
      ensureActive(projectPath, now)
      flushProjectRollover(projectPath, now)
      if (kind === 'session' && isLegacySessionTitle(title)) {
        return { id: 0, kind, title, detail, createdAt: now }
      }
      return insertEntry(projectPath, kind, title, detail, now)
    },
    currentSession(projectPath, now = Date.now()) {
      ensureActive(projectPath, now)
      flushProjectRollover(projectPath, now)
      const start = activeSinceByProject.get(projectPath) ?? Math.max(appSessionStart, startOfLocalDay(now))
      const summary = buildProjectSummary(projectPath, start, now, 'current')
      if (!summary) return null
      return {
        id: 0,
        kind: 'session',
        title: `Текущая сессия · ${formatDate(start)} ${formatClock(start)}-${formatClock(now)}`,
        detail: JSON.stringify(summary),
        createdAt: now
      }
    },
    flushSessionSummaries(reason = 'close', now = Date.now()) {
      seedActiveProjectsFromChats(now)
      const created: JournalEntry[] = []
      for (const [projectPath, start] of activeSinceByProject) {
        const flushed = flushProjectWindow(projectPath, start, now, reason)
        if (flushed) created.push(flushed)
        activeSinceByProject.set(projectPath, now)
      }
      return created
    },
    flushDailyRollovers(now = Date.now()) {
      seedActiveProjectsFromChats(now)
      const created: JournalEntry[] = []
      for (const projectPath of activeSinceByProject.keys()) {
        created.push(...flushProjectRollover(projectPath, now))
      }
      return created
    },
    updateManual(id, title, detail = null) {
      const row = db.prepare(
        'SELECT id, kind, title, detail, created_at as createdAt FROM journal WHERE id = ?'
      ).get(id) as Row | undefined
      if (!row || row.kind !== 'manual') return null
      db.prepare('UPDATE journal SET title = ?, detail = ? WHERE id = ? AND kind = ?')
        .run(title, detail, id, 'manual')
      return { ...row, title, detail }
    },
    remove(id) {
      db.prepare('DELETE FROM journal WHERE id = ?').run(id)
    },
    clear(projectPath) {
      const info = db.prepare('DELETE FROM journal WHERE project_path = ?').run(projectPath)
      return info.changes
    }
  }
}

function buildSessionSummary(messages: ChatRow[], rows: Row[], start: number, end: number, reason: 'close' | 'day' | 'current'): SessionSummary {
  const changed: string[] = []
  const added: string[] = []
  const removed: string[] = []
  const commands: string[] = []
  const notes: string[] = []
  const errors: string[] = []
  const done: string[] = []
  const turns: SessionTurn[] = []
  let currentTurn: SessionTurn | null = null

  for (const message of messages) {
    const text = cleanMessage(message.content)
    if (!text) continue
    if (message.role === 'user') {
      currentTurn = { user: summarizeUserRequest(text), assistant: null, actions: [], errors: [] }
      turns.push(currentTurn)
    } else if (message.role === 'assistant') {
      const summary = summarizeAssistantResponse(text)
      if (!currentTurn) {
        currentTurn = { user: null, assistant: summary, actions: [], errors: [] }
        turns.push(currentTurn)
      } else if (currentTurn.assistant) {
        currentTurn.assistant = mergeSentences(currentTurn.assistant, summary)
      } else {
        currentTurn.assistant = summary
      }
    }
  }

  for (const row of rows) {
    const text = compactLine(`${row.title}${row.detail ? `: ${row.detail}` : ''}`)
    if (/(ошиб|error|failed|fail|упал|не удалось)/i.test(text)) {
      pushUnique(errors, text)
      attachToNearestTurn(turns, text, row.createdAt, messages, true)
      continue
    }
    if (/(удал|remove|delete|deleted)/i.test(text)) {
      pushUnique(removed, text)
      attachToNearestTurn(turns, text, row.createdAt, messages)
      continue
    }
    if (/(создан|создал|добав|add|added|create|created)/i.test(text)) {
      pushUnique(added, text)
      attachToNearestTurn(turns, text, row.createdAt, messages)
      continue
    }
    if (/(измен|обнов|правк|edit|change|changed|update|updated|write|patch)/i.test(text)) {
      pushUnique(changed, text)
      attachToNearestTurn(turns, text, row.createdAt, messages)
      continue
    }
    if (row.kind === 'tool' || /команд|command/i.test(text)) {
      pushUnique(commands, text)
      attachToNearestTurn(turns, text, row.createdAt, messages)
      continue
    }
    if (row.kind === 'manual' || row.kind === 'note') {
      pushUnique(notes, text)
      continue
    }
    pushUnique(done, text)
  }

  for (const turn of turns) {
    if (turn.assistant) {
      turn.assistant = enrichAssistantSummary(turn.assistant, turn.actions, turn.errors)
    }
  }

  if (turns.length === 0 && done.length > 0) {
    turns.push({ user: null, assistant: done.slice(0, 3).join('; '), actions: [], errors: [] })
  }

  return {
    version: 1,
    type: 'session-summary',
    startedAt: start,
    endedAt: end,
    reason,
    stats: {
      userMessages: messages.filter(m => m.role === 'user').length,
      assistantMessages: messages.filter(m => m.role === 'assistant').length,
      toolEvents: rows.length,
      errors: errors.length
    },
    turns: turns.slice(0, 20),
    created: added.slice(0, 20),
    changed: changed.slice(0, 20),
    removed: removed.slice(0, 20),
    commands: commands.slice(0, 20),
    notes: notes.slice(0, 20),
    errors: errors.slice(0, 20)
  }
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`
}

function formatClock(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function pushUnique(values: string[], value: string): void {
  if (!value || values.includes(value)) return
  values.push(value)
}

function compactLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 240)
}

function cleanMessage(value: string): string {
  const clean = value
    .replace(/\[Вложение:[^\]]+\]/g, '')
    .replace(/```[\s\S]*?```/g, ' фрагмент кода ')
    .replace(/https?:\/\/\S+/g, ' ссылка ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean
}

function summarizeUserRequest(value: string): string {
  const text = clipSentence(value, 180)
  const lower = text.toLowerCase()
  if (/аудит|провер|разбор/.test(lower) && /рк|реклам|кампан/.test(lower)) {
    return `запросил краткий аудит по РК${periodSuffix(lower)}`
  }
  if (/аудит|провер|разбор/.test(lower)) {
    return `запросил краткий аудит по клиенту${periodSuffix(lower)}`
  }
  if (/что .*добав|что .*убра|добавить|убрать|лишн/.test(lower)) {
    return 'уточнил, что стоит добавить и что убрать в проекте'
  }
  if (/сводк|отчет|отчёт/.test(lower)) {
    return `запросил краткую сводку${periodSuffix(lower)}`
  }
  if (/исправ|почин|сдела|передела|добав|убер|созда|собер|настрой|проверь|проанализ/.test(lower)) {
    return `попросил выполнить задачу: ${lowercaseFirst(text)}`
  }
  if (text.endsWith('?')) {
    return `задал вопрос: ${text}`
  }
  return `написал: ${text}`
}

function summarizeAssistantResponse(value: string): string {
  const text = clipSentence(value, 420)
  const lower = text.toLowerCase()
  const parts: string[] = []

  if (/аудит|разбор|провер/.test(lower)) {
    parts.push(`Отправила краткий аудит${periodSuffix(lower)}.`)
  } else if (/сводк|отчет|отчёт/.test(lower)) {
    parts.push(`Подготовила краткую сводку${periodSuffix(lower)}.`)
  } else if (/план|шаг|решени/.test(lower)) {
    parts.push('Предложила план действий.')
  } else if (/исправ|почин|обнов|добав|измен|настро/.test(lower)) {
    parts.push('Описала выполненные изменения.')
  } else {
    parts.push('Ответила по запросу пользователя.')
  }

  if (/недостат|проблем|ошиб|риск|слаб|просад|минус/.test(lower)) {
    parts.push('Указала на недостатки и риски.')
  }
  if (/план|решени|рекоменд|что делать|следующ/.test(lower)) {
    parts.push('Предоставила план решения проблемы.')
  }
  if (/добав|убра|лишн|остав/.test(lower)) {
    parts.push('Дала рекомендации, что добавить или убрать.')
  }

  return dedupeSentences(parts).join(' ')
}

function enrichAssistantSummary(summary: string, actions: string[], errors: string[]): string {
  const parts = [summary]
  if (actions.length > 0 && !/выполн/i.test(summary)) {
    parts.push('Зафиксировала выполненные изменения в проекте.')
  }
  if (errors.length > 0) {
    parts.push('Отметила ошибки, которые возникли при выполнении.')
  }
  return dedupeSentences(parts).join(' ')
}

function periodSuffix(lowerText: string): string {
  const range = lowerText.match(/\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\s*(?:-|–|—|по|до)\s*\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/)
  if (range) return ` за ${range[0]}`
  if (/недел|7\s*д/.test(lowerText)) return ' за неделю'
  if (/месяц|30\s*д/.test(lowerText)) return ' за месяц'
  if (/день|сутк|сегодня/.test(lowerText)) return ' за день'
  return ''
}

function clipSentence(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const clipped = clean.slice(0, max).trim()
  const sentenceEnd = Math.max(clipped.lastIndexOf('.'), clipped.lastIndexOf('!'), clipped.lastIndexOf('?'))
  if (sentenceEnd > 60) return clipped.slice(0, sentenceEnd + 1)
  return `${clipped.replace(/[.,;:!?-]+$/g, '')}...`
}

function lowercaseFirst(value: string): string {
  if (!value) return value
  return `${value[0].toLowerCase()}${value.slice(1)}`
}

function mergeSentences(a: string, b: string): string {
  return dedupeSentences([...a.split(/(?<=\.)\s+/), ...b.split(/(?<=\.)\s+/)]).join(' ')
}

function dedupeSentences(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = value.trim()
    if (!normalized || seen.has(normalized.toLowerCase())) continue
    seen.add(normalized.toLowerCase())
    result.push(normalized)
  }
  return result
}

function attachToNearestTurn(turns: SessionTurn[], text: string, eventAt: number, messages: ChatRow[], isError = false): void {
  if (turns.length === 0) return
  let turnIndex = turns.length - 1
  let seenUser = -1
  for (const message of messages) {
    if (message.role === 'user') seenUser++
    if (message.createdAt > eventAt) break
    if (seenUser >= 0) turnIndex = Math.min(seenUser, turns.length - 1)
  }
  const turn = turns[turnIndex]
  if (!turn) return
  pushUnique(isError ? turn.errors : turn.actions, text)
}
