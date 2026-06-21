import { useEffect, useMemo, useState } from 'react'
import { useProject } from '../store/projectStore'
import type { JournalEntry } from '../types/api'

const KIND_LABEL: Record<JournalEntry['kind'], string> = {
  manual: 'Заметка',
  session: 'Сессия',
  tool: 'Действие',
  note: 'Заметка'
}

const KIND_COLOR: Record<JournalEntry['kind'], string> = {
  manual: 'var(--accent)',
  session: 'var(--success)',
  tool: 'var(--warning)',
  note: 'var(--text-tertiary)'
}

type KindFilter = 'all' | JournalEntry['kind']
const JOURNAL_FILTERS: KindFilter[] = ['all', 'session', 'tool', 'note']

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

export function JournalView() {
  const { path } = useProject()
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [currentSession, setCurrentSession] = useState<JournalEntry | null>(null)
  const [filter, setFilter] = useState<KindFilter>('session')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  async function refresh() {
    if (!path) return
    const [list, active] = await Promise.all([
      window.api.journal.list(path, 200),
      window.api.journal.currentSession(path)
    ])
    setEntries(list)
    setCurrentSession(active)
  }

  const systemEntries = useMemo(() => entries.filter(e => e.kind !== 'manual'), [entries])

  const visible = useMemo(() => systemEntries.filter(e => {
    if (filter !== 'all' && e.kind !== filter) return false
    if (search.trim()) {
      const q = search.toLowerCase()
      if (!e.title.toLowerCase().includes(q) && !(e.detail ?? '').toLowerCase().includes(q)) return false
    }
    return true
  }), [systemEntries, filter, search])

  const counts: Record<KindFilter, number> = { all: systemEntries.length, manual: 0, session: 0, tool: 0, note: 0 }
  for (const e of systemEntries) counts[e.kind]++

  useEffect(() => { void refresh() }, [path])

  useEffect(() => {
    if (!path) return
    const id = window.setInterval(() => void refresh(), 30_000)
    return () => window.clearInterval(id)
  }, [path])

  if (!path) {
    return (
      <div className="gg-panel">
        <div className="gg-panel-empty" style={{ marginTop: 80 }}>Открой проект, чтобы видеть журнал</div>
      </div>
    )
  }

  function toggleExpanded(key: string) {
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }))
  }

  return (
    <div className="gg-panel">
      <div className="gg-panel-header">
        <h2 className="gg-panel-title">Журнал проекта</h2>
        <div className="gg-panel-meta">{visible.length} из {systemEntries.length}</div>
      </div>

      <div className="gg-journal-toolbar">
        <div className="gg-journal-filters" role="tablist">
          {JOURNAL_FILTERS.map(k => (
            <button
              key={k}
              type="button"
              className={`gg-journal-chip ${filter === k ? 'is-active' : ''}`}
              onClick={() => setFilter(k)}
            >
              {k === 'all' ? 'Все' : k === 'session' ? 'Сессии' : k === 'tool' ? 'Действия' : 'Прочее'}
              <span className="gg-journal-chip-count">{counts[k]}</span>
            </button>
          ))}
        </div>
        <input
          className="gg-input gg-journal-search"
          placeholder="Поиск..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="gg-panel-body">
        {currentSession && (
          <div className="gg-journal-current">
            <div className="gg-journal-current-head">
              <span className="gg-journal-current-dot" />
              <span className="gg-journal-current-copy">
                <span>Текущая сессия</span>
                <span className="gg-journal-current-date">{formatSessionRange(currentSession)}</span>
              </span>
            </div>
            <JournalCard entry={currentSession} isCurrent expanded={!!expanded.current} onToggle={() => toggleExpanded('current')} />
          </div>
        )}

        {systemEntries.length === 0 && !currentSession && (
          <div className="gg-panel-empty">
            Журнал пуст. Когда в проекте появятся диалоги или действия AI, здесь будет краткая сводка сессии.
          </div>
        )}

        <div className="gg-journal-list">
          {visible.map(e => (
            <div key={e.id} className="gg-journal-entry">
              <div className={`gg-journal-meta${e.kind === 'session' ? ' is-session' : ''}`}>
                {e.kind !== 'session' && (
                  <>
                    <span className="gg-journal-kind" style={{ color: KIND_COLOR[e.kind], borderColor: KIND_COLOR[e.kind] }}>
                      {KIND_LABEL[e.kind]}
                    </span>
                    <span className="gg-journal-time">{formatTime(e.createdAt)}</span>
                  </>
                )}
              </div>
              {e.kind === 'session' ? (
                <JournalCard entry={e} expanded={!!expanded[String(e.id)]} onToggle={() => toggleExpanded(String(e.id))} />
              ) : (
                <>
                  <div className="gg-journal-title">{e.title}</div>
                  {e.detail && <div className="gg-journal-detail-text">{e.detail}</div>}
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function JournalCard({ entry, isCurrent = false, expanded, onToggle }: { entry: JournalEntry; isCurrent?: boolean; expanded: boolean; onToggle: () => void }) {
  const summary = parseSummary(entry.detail)
  if (!summary) {
    return (
      <div className={`gg-session-card ${isCurrent ? 'is-current' : ''}`}>
        {!isCurrent && (
          <div className="gg-session-card-head">
            <div>
              <div className="gg-journal-title">{formatSessionTitle(entry.title)}</div>
              <div className="gg-session-range">{formatTime(entry.createdAt)}</div>
            </div>
          </div>
        )}
        <div className="gg-session-legacy-note">
          Старая сводка сохранена в прежнем формате. Новые записи будут отображаться кратко: что запросил пользователь и что ответила программа.
        </div>
      </div>
    )
  }

  const visibleTurns = expanded ? summary.turns : summary.turns.slice(0, 3)
  const hiddenCount = Math.max(0, summary.turns.length - visibleTurns.length)

  return (
    <div className={`gg-session-card ${isCurrent ? 'is-current' : ''}`}>
      {!isCurrent && (
        <div className="gg-session-card-head">
          <div>
            <div className="gg-journal-title">{formatSessionTitle(entry.title)}</div>
            <div className="gg-session-range">
              {formatTime(summary.startedAt)} - {formatClock(summary.endedAt)}
            </div>
          </div>
          <div className="gg-session-stats">
            <span>{summary.stats.userMessages} запросов</span>
            {summary.stats.errors > 0 && <span className="is-error">{summary.stats.errors} ошибок</span>}
          </div>
        </div>
      )}

      {visibleTurns.length > 0 ? (
        <div className="gg-session-brief">
          {visibleTurns.map((turn, idx) => (
            <div key={idx} className="gg-session-turn">
              {turn.user && (
                <div className="gg-session-line is-user">
                  <div className="gg-session-role">Пользователь</div>
                  <div className="gg-session-text">{turn.user}</div>
                </div>
              )}
              {turn.assistant && (
                <div className="gg-session-line is-ai">
                  <div className="gg-session-role">Программа</div>
                  <div className="gg-session-text">{turn.assistant}</div>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="gg-journal-detail-text">В этой сессии пока нет диалогов, только технические события.</div>
      )}

      {hiddenCount > 0 || summary.turns.length > 3 ? (
        <button type="button" className="gg-session-more" onClick={onToggle}>
          {expanded ? 'Свернуть' : `Показать еще ${summary.turns.length - 3}`}
        </button>
      ) : null}
    </div>
  )
}

function parseSummary(detail: string | null): SessionSummary | null {
  if (!detail) return null
  try {
    const parsed = JSON.parse(detail) as Partial<SessionSummary>
    if (parsed?.type !== 'session-summary' || parsed.version !== 1) return null
    return {
      version: 1,
      type: 'session-summary',
      startedAt: Number(parsed.startedAt) || Date.now(),
      endedAt: Number(parsed.endedAt) || Date.now(),
      reason: parsed.reason === 'day' || parsed.reason === 'current' ? parsed.reason : 'close',
      stats: {
        userMessages: parsed.stats?.userMessages ?? 0,
        assistantMessages: parsed.stats?.assistantMessages ?? 0,
        toolEvents: parsed.stats?.toolEvents ?? 0,
        errors: parsed.stats?.errors ?? 0
      },
      turns: Array.isArray(parsed.turns) ? parsed.turns.map(t => ({
        user: typeof t.user === 'string' ? t.user : null,
        assistant: typeof t.assistant === 'string' ? t.assistant : null,
        actions: Array.isArray(t.actions) ? t.actions.filter(isString) : [],
        errors: Array.isArray(t.errors) ? t.errors.filter(isString) : []
      })) : [],
      created: Array.isArray(parsed.created) ? parsed.created.filter(isString) : [],
      changed: Array.isArray(parsed.changed) ? parsed.changed.filter(isString) : [],
      removed: Array.isArray(parsed.removed) ? parsed.removed.filter(isString) : [],
      commands: Array.isArray(parsed.commands) ? parsed.commands.filter(isString) : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes.filter(isString) : [],
      errors: Array.isArray(parsed.errors) ? parsed.errors.filter(isString) : []
    }
  } catch {
    return null
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatClock(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatSessionTitle(title: string): string {
  return title.split('·')[0]?.trim() || title
}

function formatSessionRange(entry: JournalEntry): string {
  const summary = parseSummary(entry.detail)
  if (!summary) return formatTime(entry.createdAt)
  return `${formatTime(summary.startedAt)} - ${formatClock(summary.endedAt)}`
}
