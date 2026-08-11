/**
 * P1 шаг 3: состязание исполнителей в панели «История работы».
 *
 * Одна постановка → 2–3 исполнителя в изолированных workspace → таблица
 * «исполнитель · статус · что вышло · ходов · минут · денег» → человек принимает
 * ОДИН результат, отклонённые остаются в архиве со своим диффом.
 *
 * Нового экрана нет сознательно: сравнение — побочный продукт обычной работы,
 * поэтому живёт в существующей панели прогонов. Данные панель тянет СВОИМ
 * поллингом IPC (как соседние карточки прогонов) — подписка ai.onEvent в
 * Chat.tsx не трогается и не расширяется: её пересоздание теряет события молча.
 *
 * Тексты захардкожены по-русски, как заголовок «История работы» рядом: общие
 * i18n-файлы этой правкой сознательно не трогаем.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ProviderDescriptorDTO,
  ResultTrialDTO,
  TrialAttemptSummaryDTO,
  TrialAttemptEstimateDTO,
} from '../types/api'
import { TRIAL_ESTIMATE_TOKENS } from '../../shared/contracts/trials'
import {
  attemptFinishPatch,
  resolveTrialCompetitors,
  moneyFactLabel,
  estimateLabel,
  estimateAssumptionLabel,
  attemptOutcomeLabel,
  fmtTrialMinutes,
  type TrialCompetitorPick,
  type ResolvedTrialCompetitor,
} from '../lib/trial-view'

/** Задача-источник: существующий прогон, чью постановку гоняем у других исполнителей. */
export interface TrialLaunchSource {
  runId: string
  chatId: number | null
  title: string
}

const ATTEMPT_STATUS_LABEL: Record<string, string> = {
  pending: 'ожидает',
  running: 'работает',
  done: 'готово',
  failed: 'упало',
  accepted: '✓ принят',
  archived: 'в архиве',
}

function providerCell(row: TrialAttemptSummaryDTO, label: (id: string) => string): string {
  return `${label(row.providerId)}${row.model ? ` · ${row.model}` : ''}`
}

