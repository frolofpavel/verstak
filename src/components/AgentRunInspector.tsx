import { useEffect, useMemo, useState } from 'react'
import { useProject } from '../store/projectStore'
import { useT } from '../i18n'
import type { AgentRun, AuditEntry, DebugPacket, EnvelopeRestorePreview, EnvelopeRestoreResult } from '../types/api'
import { computeContextBudget } from '../lib/context-budget'
import { diffSections, diffLines, sectionMap, type SectionDiff, type SectionDiffStatus } from '../lib/context-diff'
import { runtimeCapability, secretProtectionLevel } from '../lib/runtime-capability'

/**
 * Agent Run Inspector — flagship transparency screen.
 *
 * Makes the agent's behavior VISIBLE: groups raw audit entries into "runs"
 * and shows, per run, the ordered sequence of what the agent did (tool calls,
 * file writes, commands, errors, provider switches, memory saves) with timing.
 *
 * Data source: window.api.audit (query/export). No new IPC — read-only over
 * the existing audit log.
 */

// Gap (ms) between consecutive entries above which we start a new run.
const RUN_GAP_MS = 2 * 60 * 1000

const ACTION_ICON: Record<string, string> = {
  tool_call: '🔧',
  tool_result: '📤',
  write_file: '✏️',
  run_command: '▶️',
  error: '⚠️',
  provider_switch: '🔀',
  memory_save: '🧠',
  session_start: '▶',
  session_end: '✓'
}

const ACTION_LABEL: Record<string, string> = {
  tool_call: 'вызов инструмента',
  tool_result: 'результат',
  write_file: 'правка файла',
  run_command: 'команда',
  error: 'ошибка',
  provider_switch: 'смена провайдера',
  memory_save: 'память',
  session_start: 'запуск AI',
  session_end: 'ответ завершён'
}

export interface Run {
  key: string
  runId: string | null
  entries: AuditEntry[]
  start: number
  end: number
  /** ACTUAL — кто реально завершил прогон. SSOT = agent_runs.provider_id/model
   *  (updateActual при fallback); audit — только best-effort fallback. */
  providerId: string | null
  model: string | null
  /** REQUESTED — что запросили. SSOT = agent_runs.requested_*; null там ⇒ стартовый
   *  маршрут из audit. Отличается от actual ⇒ был fallback (показываем ВИДИМО). */
  requestedProvider: string | null
  requestedModel: string | null
}

// Собрать Run из набора записей (общий хвост для обеих веток группировки).
// persistedRun — строка agent_runs, соединённая строго по runId (Proof-B).
export function buildRun(entries: AuditEntry[], key: string, persistedRun?: AgentRun | null): Run {
  const first = entries[0]
  const last = entries[entries.length - 1]
  // Audit-эвристика (best-effort): requested = ПЕРВЫЙ ненулевой провайдер/модель
  // (старт прогона = запрос); actual = ПОСЛЕДНИЙ ненулевой.
  let auditRequestedProvider: string | null = null
  let auditRequestedModel: string | null = null
  let auditProvider: string | null = first.providerId
  let auditModel: string | null = first.model
  for (const e of entries) {
    if (e.providerId) {
      if (auditRequestedProvider == null) auditRequestedProvider = e.providerId
      auditProvider = e.providerId
    }
    if (e.model) {
      if (auditRequestedModel == null) auditRequestedModel = e.model
      auditModel = e.model
    }
  }
  // Proof-B: agent_runs — SSOT маршрута. auditFn замыкает СТАРТОВЫЕ provider/model,
  // и рекурсивный fallback продолжает писать их в audit_log — audit нельзя считать
  // источником фактического маршрута. Непустые persisted-поля всегда в приоритете
  // над audit-эвристикой; audit — только fallback для null-полей и legacy-записей.
  // ACTUAL = кто фактически завершил прогон (updateActual при smart-fallback).
  const providerId = persistedRun?.providerId ?? auditProvider
  const model = persistedRun?.model ?? auditModel
  // REQUESTED = что запросили. persisted requested_* заполнен при явном route-override;
  // null ⇒ запрошенное == дефолт чата ⇒ берём стартовый маршрут из audit; если и там
  // пусто — actual, чтобы не рисовать ложный fallback.
  const requestedProvider = persistedRun?.requestedProviderId ?? auditRequestedProvider ?? providerId
  const requestedModel = persistedRun?.requestedModel ?? auditRequestedModel ?? model
  return {
    key,
    runId: entries[0].runId ?? null,
    entries,
    start: first.timestamp,
    end: last.timestamp,
    providerId,
    model,
    requestedProvider,
    requestedModel
  }
}

