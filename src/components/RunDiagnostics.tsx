import { useCallback, useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'
import type { AgentRun, DebugPacket, EnvelopeRestorePreview, EnvelopeRestoreResult } from '../types/api'
import { computeContextBudget } from '../lib/context-budget'
import { runtimeCapability, secretProtectionLevel } from '../lib/runtime-capability'
import { describeRoute } from '../lib/run-route'

/**
 * «Диагностика» — форензическая вкладка одного прогона в разделе «История работы»
 * (слияние задачи 1). Собрана из того, что раньше жило отдельным разделом
 * AgentRunInspector: честный маршрут (requested vs actual), уровни контроля/защиты
 * секретов, откат праводок к git-якорю (Control Envelope) и Debug Packet — что
 * РЕАЛЬНО ушло в модель (system-промпт + сообщение + бюджет контекста + трейл audit).
 * Данные тянем по runId через существующие window.api.debug/agentRuns — нового IPC нет.
 */

function formatClock(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// Честные подписи отказов отката (копия из бывшего AgentRunInspector).
const RESTORE_REASON_RU: Record<string, string> = {
  'not-git': 'Проект вне git — откатить нечем.',
  'no-anchor': 'Якорь отката не сохранён (старый прогон или не-git).',
  'moved-on': 'Репозиторий ушёл вперёд (есть коммит поверх якоря) — авто-откат отменён, чтобы не тронуть новую историю.',
  'error': 'Ошибка git.',
}

type RestoreState = { phase: 'idle' | 'preview' | 'busy' | 'done'; preview?: EnvelopeRestorePreview; result?: EnvelopeRestoreResult }

function EnvelopeRestorePanel({ state, onConfirm, onClose }: { state: RestoreState; onConfirm: () => void; onClose: () => void }) {
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

function ContextBudget({ packet }: { packet: DebugPacket }) {
  const budget = useMemo(() => {
    if (!packet.input) return null
    return computeContextBudget(packet.input.systemPrompt, packet.input.userMessage, packet.messages)
  }, [packet])
  if (!budget || budget.sections.length === 0) return null
  return (
    <div className="gg-budget">
      <div className="gg-run-section-title">Бюджет контекста</div>
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
      {budget.compacted && <div className="gg-budget-note">⚠️ часть истории сжата (sliding window)</div>}
    </div>
  )
}

export function RunDiagnostics({ run }: { run: AgentRun }) {
  const t = useT()
  const [packet, setPacket] = useState<DebugPacket | null>(null)
  const [loading, setLoading] = useState(true)
  const [restore, setRestore] = useState<RestoreState>({ phase: 'idle' })

  const route = describeRoute(run)
  const isCli = (run.providerId ?? '').endsWith('-cli')
  const cap = runtimeCapability(run.providerId ?? '', isCli ? 'CLI' : 'API')
  const tierBadge = cap.tier === 'observed'
    ? { label: t.runtime.observedLabel, hint: t.runtime.observedHint }
    : cap.tier === 'limited'
      ? { label: t.runtime.limitedLabel, hint: t.runtime.limitedHint }
      : null
  const secLevel = isCli ? secretProtectionLevel(run.providerId ?? '') : 'full'
  const secBadge = secLevel === 'partial'
    ? { label: t.secretProtection.partialLabel, hint: t.secretProtection.partialHint, tone: 'warn' }
    : secLevel === 'none'
      ? { label: t.secretProtection.noneLabel, hint: t.secretProtection.noneHint, tone: 'danger' }
      : null

  const load = useCallback(async () => {
    try {
      const p = await window.api.debug.packet(run.runId)
      setPacket(p)
    } catch { /* пакет просто не откроется */ }
    setLoading(false)
  }, [run.runId])

  useEffect(() => { void load() }, [load])

  return (
    <div className="gg-run-diagnostics">
      <div className="gg-run-section">
        <div className="gg-run-section-title">Маршрут</div>
        <div className="gg-run-diag-route">
          <span className="gg-run-provider">{route.actualProvider ?? 'неизвестно'}</span>
          {route.actualModel && <span className="gg-run-model">{route.actualModel}</span>}
          {route.isFallback && (
            <span className="gg-run-fallback">
              ⇄ запрошен {route.requestedProvider ?? '?'}
              {route.requestedModel && route.requestedModel !== route.actualModel ? ` · ${route.requestedModel}` : ''}
            </span>
          )}
          {tierBadge && <span className={`gg-run-tier is-${cap.tier}`} title={tierBadge.hint}>{tierBadge.label}</span>}
          {secBadge && <span className={`gg-run-tier is-sec-${secBadge.tone}`} title={secBadge.hint}>{secBadge.label}</span>}
        </div>
      </div>

      {isCli && (
        <div className="gg-run-section">
          <button
            className="gg-btn gg-btn-sm"
            title="Откатить правки этого CLI-прогона к git-якорю (контрольная точка перед прогоном)"
            onClick={() => {
              void (async () => {
                setRestore({ phase: 'busy' })
                try {
                  const p = await window.api.agentRuns.envelopePreview(run.runId)
                  setRestore({ phase: 'preview', preview: p })
                } catch { setRestore({ phase: 'idle' }) }
              })()
            }}
          >↩︎ Откатить правки к git-якорю</button>
          {restore.phase !== 'idle' && (
            <EnvelopeRestorePanel
              state={restore}
              onConfirm={() => {
                void (async () => {
                  setRestore(s => ({ ...s, phase: 'busy' }))
                  try {
                    const r = await window.api.agentRuns.envelopeRestore(run.runId)
                    setRestore(s => ({ phase: 'done', preview: s.preview, result: r }))
                  } catch { setRestore(s => ({ ...s, phase: 'preview' })) }
                })()
              }}
              onClose={() => setRestore({ phase: 'idle' })}
            />
          )}
        </div>
      )}

      {loading && !packet && <div className="gg-run-section-empty">Загрузка диагностики…</div>}

      {packet && (
        <>
          {packet.input && <ContextBudget packet={packet} />}
          {packet.input ? (
            <>
              <div className="gg-run-section">
                <div className="gg-run-section-title">Системный промпт — что реально ушло в модель</div>
                <pre className="gg-debug-pre">{packet.input.systemPrompt}</pre>
              </div>
              <div className="gg-run-section">
                <div className="gg-run-section-title">Сообщение пользователя</div>
                <pre className="gg-debug-pre">{packet.input.userMessage}</pre>
              </div>
            </>
          ) : (
            <div className="gg-run-section-empty">Снапшот входа не сохранён для этого прогона (до миграции или CLI-провайдер).</div>
          )}
          <div className="gg-run-section">
            <div className="gg-run-section-title">Трейл действий ({packet.audit.length})</div>
            <pre className="gg-debug-pre">{packet.audit.map(a => `${formatClock(a.timestamp)}  ${a.action}  ${a.detail ?? ''}`).join('\n') || '—'}</pre>
          </div>
        </>
      )}
    </div>
  )
}
