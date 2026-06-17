import { useEffect, useMemo, useState, useCallback } from 'react'
import { useProject } from '../store/projectStore'
import type { AgentRun, AgentRunEvent, AgentRunDetail, SubSession, SessionTodo, ProviderDescriptorDTO } from '../types/api'
import { buildAgentTree, type TreeNode } from '../lib/agent-tree'

/**
 * Панель «Задачи» (Multi-agent Manager V1, Фаза 3) — командный центр прогонов.
 *
 * Высокоуровневый список ВСЕХ прогонов проекта (один ai:send = одна строка
 * agent_runs): статус, заголовок, owner, провайдер/модель, счётчики субов /
 * tool-вызовов / файлов / стоимости, длительность. Клик → раскрытая карточка
 * с 4 секциями: Timeline событий, дерево суб-агентов, затронутые файлы,
 * верификация.
 *
 * Read-only (Фаза 3): кнопок Stop/Resume НЕТ — lifecycle включит Фаза 4.
 * Данные через window.api.agentRuns (новый IPC). Поллинг раз в 2с пока панель
 * открыта — статусы running → done обновляются без ручного refresh.
 *
 * Бейдж провайдера рендерится через метаданные window.api.providers.list()
 * (как в AgentsPanel) — renderer не имеет доступа к PROVIDERS из electron/.
 */

const STATUS_LABEL: Record<string, string> = {
  queued: 'в очереди',
  running: 'идёт',
  waiting_review: 'ждёт ревью',
  done: 'готово',
  failed: 'ошибка',
  stopped: 'остановлен'
}

const OWNER_LABEL: Record<string, string> = {
  main: 'основной',
  review: 'ревью',
  delegate: 'делегат',
  background: 'фон'
}