/**
 * Group entries into runs. Записи начиная с миграции 9 несут явный runId —
 * по нему и группируем (одна карточка = один runId). Легаси-строки без runId
 * группируются прежней эвристикой: сортировка по времени, разрыв при gap >
 * RUN_GAP_MS, смене chatId или маркере session_start.
 */
function groupRuns(entries: AuditEntry[], persistedByRunId?: Map<string, AgentRun>): Run[] {
  const withRunId = entries.filter(e => e.runId)
  const legacy = entries.filter(e => !e.runId)

  const runs: Run[] = []

  // Ветка с явным runId — группируем по нему, внутри run'а сортируем по времени.
  // Join с agent_runs — СТРОГО по runId (не по времени/chatId/позиции).
  const byRunId = new Map<string, AuditEntry[]>()
  for (const e of withRunId) {
    const list = byRunId.get(e.runId!) ?? []
    list.push(e)
    byRunId.set(e.runId!, list)
  }
  for (const [rid, list] of byRunId) {
    const sorted = [...list].sort((a, b) => a.timestamp - b.timestamp)
    runs.push(buildRun(sorted, `run-${rid}`, persistedByRunId?.get(rid) ?? null))
  }

  // Легаси-ветка — прежняя эвристика для строк до миграции 9.
  const sorted = [...legacy].sort((a, b) => a.timestamp - b.timestamp)
  let current: AuditEntry[] = []
  const flush = () => {
    if (current.length === 0) return
    const first = current[0]
    const last = current[current.length - 1]
    runs.push(buildRun(current, `${first.id}-${last.id}`))
    current = []
  }
  for (const e of sorted) {
    if (current.length > 0) {
      const prev = current[current.length - 1]
      const gap = e.timestamp - prev.timestamp
      const chatChanged = e.chatId !== prev.chatId
      if (gap > RUN_GAP_MS || chatChanged || e.action === 'session_start') {
        flush()
      }
    }
    current.push(e)
  }
  flush()

  // Newest run first — сортируем все run'ы (обе ветки) по времени старта.
  return runs.sort((a, b) => b.start - a.start)
}

function summarize(entries: AuditEntry[]): string {
  const counts: Record<string, number> = {}
  for (const e of entries) counts[e.action] = (counts[e.action] ?? 0) + 1
  const parts: string[] = []
  if (counts.write_file) parts.push(`${counts.write_file} ${plural(counts.write_file, 'правка', 'правки', 'правок')}`)
  if (counts.run_command) parts.push(`${counts.run_command} ${plural(counts.run_command, 'команда', 'команды', 'команд')}`)
  if (counts.tool_call) parts.push(`${counts.tool_call} ${plural(counts.tool_call, 'вызов', 'вызова', 'вызовов')}`)
  if (counts.provider_switch) parts.push(`${counts.provider_switch} ${plural(counts.provider_switch, 'переключение', 'переключения', 'переключений')}`)
  if (counts.memory_save) parts.push(`${counts.memory_save} в память`)
  if (counts.error) parts.push(`${counts.error} ${plural(counts.error, 'ошибка', 'ошибки', 'ошибок')}`)
  if (counts.session_end && parts.length === 0) parts.push('ответ получен')
  if (counts.session_start && parts.length === 0) parts.push('запуск начат')
  return parts.length ? parts.join(', ') : `${entries.length} событий`
}

// Russian plural picker (1 правка / 2 правки / 5 правок).
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatClock(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}мс`
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}с`
  const min = Math.floor(sec / 60)
  const rem = sec % 60
  return `${min}м ${rem}с`
}