export function ResultTrialsSection({ projectPath, launchSource, onDismissSource }: {
  projectPath: string
  launchSource: TrialLaunchSource | null
  onDismissSource: () => void
}) {
  const [providers, setProviders] = useState<ProviderDescriptorDTO[]>([])
  const [trials, setTrials] = useState<ResultTrialDTO[]>([])
  const [summaries, setSummaries] = useState<Record<number, TrialAttemptSummaryDTO[]>>({})
  const [diffs, setDiffs] = useState<Record<number, string | null>>({})
  // Попытки, чей финиш эта панель уже поставила: finishAttempt не зовётся повторно,
  // даже пока следующий поллинг ещё не увидел обновлённый статус.
  const finishedByPanel = useRef(new Set<number>())

  useEffect(() => {
    void window.api.providers.list().then(setProviders).catch(() => {})
  }, [])

  const providerLabel = useCallback((id: string) => {
    const p = providers.find(x => x.id === id)
    return p?.shortLabel || p?.name || id
  }, [providers])

  const refresh = useCallback(async () => {
    if (!projectPath) return
    let list: ResultTrialDTO[] = []
    try {
      list = await window.api.resultTrials.list(projectPath) ?? []
    } catch { return /* IPC недоступен в dev */ }
    setTrials(list)
    const next: Record<number, TrialAttemptSummaryDTO[]> = {}
    for (const trial of list) {
      try {
        let rows = await window.api.resultTrials.summary(trial.id) ?? []
        // Хвост шага 1: финиш попытки ставит ПАНЕЛЬ. Терминальный runStatus при
        // висящем attempt.status='running' закрывается здесь — иначе правду нёс
        // бы только JOIN, а сама попытка вечно значилась работающей.
        let reconciled = false
        for (const row of rows) {
          const patch = attemptFinishPatch(row)
          if (!patch || finishedByPanel.current.has(row.id)) continue
          finishedByPanel.current.add(row.id)
          try {
            await window.api.resultTrials.finishAttempt(row.id, patch)
            reconciled = true
          } catch { /* следующий поллинг попробует снова */ }
        }
        if (reconciled) rows = await window.api.resultTrials.summary(trial.id) ?? rows
        next[trial.id] = rows
      } catch { /* summary этого состязания подтянется следующим тиком */ }
    }
    setSummaries(next)
  }, [projectPath])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      if (document.hidden) return
      void refresh()
    }, 2500)
    return () => clearInterval(timer)
  }, [refresh])

  const handleAccept = useCallback(async (trialId: number, attemptId: number) => {
    try {
      const rows = await window.api.resultTrials.accept(trialId, attemptId)
      if (Array.isArray(rows)) setSummaries(prev => ({ ...prev, [trialId]: rows }))
      void refresh()
    } catch { /* refresh покажет фактическое состояние */ }
  }, [refresh])

  const handleDiff = useCallback(async (trialId: number, attemptId: number) => {
    if (diffs[attemptId] != null) {
      setDiffs(prev => ({ ...prev, [attemptId]: null }))
      return
    }
    try {
      const text = await window.api.resultTrials.diff(trialId, attemptId)
      setDiffs(prev => ({ ...prev, [attemptId]: text || '(пустой дифф — исполнитель не менял файлы)' }))
    } catch {
      setDiffs(prev => ({ ...prev, [attemptId]: 'Не удалось прочитать дифф.' }))
    }
  }, [diffs])

  if (trials.length === 0 && !launchSource) return null

  return (
    <div className="gg-trials">
      {launchSource && (
        <TrialLauncher
          projectPath={projectPath}
          source={launchSource}
          providers={providers}
          onClose={onDismissSource}
          onStarted={() => { onDismissSource(); void refresh() }}
        />
      )}
      {trials.map(trial => (
        <div key={trial.id} className={`gg-trial-card is-${trial.status}`}>
          <div className="gg-trial-head">
            <span className="gg-trial-title" title={trial.prompt}>⚔ Состязание #{trial.id}: {trial.prompt}</span>
            <span className={`gg-trial-status is-${trial.status}`}>
              {trial.status === 'accepted' ? 'результат принят' : trial.status === 'cancelled' ? 'отменено' : 'идёт'}
            </span>
          </div>
          <table className="gg-trial-table">
            <thead>
              <tr>
                <th>Исполнитель</th><th>Статус</th><th>Что вышло</th>
                <th>Ходов</th><th>Минут</th><th>Деньги</th><th></th>
              </tr>
            </thead>
            <tbody>
              {(summaries[trial.id] ?? []).map(row => (
                <TrialAttemptRow
                  key={row.id}
                  trial={trial}
                  row={row}
                  providerLabel={providerLabel}
                  diff={diffs[row.id] ?? null}
                  onAccept={() => void handleAccept(trial.id, row.id)}
                  onDiff={() => void handleDiff(trial.id, row.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

function TrialAttemptRow({ trial, row, providerLabel, diff, onAccept, onDiff }: {
  trial: ResultTrialDTO
  row: TrialAttemptSummaryDTO
  providerLabel: (id: string) => string
  diff: string | null
  onAccept: () => void
  onDiff: () => void
}) {
  // «Принять» — когда результат есть (попытка готова) и состязание ещё не решено.
  const canAccept = trial.status === 'running'
    && (row.status === 'done' || (row.status === 'running' && row.runStatus === 'done'))
  // Дифф есть у всего, что стартовало: и у принятой работы, и у отклонённой.
  const canDiff = row.status !== 'pending'
  return (
    <>
      <tr className={`gg-trial-row is-${row.status}`}>
        <td className="gg-trial-provider" title={row.workspace}>{providerCell(row, providerLabel)}</td>
        <td><span className={`gg-trial-attempt-status is-${row.status}`}>{ATTEMPT_STATUS_LABEL[row.status] ?? row.status}</span></td>
        <td className="gg-trial-outcome" title={row.error ?? undefined}>{attemptOutcomeLabel(row)}</td>
        <td>{row.turns ?? '—'}</td>
        <td>{fmtTrialMinutes(row.durationMs)}</td>
        <td className="gg-trial-money">{moneyFactLabel(row)}</td>
        <td className="gg-trial-actions">
          {canAccept && (
            <button type="button" className="gg-btn gg-btn-sm" onClick={onAccept}
              title="Принять этот результат: остальные попытки уходят в архив, их дифф остаётся доступен">
              Принять
            </button>
          )}
          {canDiff && (
            <button type="button" className="gg-btn gg-btn-sm gg-btn-ghost" onClick={onDiff}
              title="Показать, что именно сделал исполнитель в своём workspace">
              Дифф
            </button>
          )}
        </td>
      </tr>
      {diff != null && (
        <tr className="gg-trial-diff-row">
          <td colSpan={7}><pre className="gg-trial-diff">{diff}</pre></td>
        </tr>
      )}
    </>
  )
}

/**
 * Запуск состязания у существующей задачи: постановка берётся из прогона КАК
 * ЕСТЬ (read-only agent-runs:resume) и не переписывается между исполнителями —
 * иначе сравнение врёт. Оценка и старт получают один и тот же resolved-состав
 * с ЯВНОЙ моделью каждого участника.
 */
function TrialLauncher({ projectPath, source, providers, onClose, onStarted }: {
  projectPath: string
  source: TrialLaunchSource
  providers: ProviderDescriptorDTO[]
  onClose: () => void
  onStarted: () => void
}) {
  const [prompt, setPrompt] = useState<string | null>(null)
  const [promptError, setPromptError] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [picks, setPicks] = useState<TrialCompetitorPick[]>([])
  const [resolved, setResolved] = useState<ResolvedTrialCompetitor[] | null>(null)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [estimates, setEstimates] = useState<TrialAttemptEstimateDTO[]>([])
  const [busy, setBusy] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.agentRuns.resume(source.runId).then(res => {
      if (!alive) return
      if ('error' in res) setPromptError(res.error)
      else setPrompt(res.userMessage)
    }).catch(() => { if (alive) setPromptError('Не удалось прочитать постановку прогона.') })
    void window.api.resultTrials.available(projectPath).then(res => {
      if (alive && !res.available) setUnavailable(res.reason ?? 'Состязание недоступно в этом проекте.')
    }).catch(() => {})
    return () => { alive = false }
  }, [source.runId, projectPath])

  // Стартовый состав: первые два провайдера каталога, модель — дефолт (явно ниже).
  useEffect(() => {
    if (picks.length > 0 || providers.length < 2) return
    setPicks([
      { providerId: providers[0].id, model: null },
      { providerId: providers[1].id, model: null },
    ])
  }, [providers, picks.length])

  // Модель разрешается ЯВНО здесь — и оценка, и старт берут ЭТОТ массив.
  useEffect(() => {
    if (picks.length === 0) { setResolved(null); return }
    const res = resolveTrialCompetitors(picks, providers)
    if ('error' in res) { setResolved(null); setResolveError(res.error); return }
    setResolveError(null)
    setResolved(res.competitors)
    let alive = true
    void window.api.resultTrials.estimate(res.competitors, TRIAL_ESTIMATE_TOKENS)
      .then(list => { if (alive && Array.isArray(list)) setEstimates(list) })
      .catch(() => {})
    return () => { alive = false }
  }, [picks, providers])

  const setPick = (index: number, patch: Partial<TrialCompetitorPick>) => {
    setPicks(prev => prev.map((p, i) => i === index
      // Смена провайдера сбрасывает модель на его дефолт (снова разрешится явно).
      ? { ...p, ...patch, ...(patch.providerId && patch.model === undefined ? { model: null } : {}) }
      : p))
  }

  const start = async () => {
    if (!prompt || !resolved || resolved.length < 2) return
    setBusy(true); setStartError(null)
    try {
      const { trial } = await window.api.resultTrials.start({
        projectPath,
        prompt,
        parentChatId: source.chatId,
        competitors: resolved,
      })
      await window.api.resultTrials.startRuns(trial.id)
      onStarted()
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err))
    }
    setBusy(false)
  }

  const canStart = !!prompt && !unavailable && !busy && (resolved?.length ?? 0) >= 2

  return (
    <div className="gg-trial-launcher">
      <div className="gg-trial-head">
        <span className="gg-trial-title">⚔ Состязание по задаче: {source.title}</span>
        <button type="button" className="gg-btn gg-btn-sm gg-btn-ghost" onClick={onClose}>✕</button>
      </div>
      {unavailable && <div className="gg-trial-warn">{unavailable}</div>}
      {promptError && <div className="gg-trial-warn">{promptError}</div>}
      {prompt && (
        <div className="gg-trial-prompt" title="Постановка уходит каждому исполнителю без переписывания — иначе сравнение врёт">
          {prompt}
        </div>
      )}
      <div className="gg-trial-picks">
        {picks.map((pick, i) => {
          const provider = providers.find(p => p.id === pick.providerId)
          const est = estimates.find(e => e.providerId === pick.providerId
            && (pick.model == null || e.model === pick.model))
          return (
            <div key={i} className="gg-trial-pick">
              <select className="gg-input" value={pick.providerId}
                onChange={e => setPick(i, { providerId: e.target.value })}>
                {providers.map(p => <option key={p.id} value={p.id}>{p.shortLabel || p.name}</option>)}
              </select>
              <select className="gg-input" value={pick.model ?? provider?.defaultModel ?? ''}
                onChange={e => setPick(i, { model: e.target.value })}>
                {(provider?.models ?? []).map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <span className="gg-trial-estimate" title="Оценка по прайсу модели, до запуска">
                {est ? estimateLabel(est) : '…'}
              </span>
              {picks.length > 2 && (
                <button type="button" className="gg-btn gg-btn-sm gg-btn-ghost"
                  onClick={() => setPicks(prev => prev.filter((_, j) => j !== i))}>✕</button>
              )}
            </div>
          )
        })}
      </div>
      <div className="gg-trial-assumption">{estimateAssumptionLabel(TRIAL_ESTIMATE_TOKENS)}</div>
      {resolveError && <div className="gg-trial-warn">{resolveError}</div>}
      {startError && <div className="gg-trial-warn">⛔ {startError}</div>}
      <div className="gg-trial-launch-actions">
        {picks.length < 3 && providers.length > 0 && (
          <button type="button" className="gg-btn gg-btn-sm gg-btn-ghost"
            onClick={() => setPicks(prev => [...prev, { providerId: providers[0].id, model: null }])}>
            + исполнитель
          </button>
        )}
        <button type="button" className="gg-btn gg-btn-sm" disabled={!canStart} onClick={() => void start()}>
          {busy ? 'Запускаю…' : 'Запустить состязание'}
        </button>
      </div>
    </div>
  )
}