function fmtDuration(start: number, end: number | null): string {
  const ms = (end ?? Date.now()) - start
  if (ms < 1000) return `${ms}мс`
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}с`
  return `${Math.floor(sec / 60)}м ${sec % 60}с`
}

function fmtCost(cents: number): string | null {
  if (cents <= 0) return null
  return `$${(cents / 100).toFixed(2)}`
}

// Иконка события Timeline по kind (см. перечень в storage/agent-runs.ts).
function eventIcon(kind: string): string {
  switch (kind) {
    case 'user_msg': return '💬'
    case 'assistant_msg': return '🗨️'
    case 'tool_call': return '🔧'
    case 'delegate': return '🤖'
    case 'todo': return '☑️'
    case 'file_write': return '📄'
    case 'artifact': return '📦'
    case 'verify': return '🔍'
    case 'status': return '◆'
    case 'error': return '⛔'
    default: return '·'
  }
}

// Раскрытая карточка прогона — 4 секции из agent-runs:get.
function RunDetail({ runId, providerLabel }: { runId: string; providerLabel: (id: string | null) => string }) {
  const [detail, setDetail] = useState<AgentRunDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [proofMsg, setProofMsg] = useState<string | null>(null)
  const [proofBusy, setProofBusy] = useState(false)

  // Proof Pack — собрать доказательство выполнения прогона в proof.json + .html.
  const genProof = useCallback(async () => {
    setProofBusy(true); setProofMsg(null)
    try {
      const res = await window.api.proof.generate(runId)
      if (res.ok && res.htmlPath) {
        void window.api.files.revealInExplorer(res.htmlPath).catch(() => {})
        setProofMsg('✓ Proof Pack собран — файл открыт в проводнике')
      } else {
        setProofMsg(`Не удалось собрать: ${res.error ?? 'ошибка'}`)
      }
    } catch {
      setProofMsg('Не удалось собрать Proof Pack')
    }
    setProofBusy(false)
  }, [runId])

  const load = useCallback(async () => {
    try {
      const d = await window.api.agentRuns.get(runId)
      setDetail(d)
    } catch { /* IPC недоступен в dev — секция останется пустой */ }
    setLoading(false)
  }, [runId])

  // Поллинг детали раз в 2с — пока прогон идёт, его субы/события живые.
  useEffect(() => {
    void load()
    const t = setInterval(() => { if (!document.hidden) void load() }, 2000)
    return () => clearInterval(t)
  }, [load])

  if (loading && !detail) return <div className="gg-run-detail"><div className="gg-panel-empty">Загрузка…</div></div>

  const events: AgentRunEvent[] = detail?.events ?? []
  const subs: SubSession[] = detail?.subs ?? []
  const todos: SessionTodo[] = detail?.todos ?? []

  // Затронутые файлы — из событий file_write (ref = путь, иначе label).
  const files = events
    .filter(e => e.kind === 'file_write')
    .map(e => e.ref ?? e.label)
    .filter((p): p is string => !!p)
  const uniqueFiles = Array.from(new Set(files))

  // Верификация — события verify (Verification Artifact заполнит их позже).
  const verifyEvents = events.filter(e => e.kind === 'verify')

  // Дерево суб-агентов через общий buildAgentTree.
  const tree: TreeNode[] = buildAgentTree(subs)

  return (
    <div className="gg-run-detail">
      <div className="gg-run-proof">
        <button
          type="button"
          className="gg-btn gg-btn-sm"
          onClick={() => void genProof()}
          disabled={proofBusy}
          title="Собрать доказательство выполнения: изменённые файлы, проверки (DoD), стоимость, таймлайн, решения — в proof.json + proof.html"
        >
          🔏 {proofBusy ? 'Собираю…' : 'Proof Pack'}
        </button>
        {proofMsg && <span className="gg-run-proof-msg">{proofMsg}</span>}
      </div>
      {/* (1) Timeline событий */}
      <div className="gg-run-section">
        <div className="gg-run-section-title">Timeline</div>
        {events.length === 0 ? (
          <div className="gg-run-section-empty">События появятся по мере выполнения задачи.</div>
        ) : (
          <div className="gg-run-timeline">
            {events.map(e => (
              <div key={e.id} className={`gg-run-event is-${e.kind}`}>
                <span className="gg-run-event-icon" aria-hidden>{eventIcon(e.kind)}</span>
                <span className="gg-run-event-label">{e.label ?? e.kind}</span>
                {e.detail && <span className="gg-run-event-detail" title={e.detail}>{e.detail}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* (2) Дерево суб-агентов */}
      <div className="gg-run-section">
        <div className="gg-run-section-title">Суб-агенты ({subs.length})</div>
        {subs.length === 0 ? (
          <div className="gg-run-section-empty">Задача без делегирования суб-агентам.</div>
        ) : (
          <div className="gg-run-subtree">
            {tree.map(({ sub: s, level }) => (
              <div
                key={s.id}
                className={`gg-agent-card is-${s.status}${level > 0 ? ' is-child' : ''}`}
                style={level > 0 ? { marginLeft: level * 18 } : undefined}
              >
                <div className="gg-agent-card-main" style={{ cursor: 'default' }}>
                  <span className={`gg-agent-status-dot is-${s.status}`} />
                  <span className="gg-agent-role">{s.role ?? 'sub-agent'}</span>
                  <span className="gg-agent-provider">{providerLabel(s.providerId)}{s.model ? ` · ${s.model}` : ''}</span>
                  <span className="gg-agent-task" title={s.task ?? ''}>{s.task ?? ''}</span>
                  <span className="gg-agent-meta">
                    <span className="gg-agent-meta-dur">{fmtDuration(s.startedAt ?? s.createdAt, s.endedAt)}</span>
                    {s.toolCount != null && <span className="gg-agent-meta-tools"> 🔧{s.toolCount}</span>}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* (3) Затронутые файлы — клик открывает в проводнике */}
      <div className="gg-run-section">
        <div className="gg-run-section-title">Файлы ({uniqueFiles.length})</div>
        {uniqueFiles.length === 0 ? (
          <div className="gg-run-section-empty">Файловые правки появятся по мере выполнения.</div>
        ) : (
          <div className="gg-run-files">
            {uniqueFiles.map(f => (
              <button
                key={f}
                className="gg-run-file"
                title={`Открыть в проводнике: ${f}`}
                onClick={() => void window.api.files.revealInExplorer(f).catch(() => {})}
              >
                📄 {f}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* (4) Верификация — Verification Artifact (отдельная фича) заполнит позже */}
      <div className="gg-run-section">
        <div className="gg-run-section-title">Верификация</div>
        {verifyEvents.length === 0 ? (
          <div className="gg-run-section-empty">Нет данных верификации.</div>
        ) : (
          <div className="gg-run-verify">
            {verifyEvents.map(e => (
              <div key={e.id} className={`gg-run-verify-row is-${e.status ?? 'unknown'}`}>
                <span className="gg-run-verify-status">{e.status ?? '—'}</span>
                <span className="gg-run-verify-label">{e.label ?? e.detail ?? 'проверка'}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {todos.length > 0 && (
        <div className="gg-run-section">
          <div className="gg-run-section-title">Todo ({todos.filter(t => t.status === 'done').length}/{todos.length})</div>
          <div className="gg-todogate-list">
            {todos.map(t => (
              <div key={t.id} className={`gg-todo-item is-${t.status}`} title={t.goal ?? ''}>
                <span className="gg-todo-icon">
                  {t.status === 'done' ? '✅' : t.status === 'in_progress' ? '⏳' : t.status === 'blocked' ? '⛔' : '○'}
                </span>
                <span className="gg-todo-title">{t.title}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// Карточка прогона в списке — статус, заголовок, owner, провайдер, счётчики.
function RunCard({ run, providerLabel, expanded, onToggle, onStop, onResume }: {
  run: AgentRun
  providerLabel: (id: string | null) => string
  expanded: boolean
  onToggle: () => void
  onStop: (runId: string) => void
  onResume: (runId: string) => void
}) {
  const cost = fmtCost(run.costCents)
  // Lifecycle-кнопки (Фаза 4): активный прогон можно остановить; завершённый
  // ошибкой/остановкой — переотправить (честный re-send из run_inputs).
  const canStop = run.status === 'running' || run.status === 'queued'
  const canResume = run.status === 'failed' || run.status === 'stopped'
  return (
    <div className={`gg-run-card is-${run.status}${expanded ? ' is-expanded' : ''}`}>
      <button className="gg-run-card-head" onClick={onToggle}>
        <span className={`gg-agent-status-dot is-${run.status}`} />
        <span className="gg-run-card-title" title={run.title}>{run.title}</span>
        <span className={`gg-run-owner is-${run.owner}`}>{OWNER_LABEL[run.owner] ?? run.owner}</span>
        <span className="gg-run-card-provider">{providerLabel(run.providerId)}{run.model ? ` · ${run.model}` : ''}</span>
        <span className="gg-run-card-meta">
          {run.agentsCount > 0 && <span className="gg-run-stat" title="суб-агентов">🤖{run.agentsCount}</span>}
          {run.toolCount > 0 && <span className="gg-run-stat" title="tool-вызовов">🔧{run.toolCount}</span>}
          {run.filesCount > 0 && <span className="gg-run-stat" title="файлов изменено">📄{run.filesCount}</span>}
          {/* Живой прогресс running-прогона (tick): «ход N» + текущий инструмент —
              данные пишутся agentRuns.tick на каждом turn (аудит P0). */}
          {run.status === 'running' && run.turnIndex > 0 && (
            <span className="gg-run-stat" title="ход агентного цикла">↻{run.turnIndex}</span>
          )}
          {run.status === 'running' && run.lastToolName && (
            <span className="gg-run-stat gg-run-stat-livetool" title="сейчас выполняется">▸{run.lastToolName}</span>
          )}
          {cost && <span className="gg-run-stat gg-run-stat-cost">{cost}</span>}
          <span className="gg-run-stat gg-run-stat-dur">{fmtDuration(run.startedAt, run.endedAt)}</span>
          {canStop && (
            <span
              className="gg-run-action gg-run-action-stop"
              role="button"
              tabIndex={0}
              title="Остановить задачу"
              onClick={(e) => { e.stopPropagation(); onStop(run.runId) }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onStop(run.runId) } }}
            >⏹</span>
          )}
          {canResume && (
            <span
              className="gg-run-action gg-run-action-resume"
              role="button"
              tabIndex={0}
              title="Переотправить тот же запрос в чат"
              onClick={(e) => { e.stopPropagation(); onResume(run.runId) }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onResume(run.runId) } }}
            >↻ Переотправить</span>
          )}
          <span className="gg-run-card-caret">{expanded ? '▾' : '▸'}</span>
        </span>
      </button>
      {run.error && <div className="gg-run-card-error" title={run.error}>⛔ {run.error}</div>}
      {expanded && <RunDetail runId={run.runId} providerLabel={providerLabel} />}
    </div>
  )
}

export function AgentRunsPanel() {
  const path = useProject(s => s.path)
  const switchChatSession = useProject(s => s.switchChatSession)
  const setActiveView = useProject(s => s.setActiveView)
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [ownerFilter, setOwnerFilter] = useState<string>('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [providerMeta, setProviderMeta] = useState<Record<string, string>>({})

  useEffect(() => {
    void window.api.providers.list().then((list: ProviderDescriptorDTO[]) => {
      const map: Record<string, string> = {}
      for (const p of list) map[p.id] = p.shortLabel || p.name
      setProviderMeta(map)
    }).catch(() => { /* fallback на сырой id */ })
  }, [])

  const providerLabel = useCallback((id: string | null) => {
    if (!id) return '?'
    return providerMeta[id] ?? id
  }, [providerMeta])

  const refresh = useCallback(async () => {
    if (!path) return
    try {
      const list = await window.api.agentRuns.list(path)
      setRuns(list)
    } catch { /* IPC недоступен в dev — панель просто пустая */ }
  }, [path])

  // Поллинг раз в 2с пока панель открыта — живые статусы прогонов.
  useEffect(() => {
    void refresh()
    const t = setInterval(() => { if (!document.hidden) void refresh() }, 2000)
    return () => clearInterval(t)
  }, [refresh])

  // Stop (Фаза 4): прерываем прогон через тот же abort, что и кнопка ⏹ в чате,
  // затем сразу обновляем список (поллинг подхватит, но мгновенный refresh —
  // отзывчивее).
  const handleStop = useCallback((runId: string) => {
    void window.api.agentRuns.stop(runId).catch(() => {}).finally(() => void refresh())
  }, [refresh])

  // Resume (Фаза 4) = честный re-send (НЕ восстановление состояния). Берём
  // { chatId, userMessage } из run_inputs, переключаемся на этот чат + вкладку
  // «Чат» и диспатчим gg-resume-send — Chat.tsx сам отправит тем же текстом, как
  // при ручном вводе. Нет ввода / ошибка → тихо игнорируем (кнопки нет смысла).
  const handleResume = useCallback(async (runId: string) => {
    let res: { chatId: number | null; userMessage: string } | { error: string }
    try {
      res = await window.api.agentRuns.resume(runId)
    } catch { return }
    if ('error' in res) return
    const { chatId, userMessage } = res
    if (!userMessage) return
    try {
      if (chatId != null) await switchChatSession(chatId)
    } catch { /* переключение не критично — отправим в текущий активный чат */ }
    setActiveView('chat')
    // На следующий тик — даём чату перерендериться на нужной сессии до автоотправки.
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('gg-resume-send', { detail: userMessage }))
    }, 0)
  }, [switchChatSession, setActiveView])

  const filtered = useMemo(() => runs.filter(r =>
    (!statusFilter || r.status === statusFilter) &&
    (!ownerFilter || r.owner === ownerFilter)
  ), [runs, statusFilter, ownerFilter])

  // «Активно» = ещё не завершённые прогоны (в очереди / идут).
  const activeCount = runs.filter(r => r.status === 'running' || r.status === 'queued').length

  if (!path) {
    return (
      <div className="gg-panel">
        <div className="gg-panel-empty" style={{ marginTop: 80 }}>Открой проект чтобы видеть задачи</div>
      </div>
    )
  }

  return (
    <div className="gg-panel">
      <div className="gg-panel-header">
        <h2 className="gg-panel-title">Задачи</h2>
        <div className="gg-panel-meta">
          {runs.length} задач · {activeCount} активно
        </div>
      </div>

      <div className="gg-inspector-toolbar gg-agents-toolbar">
        <select className="gg-input gg-agents-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">Все статусы</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="gg-input gg-agents-select" value={ownerFilter} onChange={e => setOwnerFilter(e.target.value)}>
          <option value="">Все источники</option>
          {Object.entries(OWNER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <div className="gg-agents-toolbar-spacer" />
        <button className="gg-btn gg-btn-ghost" onClick={() => void refresh()}>↻</button>
      </div>

      <div className="gg-panel-body">
        {filtered.length === 0 ? (
          <div className="gg-agents-empty">
            <div className="gg-agents-empty-icon">🗂️</div>
            <div className="gg-agents-empty-title">Пока нет задач</div>
            <div className="gg-agents-empty-hint">
              Запусти агента в чате — каждый прогон появится здесь со статусом, деревом суб-агентов и затронутыми файлами.
            </div>
          </div>
        ) : (
          <div className="gg-run-list">
            {filtered.map(r => (
              <RunCard
                key={r.runId}
                run={r}
                providerLabel={providerLabel}
                expanded={expanded === r.runId}
                onToggle={() => setExpanded(prev => prev === r.runId ? null : r.runId)}
                onStop={handleStop}
                onResume={() => void handleResume(r.runId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