// Pretty-print JSON-ish detail; otherwise truncate.
function formatDetail(detail: string, action?: string): string {
  const trimmed = detail.trim()
  if ((action === 'session_start' || action === 'session_end') && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try {
      const data = JSON.parse(trimmed) as Record<string, unknown>
      if (action === 'session_start') {
        const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : 'без текста запроса'
        const model = typeof data.model === 'string' && data.model.trim() ? ` · ${data.model.trim()}` : ''
        return `Запрос: ${title}${model}`
      }
      const status = typeof data.status === 'string' && data.status.trim() ? data.status.trim() : 'завершено'
      const chars = typeof data.assistantChars === 'number' ? data.assistantChars : null
      const duration = typeof data.durationMs === 'number' ? formatDuration(data.durationMs) : null
      return [
        `Статус: ${status}`,
        duration ? `время ${duration}` : null,
        chars !== null ? `ответ ${chars} ${plural(chars, 'символ', 'символа', 'символов')}` : null
      ].filter(Boolean).join(' · ')
    } catch {
      // fall through to raw
    }
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2)
    } catch {
      // fall through to raw
    }
  }
  return trimmed
}

// Честные подписи отказов отката.
const RESTORE_REASON_RU: Record<string, string> = {
  'not-git': 'Проект вне git — откатить нечем.',
  'no-anchor': 'Якорь отката не сохранён (старый прогон или не-git).',
  'moved-on': 'Репозиторий ушёл вперёд (есть коммит поверх якоря) — авто-откат отменён, чтобы не тронуть новую историю.',
  'error': 'Ошибка git.',
}

// Control Envelope Restore (1.9.6 #1): недеструктивный preview → подтверждение → результат.
function EnvelopeRestorePanel({ state, onConfirm, onClose }: {
  runId: string
  state: { phase: 'idle' | 'preview' | 'busy' | 'done'; preview?: EnvelopeRestorePreview; result?: EnvelopeRestoreResult }
  onConfirm: () => void
  onClose: () => void
}) {
  const { phase, preview, result } = state
  return (
    <div className="gg-envelope-restore">
      {phase === 'busy' && <div className="gg-envelope-restore-row">Обрабатываю…</div>}

      {phase === 'preview' && preview && !preview.ok && (
        <div className="gg-envelope-restore-row is-warn">
          <span>⚠️ {RESTORE_REASON_RU[preview.reason ?? 'error']}</span>
          <button className="gg-btn gg-btn-ghost" onClick={onClose}>Закрыть</button>
        </div>
      )}

      {phase === 'preview' && preview && preview.ok && (
        <div className="gg-envelope-restore-body">
          <div className="gg-envelope-restore-title">
            Откат к якорю <code>{(preview.gitHead ?? '').slice(0, 7)}</code>
            {preview.hasStash && ' + возврат грязных pre-run правок'}
          </div>
          <div className="gg-envelope-restore-note">
            Отслеживаемых файлов изменится: <b>{preview.changedFiles?.length ?? 0}</b>.
            {(preview.untrackedFiles?.length ?? 0) > 0 && ` Новых untracked-файлов (${preview.untrackedFiles!.length}) откат НЕ удалит — их убираешь сам.`}
          </div>
          {(preview.changedFiles?.length ?? 0) > 0 && (
            <pre className="gg-envelope-restore-files">{preview.changedFiles!.slice(0, 30).join('\n')}{(preview.changedFiles!.length > 30) ? `\n…ещё ${preview.changedFiles!.length - 30}` : ''}</pre>
          )}
          <div className="gg-envelope-restore-actions">
            <button className="gg-btn gg-btn-danger" onClick={onConfirm}>Откатить правки CLI</button>
            <button className="gg-btn gg-btn-ghost" onClick={onClose}>Отмена</button>
          </div>
        </div>
      )}

      {phase === 'done' && result && (
        <div className={`gg-envelope-restore-row ${result.ok ? 'is-ok' : 'is-warn'}`}>
          <span>
            {result.ok
              ? `✓ Откачено: ${result.restoredFiles?.length ?? 0} файлов${result.stashApplied ? ' + снапшот грязных правок' : ''}.${(result.untrackedKept?.length ?? 0) > 0 ? ` Untracked (${result.untrackedKept!.length}) оставлены.` : ''}`
              : `⚠️ ${RESTORE_REASON_RU[result.reason ?? 'error']}`}
          </span>
          <button className="gg-btn gg-btn-ghost" onClick={onClose}>Закрыть</button>
        </div>
      )}
    </div>
  )
}

