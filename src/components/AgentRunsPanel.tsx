import { useEffect, useMemo, useState, useCallback } from 'react'
import { useProject } from '../store/projectStore'
import { useT } from '../i18n'
import type { Translations } from '../i18n'
import type { AgentRun, AgentRunEvent, AgentRunDetail, SubSession, SessionTodo, ProviderDescriptorDTO } from '../types/api'
import { buildAgentTree, type TreeNode } from '../lib/agent-tree'
import { EmptyState } from './EmptyState'

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

function formatLiveProgress(run: AgentRun, t: Translations): string | null {
  if (run.status === 'queued') {
    return t.agentRuns.liveQueued.replace('{duration}', fmtDuration(run.startedAt, run.endedAt))
  }
  if (run.status !== 'running') return null
  const dur = fmtDuration(run.startedAt, run.endedAt)
  const turnPart = run.turnIndex > 0
    ? t.agentRuns.liveTurn.replace('{n}', String(run.turnIndex))
    : t.agentRuns.liveStarting
  if (run.lastToolName) {
    return `${turnPart} · ${t.agentRuns.liveNow.replace('{tool}', run.lastToolName)} · ${dur}`
  }
  return `${turnPart} · ${dur}`
}

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

function RunDetail({ runId, providerLabel }: { runId: string; providerLabel: (id: string | null) => string }) {
  const t = useT()
  const [detail, setDetail] = useState<AgentRunDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [proofMsg, setProofMsg] = useState<string | null>(null)
  const [proofBusy, setProofBusy] = useState(false)
  const [captureMsg, setCaptureMsg] = useState<string | null>(null)
  const [captureBusy, setCaptureBusy] = useState(false)
  const setPreviewArtifact = useProject(s => s.setPreviewArtifact)

  // Proof Pack — собрать доказательство прогона (proof.json + .html) и показать
  // его в embedded-preview приложения (как html-артефакт).
  const genProof = useCallback(async () => {
    setProofBusy(true); setProofMsg(null)
    try {
      const res = await window.api.proof.generate(runId)
      if (res.ok && res.htmlPath) {
        setPreviewArtifact(res.htmlPath)
        setProofMsg('✓ Proof Pack собран')
      } else {
        setProofMsg(`Не удалось собрать: ${res.error ?? 'ошибка'}`)
      }
    } catch {
      setProofMsg('Не удалось собрать Proof Pack')
    }
    setProofBusy(false)
  }, [runId, setPreviewArtifact])

  const exportProofPdf = useCallback(async () => {
    setProofBusy(true); setProofMsg(null)
    try {
      const res = await window.api.proof.exportPdf(runId)
      setProofMsg(res.ok && res.pdfPath
        ? `✓ PDF Proof Pack собран: ${res.pdfPath}`
        : `Не удалось собрать PDF: ${res.error ?? 'ошибка'}`)
    } catch {
      setProofMsg('Не удалось собрать PDF Proof Pack')
    }
    setProofBusy(false)
  }, [runId])

  const sendProofTelegram = useCallback(async () => {
    setProofBusy(true); setProofMsg(null)
    try {
      const res = await window.api.proof.sendTelegram(runId)
      setProofMsg(res.ok
        ? '✓ Proof Pack отправлен в Telegram'
        : `Не удалось отправить в Telegram: ${res.error ?? 'ошибка'}`)
    } catch {
      setProofMsg('Не удалось отправить Proof Pack в Telegram')
    }
    setProofBusy(false)
  }, [runId])

  // Skill Capture: сохранить этот прогон как скилл-скаффолд в ~/.verstak/skills/.
  // Это черновик — пользователь правит перед использованием (human-approve).
  const captureSkill = useCallback(async () => {
    const title = detail?.run?.title
    if (!title) return
    setCaptureBusy(true); setCaptureMsg(null)
    try {
      const touched = Array.from(new Set(
        (detail?.events ?? []).filter(e => e.kind === 'file_write').map(e => e.ref ?? e.label).filter((p): p is string => !!p)
      ))
      const summary = touched.length ? `Изменил файлы: ${touched.slice(0, 8).join(', ')}.` : undefined
      const res = await window.api.skills.capture({ title, summary })
      setCaptureMsg(res.ok ? `✓ Скилл «${res.id}» сохранён — поправь в ~/.verstak/skills/` : `Не удалось: ${res.error}`)
    } catch {
      setCaptureMsg('Не удалось сохранить скилл')
    }
    setCaptureBusy(false)
  }, [detail])

  const load = useCallback(async () => {
    try {
      const d = await window.api.agentRuns.get(runId)
      setDetail(d)
    } catch { /* IPC недоступен в dev */ }
    setLoading(false)
  }, [runId])

  useEffect(() => {
    void load()
    const timer = setInterval(() => { if (!document.hidden) void load() }, 2000)
    return () => clearInterval(timer)
  }, [load])

  if (loading && !detail) {
    return <div className="gg-run-detail"><div className="gg-panel-empty">{t.agentRuns.loading}</div></div>
  }

  const events: AgentRunEvent[] = detail?.events ?? []
  const subs: SubSession[] = detail?.subs ?? []
  const todos: SessionTodo[] = detail?.todos ?? []

  const files = events
    .filter(e => e.kind === 'file_write')
    .map(e => e.ref ?? e.label)
    .filter((p): p is string => !!p)
  const uniqueFiles = Array.from(new Set(files))
  const verifyEvents = events.filter(e => e.kind === 'verify')
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
        <button
          type="button"
          className="gg-btn gg-btn-sm"
          onClick={() => void exportProofPdf()}
          disabled={proofBusy}
          title="Собрать PDF-файл Proof Pack рядом с proof.json/html/md"
        >
          PDF
        </button>
        <button
          type="button"
          className="gg-btn gg-btn-sm"
          onClick={() => void sendProofTelegram()}
          disabled={proofBusy}
          title="Отправить PDF Proof Pack в Telegram через настроенный telegram_notify_chat_id"
        >
          Telegram
        </button>
        <button
          type="button"
          className="gg-btn gg-btn-sm"
          onClick={() => void captureSkill()}
          disabled={captureBusy || !detail?.run?.title}
          title="Сохранить этот прогон как скилл-скаффолд в ~/.verstak/skills/ — черновик для редактирования (human approve)"
        >
          ⭐ {captureBusy ? 'Сохраняю…' : 'В скилл'}
        </button>
        {proofMsg && <span className="gg-run-proof-msg">{proofMsg}</span>}
        {captureMsg && <span className="gg-run-proof-msg">{captureMsg}</span>}
      </div>
      {/* (1) Timeline событий */}
      <div className="gg-run-section">
        <div className="gg-run-section-title">{t.agentRuns.timeline}</div>
        {events.length === 0 ? (
          <div className="gg-run-section-empty">{t.agentRuns.timelineEmpty}</div>
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

      <div className="gg-run-section">
        <div className="gg-run-section-title">{t.agentRuns.subs.replace('{count}', String(subs.length))}</div>
        {subs.length === 0 ? (
          <div className="gg-run-section-empty">{t.agentRuns.subsEmpty}</div>
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

      <div className="gg-run-section">
        <div className="gg-run-section-title">{t.agentRuns.files.replace('{count}', String(uniqueFiles.length))}</div>
        {uniqueFiles.length === 0 ? (
          <div className="gg-run-section-empty">{t.agentRuns.filesEmpty}</div>
        ) : (
          <div className="gg-run-files">
            {uniqueFiles.map(f => (
              <button
                key={f}
                className="gg-run-file"
                title={t.agentRuns.revealFile.replace('{path}', f)}
                onClick={() => void window.api.files.revealInExplorer(f).catch(() => {})}
              >
                📄 {f}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="gg-run-section">
        <div className="gg-run-section-title">{t.agentRuns.verify}</div>
        {verifyEvents.length === 0 ? (
          <div className="gg-run-section-empty">{t.agentRuns.verifyEmpty}</div>
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
          <div className="gg-run-section-title">
            {t.agentRuns.todo
              .replace('{done}', String(todos.filter(todo => todo.status === 'done').length))
              .replace('{total}', String(todos.length))}
          </div>
          <div className="gg-todogate-list">
            {todos.map(todo => (
              <div key={todo.id} className={`gg-todo-item is-${todo.status}`} title={todo.goal ?? ''}>
                <span className="gg-todo-icon">
                  {todo.status === 'done' ? '✅' : todo.status === 'in_progress' ? '⏳' : todo.status === 'blocked' ? '⛔' : '○'}
                </span>
                <span className="gg-todo-title">{todo.title}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function RunCard({ run, providerLabel, expanded, onToggle, onStop, onResume }: {
  run: AgentRun
  providerLabel: (id: string | null) => string
  expanded: boolean
  onToggle: () => void
  onStop: (runId: string) => void
  onResume: (runId: string, status: string) => void
}) {
  const t = useT()
  const cost = fmtCost(run.costCents)
  const liveProgress = formatLiveProgress(run, t)
  const canStop = run.status === 'running' || run.status === 'queued'
  const canResume = run.status === 'failed' || run.status === 'stopped' || run.status === 'suspended' || run.status === 'interrupted'
  const ownerLabel = t.agentRuns.owner[run.owner as keyof typeof t.agentRuns.owner] ?? run.owner

  return (
    <div className={`gg-run-card is-${run.status}${expanded ? ' is-expanded' : ''}`}>
      <button className="gg-run-card-head" onClick={onToggle}>
        <span className={`gg-agent-status-dot is-${run.status}`} />
        <span className="gg-run-card-title" title={run.title}>{run.title}</span>
        <span className={`gg-run-owner is-${run.owner}`}>{ownerLabel}</span>
        <span className="gg-run-card-provider">{providerLabel(run.providerId)}{run.model ? ` · ${run.model}` : ''}</span>
        <span className="gg-run-card-meta">
          {run.agentsCount > 0 && <span className="gg-run-stat" title="sub-agents">🤖{run.agentsCount}</span>}
          {run.toolCount > 0 && <span className="gg-run-stat" title="tools">🔧{run.toolCount}</span>}
          {run.filesCount > 0 && <span className="gg-run-stat" title="files">📄{run.filesCount}</span>}
          {cost && <span className="gg-run-stat gg-run-stat-cost">{cost}</span>}
          {!liveProgress && (
            <span className="gg-run-stat gg-run-stat-dur">{fmtDuration(run.startedAt, run.endedAt)}</span>
          )}
          {canStop && (
            <span
              className="gg-run-action gg-run-action-stop"
              role="button"
              tabIndex={0}
              title={t.agentRuns.stop}
              onClick={(e) => { e.stopPropagation(); onStop(run.runId) }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onStop(run.runId) } }}
            >⏹</span>
          )}
          {canResume && (
            <span
              className="gg-run-action gg-run-action-resume"
              role="button"
              tabIndex={0}
              title={run.status === 'suspended' ? 'Продолжить с момента приостановки' : t.agentRuns.resendTitle}
              onClick={(e) => { e.stopPropagation(); onResume(run.runId, run.status) }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onResume(run.runId, run.status) } }}
            >{run.status === 'suspended' ? '↻ Продолжить' : t.agentRuns.resend}</span>
          )}
          <span className="gg-run-card-caret">{expanded ? '▾' : '▸'}</span>
        </span>
      </button>
      {liveProgress && (
        <div className="gg-run-live" aria-live="polite">
          <span className="gg-run-live-dot" aria-hidden />
          <span className="gg-run-live-text">{liveProgress}</span>
        </div>
      )}
      {run.error && <div className="gg-run-card-error" title={run.error}>⛔ {run.error}</div>}
      {expanded && <RunDetail runId={run.runId} providerLabel={providerLabel} />}
    </div>
  )
}

export function AgentRunsPanel() {
  const t = useT()
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
    }).catch(() => {})
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
    } catch { /* IPC недоступен в dev */ }
  }, [path])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { if (!document.hidden) void refresh() }, 2000)
    return () => clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    const handler = (event: Event) => {
      const runId = (event as CustomEvent<string>).detail
      if (typeof runId === 'string' && runId) setExpanded(runId)
    }
    window.addEventListener('gg-open-agent-run', handler)
    return () => window.removeEventListener('gg-open-agent-run', handler)
  }, [])

  const handleStop = useCallback((runId: string) => {
    void window.api.agentRuns.stop(runId).catch(() => {}).finally(() => void refresh())
  }, [refresh])

  const handleResume = useCallback(async (runId: string, status?: string) => {
    let res: { chatId: number | null; userMessage: string } | { error: string }
    try {
      res = await window.api.agentRuns.resume(runId)
    } catch { return }
    if ('error' in res) return
    const { chatId, userMessage } = res
    if (!userMessage) return
    try {
      if (chatId != null) await switchChatSession(chatId)
    } catch { /* non-critical */ }
    setActiveView('chat')
    setTimeout(() => {
      // #4 suspend: приостановленный прогон ПРОДОЛЖАЕМ с чекпойнта (resumeFromRunId),
      // а не пере-слать сначала; failed/stopped — обычный re-send исходного запроса.
      const detail = status === 'suspended'
        ? { text: userMessage, resumeFromRunId: runId }
        : userMessage
      window.dispatchEvent(new CustomEvent('gg-resume-send', { detail }))
    }, 0)
  }, [switchChatSession, setActiveView])

  const filtered = useMemo(() => runs.filter(r =>
    (!statusFilter || r.status === statusFilter) &&
    (!ownerFilter || r.owner === ownerFilter)
  ), [runs, statusFilter, ownerFilter])

  const activeCount = runs.filter(r => r.status === 'running' || r.status === 'queued').length

  if (!path) {
    return (
      <div className="gg-panel">
        <div className="gg-panel-empty" style={{ marginTop: 80 }}>{t.agentRuns.openProject}</div>
      </div>
    )
  }

  return (
    <div className="gg-panel">
      <div className="gg-panel-header">
        <h2 className="gg-panel-title">{t.agentRuns.title}</h2>
        <div className="gg-panel-meta">
          {t.agentRuns.meta.replace('{total}', String(runs.length)).replace('{active}', String(activeCount))}
        </div>
      </div>

      <div className="gg-inspector-toolbar gg-agents-toolbar">
        <select className="gg-input gg-agents-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">{t.agentRuns.allStatuses}</option>
          {Object.entries(t.agentRuns.status).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="gg-input gg-agents-select" value={ownerFilter} onChange={e => setOwnerFilter(e.target.value)}>
          <option value="">{t.agentRuns.allSources}</option>
          {Object.entries(t.agentRuns.owner).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <div className="gg-agents-toolbar-spacer" />
        <button className="gg-btn gg-btn-ghost" onClick={() => void refresh()}>↻</button>
      </div>

      <div className="gg-panel-body">
        {filtered.length === 0 ? (
          <EmptyState
            icon="🗂️"
            title={t.agentRuns.emptyTitle}
            hint={t.agentRuns.emptyHint}
            className="gg-agents-empty"
          />
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
                onResume={(id, status) => void handleResume(id, status)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