function RunCard({ run, onShowPacket }: { run: Run; onShowPacket: (runId: string) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const hasError = run.entries.some(e => e.action === 'error')
  // Control Envelope Restore (1.9.6 #1): откат CLI-прогона к git-якорю.
  const [restore, setRestore] = useState<{ phase: 'idle' | 'preview' | 'busy' | 'done'; preview?: EnvelopeRestorePreview; result?: EnvelopeRestoreResult }>({ phase: 'idle' })
  // Честный уровень контроля этого прогона: CLI-прогон НЕ был «полным контролем».
  const isCli = (run.providerId ?? '').endsWith('-cli')
  const cap = runtimeCapability(run.providerId ?? '', isCli ? 'CLI' : 'API')
  const tierBadge = cap.tier === 'observed'
    ? { label: t.runtime.observedLabel, hint: t.runtime.observedHint }
    : cap.tier === 'limited'
      ? { label: t.runtime.limitedLabel, hint: t.runtime.limitedHint }
      : null
  // Честная защита секретов прогона (1.9.6 #2) — только для CLI, кроме full.
  const secLevel = isCli ? secretProtectionLevel(run.providerId ?? '') : 'full'
  const secBadge = secLevel === 'partial'
    ? { label: t.secretProtection.partialLabel, hint: t.secretProtection.partialHint, tone: 'warn' }
    : secLevel === 'none'
      ? { label: t.secretProtection.noneLabel, hint: t.secretProtection.noneHint, tone: 'danger' }
      : null
  return (
    <div className={`gg-run-card ${hasError ? 'has-error' : ''}`}>
      <div className="gg-run-head-row">
        <button className="gg-run-head" onClick={() => setOpen(v => !v)}>
          <span className="gg-run-caret">{open ? '▾' : '▸'}</span>
          <span className="gg-run-provider">{run.providerId ?? 'неизвестно'}</span>
          {run.model && <span className="gg-run-model">{run.model}</span>}
          {((run.requestedProvider && run.requestedProvider !== run.providerId) ||
            (run.requestedModel && run.requestedModel !== run.model)) && (
            /* Proof-B: fallback ВИДИМО (не в tooltip) — что запросили vs что реально отработало. */
            <span className="gg-run-fallback">
              ⇄ запрошен {run.requestedProvider ?? run.providerId ?? '?'}
              {run.requestedModel && run.requestedModel !== run.model ? ` · ${run.requestedModel}` : ''}
            </span>
          )}
          {tierBadge && <span className={`gg-run-tier is-${cap.tier}`} title={tierBadge.hint}>{tierBadge.label}</span>}
          {secBadge && <span className={`gg-run-tier is-sec-${secBadge.tone}`} title={secBadge.hint}>{secBadge.label}</span>}
          <span className="gg-run-time">{formatTime(run.start)}</span>
          <span className="gg-run-summary">{summarize(run.entries)}</span>
          <span className="gg-run-count">{run.entries.length} · {formatDuration(run.end - run.start)}</span>
        </button>
        {run.runId && isCli && (
          <button
            className="gg-run-packet-btn"
            title="Откатить правки этого CLI-прогона к git-якорю (контрольная точка перед прогоном)"
            onClick={() => {
              void (async () => {
                setRestore({ phase: 'busy' })
                try {
                  const p = await window.api.agentRuns.envelopePreview(run.runId!)
                  setRestore({ phase: 'preview', preview: p })
                } catch { setRestore({ phase: 'idle' }) }
              })()
            }}
          >↩︎ Откатить</button>
        )}
        {run.runId && (
          <button
            className="gg-run-packet-btn"
            title="Debug Packet — что реально ушло в модель"
            onClick={() => onShowPacket(run.runId!)}
          >🐛 Пакет</button>
        )}
      </div>
      {restore.phase !== 'idle' && (
        <EnvelopeRestorePanel
          runId={run.runId!}
          state={restore}
          onConfirm={() => {
            void (async () => {
              setRestore(s => ({ ...s, phase: 'busy' }))
              try {
                const r = await window.api.agentRuns.envelopeRestore(run.runId!)
                setRestore(s => ({ phase: 'done', preview: s.preview, result: r }))
              } catch { setRestore(s => ({ ...s, phase: 'preview' })) }
            })()
          }}
          onClose={() => setRestore({ phase: 'idle' })}
        />
      )}
      {open && (
        <div className="gg-run-steps">
          {run.entries.map(e => (
            <div key={e.id} className={`gg-run-step is-${e.action}`}>
              <span className="gg-run-step-icon" aria-hidden>{ACTION_ICON[e.action] ?? '·'}</span>
              <span className="gg-run-step-clock">{formatClock(e.timestamp)}</span>
              <span className="gg-run-step-action">{ACTION_LABEL[e.action] ?? e.action}</span>
              {e.detail && <pre className="gg-run-step-detail">{formatDetail(e.detail, e.action)}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Бюджет контекста — разбивка composed system-промпта по слоям с оценкой токенов.
function ContextBudgetView({ packet }: { packet: DebugPacket }) {
  const budget = useMemo(() => {
    if (!packet.input) return null
    return computeContextBudget(packet.input.systemPrompt, packet.input.userMessage, packet.messages)
  }, [packet])

  if (!budget || budget.sections.length === 0) return null

  return (
    <div className="gg-budget">
      <div className="gg-debug-section-title">Бюджет контекста</div>
      <div className="gg-budget-rows">
        {budget.sections.map(s => {
          const pct = budget.totalTokens > 0 ? Math.round((s.tokens / budget.totalTokens) * 100) : 0
          return (
            <div key={s.label} className="gg-budget-row">
              <span className="gg-budget-label">{s.label}</span>
              <span className="gg-budget-bar"><span className="gg-budget-bar-fill" style={{ width: `${pct}%` }} /></span>
              <span className="gg-budget-tokens">≈{s.tokens.toLocaleString('ru-RU')} ток · {pct}%</span>
            </div>
          )
        })}
      </div>
      <div className="gg-budget-total">≈ {budget.totalTokens.toLocaleString('ru-RU')} токенов суммарно</div>
      {budget.compacted && (
        <div className="gg-budget-note">⚠️ часть истории сжата (sliding window)</div>
      )}
    </div>
  )
}

// Подписи и стили статусов диффа секции.
const DIFF_STATUS_LABEL: Record<SectionDiffStatus, string> = {
  same: 'без изменений',
  changed: 'изменился',
  added: 'добавлен',
  removed: 'удалён'
}

// Развёрнутый построчный дифф одной изменившейся секции.
function SectionLineDiff({ from, to }: { from: string; to: string }) {
  const lines = useMemo(() => diffLines(from, to), [from, to])
  return (
    <pre className="gg-diff-lines">
      {lines.map((l, i) => (
        <div key={i} className={`gg-diff-line is-${l.type}`}>
          <span className="gg-diff-sign">{l.type === 'add' ? '+' : l.type === 'remove' ? '−' : ' '}</span>
          <span className="gg-diff-text">{l.text || ' '}</span>
        </div>
      ))}
    </pre>
  )
}

// Одна строка-секция в сводке диффа + разворачиваемая детализация.
function SectionDiffRow({ diff, textA, textB }: { diff: SectionDiff; textA: string | null; textB: string | null }) {
  const [open, setOpen] = useState(false)
  const expandable = diff.status === 'changed'
  const delta =
    diff.status === 'changed' || diff.status === 'added' || diff.status === 'removed'
      ? `+${diff.addedChars} / −${diff.removedChars} симв.`
      : ''
  return (
    <div className={`gg-diff-row is-${diff.status}`}>
      <button
        className="gg-diff-row-head"
        onClick={() => expandable && setOpen(v => !v)}
        disabled={!expandable}
      >
        {expandable && <span className="gg-diff-caret">{open ? '▾' : '▸'}</span>}
        <span className="gg-diff-label">{diff.label}</span>
        <span className={`gg-diff-status is-${diff.status}`}>{DIFF_STATUS_LABEL[diff.status]}</span>
        {delta && <span className="gg-diff-delta">{delta}</span>}
      </button>
      {open && expandable && <SectionLineDiff from={textB ?? ''} to={textA ?? ''} />}
    </div>
  )
}

/**
 * Дифф входов между текущим запуском и выбранным другим. Тянет пакет другого
 * run'а через тот же window.api.debug.packet — без нового IPC.
 */
function RunDiffView({ packet, runs }: { packet: DebugPacket; runs: Run[] }) {
  const [otherId, setOtherId] = useState<string>('')
  const [otherPacket, setOtherPacket] = useState<DebugPacket | null>(null)
  const [loading, setLoading] = useState(false)

  // Кандидаты на сравнение — остальные run'ы с runId, кроме текущего.
  const currentId = packet.input?.runId ?? null
  const options = useMemo(
    () => runs.filter(r => r.runId && r.runId !== currentId),
    [runs, currentId]
  )

  // Смена текущего пакета сбрасывает выбор сравнения.
  useEffect(() => {
    setOtherId('')
    setOtherPacket(null)
  }, [currentId])

  async function pick(id: string) {
    setOtherId(id)
    setOtherPacket(null)
    if (!id) return
    setLoading(true)
    try {
      const p = await window.api.debug.packet(id)
      setOtherPacket(p)
    } catch {
      setOtherPacket(null)
    } finally {
      setLoading(false)
    }
  }

  const diffs = useMemo(() => {
    if (!packet.input || !otherPacket?.input) return null
    return diffSections(
      { systemPrompt: packet.input.systemPrompt, userMessage: packet.input.userMessage },
      { systemPrompt: otherPacket.input.systemPrompt, userMessage: otherPacket.input.userMessage }
    )
  }, [packet, otherPacket])

  // Карты текстов секций обоих запусков — для построчной детализации.
  const textsA = useMemo(
    () => (packet.input ? sectionMap({ systemPrompt: packet.input.systemPrompt, userMessage: packet.input.userMessage }) : new Map<string, string>()),
    [packet]
  )
  const textsB = useMemo(
    () => (otherPacket?.input ? sectionMap({ systemPrompt: otherPacket.input.systemPrompt, userMessage: otherPacket.input.userMessage }) : new Map<string, string>()),
    [otherPacket]
  )

  if (!packet.input || options.length === 0) return null

  const changedCount = diffs ? diffs.filter(d => d.status !== 'same').length : 0

  return (
    <div className="gg-diff">
      <div className="gg-debug-section-title">Сравнение входов между запусками</div>
      <div className="gg-diff-picker">
        <label className="gg-diff-picker-label">Сравнить с запуском…</label>
        <select
          className="gg-input gg-diff-select"
          value={otherId}
          onChange={e => void pick(e.target.value)}
        >
          <option value="">— выбрать —</option>
          {options.map(r => (
            <option key={r.runId!} value={r.runId!}>
              {(r.providerId ?? '?')} · {(r.model ?? '?')} · {formatTime(r.start)}
            </option>
          ))}
        </select>
        {loading && <span className="gg-diff-loading">Загрузка…</span>}
      </div>

      {otherId && !loading && otherPacket && !otherPacket.input && (
        <div className="gg-panel-empty">Снапшот входа не сохранён для выбранного запуска.</div>
      )}

      {diffs && (
        <>
          <div className="gg-diff-summary-meta">
            {changedCount === 0
              ? 'Входы идентичны по всем слоям.'
              : `Изменений по слоям: ${changedCount} из ${diffs.length}`}
          </div>
          <div className="gg-diff-rows">
            {diffs.map(d => (
              <SectionDiffRow
                key={d.label}
                diff={d}
                textA={textsA.get(d.label) ?? null}
                textB={textsB.get(d.label) ?? null}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export function AgentRunInspector() {
  const { path } = useProject()
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [agentRuns, setAgentRuns] = useState<AgentRun[]>([])
  const [loading, setLoading] = useState(false)
  const [csv, setCsv] = useState<string | null>(null)
  const [packet, setPacket] = useState<DebugPacket | null>(null)

  async function refresh() {
    if (!path) return
    setLoading(true)
    try {
      // Proof-B: audit (последовательность действий) + agent_runs (persisted
      // requested/actual маршрут) грузим параллельно. Деградация безопасна:
      // падение agentRuns.list не роняет экран — остаёмся на audit-эвристике.
      const [list, runsList] = await Promise.all([
        window.api.audit.query(path, { limit: 500 }),
        window.api.agentRuns.list(path, { limit: 500 }).catch(() => [] as AgentRun[])
      ])
      setEntries(list)
      setAgentRuns(runsList)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [path])

  // Join audit-run'ов с persisted agent_runs — СТРОГО по runId.
  const persistedByRunId = useMemo(() => new Map(agentRuns.map(r => [r.runId, r])), [agentRuns])
  const runs = useMemo(() => groupRuns(entries, persistedByRunId), [entries, persistedByRunId])

  if (!path) {
    return (
      <div className="gg-panel">
        <div className="gg-panel-empty" style={{ marginTop: 80 }}>Открой проект, чтобы видеть историю работы AI</div>
      </div>
    )
  }

  async function exportCsv() {
    const data = await window.api.audit.export(path!)
    setCsv(data)
  }

  async function copyCsv() {
    if (csv) await navigator.clipboard.writeText(csv)
  }

  // Debug Packet — реальный вход запуска (system-промпт + сообщение + audit trail).
  async function showPacket(runId: string) {
    try {
      const p = await window.api.debug.packet(runId)
      setPacket(p)
    } catch { /* проглатываем — пакет просто не откроется */ }
  }

  return (
    <div className="gg-panel">
      <div className="gg-panel-header">
        <h2 className="gg-panel-title">История работы AI</h2>
        <div className="gg-panel-meta">
          Запуски модели в текущем проекте: ответы, инструменты, ошибки и диагностические события · {runs.length} запусков · {entries.length} событий
        </div>
      </div>

      <div className="gg-inspector-toolbar">
        <button className="gg-btn gg-btn-ghost" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Загрузка…' : 'Обновить'}
        </button>
        <button className="gg-btn gg-btn-ghost" onClick={() => void exportCsv()} disabled={entries.length === 0}>
          Экспорт CSV
        </button>
      </div>

      <div className="gg-panel-body">
        {entries.length === 0 && (
          <div className="gg-panel-empty">
            Пока нет записей. Отправь сообщение модели в этом проекте — после ответа здесь появится запуск AI
          </div>
        )}

        <div className="gg-run-list">
          {runs.map(run => <RunCard key={run.key} run={run} onShowPacket={runId => void showPacket(runId)} />)}
        </div>
      </div>

      {csv !== null && (
        <div className="gg-inspector-csv-overlay" onClick={() => setCsv(null)}>
          <div className="gg-inspector-csv-modal" onClick={e => e.stopPropagation()}>
            <div className="gg-inspector-csv-head">
              <span>CSV — журнал аудита</span>
              <div className="gg-inspector-csv-actions">
                <button className="gg-btn gg-btn-ghost" onClick={() => void copyCsv()}>Скопировать</button>
                <button className="gg-btn gg-btn-ghost" onClick={() => setCsv(null)}>Закрыть</button>
              </div>
            </div>
            <textarea className="gg-input gg-inspector-csv-text" readOnly value={csv} />
          </div>
        </div>
      )}

      {packet !== null && (
        <div className="gg-inspector-csv-overlay" onClick={() => setPacket(null)}>
          <div className="gg-debug-modal" onClick={e => e.stopPropagation()}>
            <div className="gg-inspector-csv-head">
              <span>Диагностический пакет{packet.input ? ` — ${packet.input.providerId ?? '?'} · ${packet.input.model ?? '?'}` : ''}</span>
              <div className="gg-inspector-csv-actions">
                <button className="gg-btn gg-btn-ghost" onClick={() => void navigator.clipboard.writeText(JSON.stringify(packet, null, 2))}>Скопировать JSON</button>
                <button className="gg-btn gg-btn-ghost" onClick={() => setPacket(null)}>Закрыть</button>
              </div>
            </div>
            <div className="gg-debug-body">
              {!packet.input && (
                <div className="gg-panel-empty">Снапшот входа не сохранён для этого запуска (до миграции или CLI-провайдер).</div>
              )}
              {packet.input && (
                <>
                  <ContextBudgetView packet={packet} />
                  <RunDiffView packet={packet} runs={runs} />
                  <div className="gg-debug-section-title">Системный промпт — что реально ушло в модель</div>
                  <pre className="gg-debug-pre">{packet.input.systemPrompt}</pre>
                  <div className="gg-debug-section-title">Сообщение пользователя</div>
                  <pre className="gg-debug-pre">{packet.input.userMessage}</pre>
                </>
              )}
              <div className="gg-debug-section-title">Трейл действий ({packet.audit.length})</div>
              <pre className="gg-debug-pre">{packet.audit.map(a => `${formatClock(a.timestamp)}  ${a.action}  ${a.detail ?? ''}`).join('\n') || '—'}</pre>
              <div className="gg-debug-meta">Сообщений чата в пакете: {packet.messages.length}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
