/**
 * Proof Pack — «доказательство выполнения» одного агентного прогона в одном
 * артефакте (proof.json + proof.html). Главный монетизируемый дифференциатор:
 * не «агент что-то сделал», а проверяемый след — что изменено, прошли ли
 * проверки (DoD), сколько стоило, чем, по шагам.
 *
 * Собирается из уже существующих источников (agent_runs + events, verifications,
 * git diff, audit_log) — НЕ новая таблица. Чистые функции: assembleProofPack
 * (raw данные → структура) + renderProofPackHtml (структура → HTML). Тестируемы
 * без БД/Electron.
 */
import { scanText } from './secret-scanner'
import { CLI_FREE, ZERO_COST_PROVIDERS } from './cost-guard'
import type { ProviderId } from './registry'

export type ProofVerificationOverall = 'passed' | 'failed' | 'partial' | 'not_run'

export interface ProofPackInput {
  generatedAt: number
  run: {
    runId: string
    title: string
    providerId: string | null
    model: string | null
    status: string
    agentMode: string | null
    startedAt: number
    endedAt: number | null
    toolCount: number
    filesCount: number
    agentsCount: number
    costCents: number
    turnIndex: number
    error: string | null
  }
  changedFiles: Array<{ path: string; added: number; removed: number; status: string }>
  verification: {
    overall: ProofVerificationOverall
    checksTotal: number
    checksPassed: number
    taskSummary: string | null
  } | null
  /** Сырые события прогона (agent_run_events) в порядке времени. */
  events: Array<{ kind: string; label: string | null; detail: string | null; status: string | null; createdAt: number }>
  /** Записи audit_log этого прогона (override-решения и т.п.). */
  audit: Array<{ action: string; detail: string; timestamp: number }>
  /**
   * VSK-PROOF-A1: честность стоимости из agent_run_usage (терминальная нога после fallback).
   * null = строки usage нет. R1: у заведомо бесплатного провайдера (CLI_FREE/ZERO_COST —
   * runner не пишет строку без token telemetry) это known $0, а у платного — legacy.
   * Число известной стоимости берётся из run.costCents (cumulative ВСЕГО прогона):
   * cost_amount — только терминальная нога, её нельзя выдавать за полную сумму.
   */
  usage: { pricingKnown: 0 | 1; costAmount: number | null } | null
  /**
   * VSK-PROOF-A1-R1: ошибка ЧТЕНИЯ usage (БД залочена/упала) — НЕ то же, что отсутствие
   * строки. true → unknown + «данные usage недоступны», НЕ legacy.
   */
  usageError?: boolean
}

export interface ProofPack {
  generatedAt: number
  run: {
    runId: string
    title: string
    provider: string | null
    model: string | null
    status: string
    agentMode: string | null
    startedAt: number
    endedAt: number | null
    durationMs: number | null
    toolCount: number
    filesCount: number
    agentsCount: number
    /** VSK-PROOF-A1: null = стоимость неизвестна (НЕ ноль). Число только при costStatus='known'. */
    costUsd: number | null
    /** known = цена подтверждена agent_run_usage; unknown = показывать число нельзя. */
    costStatus: 'known' | 'unknown'
    /**
     * R1: tri-state источника стоимости. ok = строка usage прочитана; missing = строки нет
     * (legacy у платного, known $0 у заведомо бесплатного); unavailable = ошибка чтения.
     */
    costDataStatus: 'ok' | 'missing' | 'unavailable'
    turnIndex: number
    error: string | null
  }
  changedFiles: Array<{ path: string; added: number; removed: number; status: string }>
  verification: {
    overall: ProofVerificationOverall
    checksTotal: number
    checksPassed: number
    taskSummary: string | null
  } | null
  /** Решения-оверрайды (например коммит поверх красных проверок) из audit_log. */
  decisions: Array<{ action: string; detail: string; at: number }>
  /** Сжатый таймлайн ключевых событий прогона. */
  timeline: Array<{ kind: string; label: string | null; detail: string | null; status: string | null; at: number }>
  /** Mandatory review gate status when review_before_commit participated in the run. */
  reviewGate: { status: 'passed' | 'failed' | 'missing'; detail: string | null; at: number | null }
  /** Финальный ответ агента (последнее assistant_msg-событие). */
  result: string | null
  /** true = прогон до учёта расхода: строки agent_run_usage нет, стоимость не выдумываем. */
  legacyIncomplete: boolean
}

function redact(s: string | null | undefined): string | null {
  if (s == null) return null
  return scanText(String(s)).redacted
}

/**
 * R1: заведомо бесплатный провайдер — ТОЛЬКО через CLI_FREE / ZERO_COST_PROVIDERS из
 * cost-guard (единый источник с persist-слоем), без эвристик по суффиксу строки.
 * У таких прогонов runner может не писать usage-строку (нет token telemetry) — и это
 * НЕ legacy: бесплатность известна по определению провайдера.
 */
function isKnownFreeProvider(providerId: string | null): boolean {
  if (providerId == null) return false
  const pid = providerId as ProviderId
  return CLI_FREE.has(pid) || ZERO_COST_PROVIDERS.has(pid)
}

/** Результат честной стоимости — единая точка всех ветвей (сложность вне assemble). */
interface CostResolution {
  costUsd: number | null
  costStatus: 'known' | 'unknown'
  costDataStatus: 'ok' | 'missing' | 'unavailable'
  legacyIncomplete: boolean
}

/**
 * VSK-PROOF-A1: ноль имеет ТРИ значения — бесплатный CLI / цена неизвестна / legacy без
 * строки usage. usage определяет ЧЕСТНОСТЬ состояния; число известной стоимости — всегда
 * из agent_runs.costCents (cumulative прогона), НЕ из cost_amount терминальной ноги.
 * Защита от противоречия: pricingKnown=1 при costAmount=null — это НЕ «ноль», а unknown.
 * R1: разделены ТРИ состояния источника — строка есть / строки нет / ошибка чтения.
 * Отсутствие строки у заведомо бесплатного провайдера (CLI без token telemetry) — known $0,
 * НЕ legacy; ошибка чтения — unknown + unavailable, тоже НЕ legacy.
 */
function resolveCost(input: ProofPackInput): CostResolution {
  const usageError = input.usageError === true
  if (usageError) {
    return { costUsd: null, costStatus: 'unknown', costDataStatus: 'unavailable', legacyIncomplete: false }
  }
  if (input.usage != null) {
    const known = input.usage.pricingKnown === 1 && input.usage.costAmount != null
    return {
      costUsd: known ? Math.round(input.run.costCents) / 100 : null,
      costStatus: known ? 'known' : 'unknown',
      costDataStatus: 'ok',
      legacyIncomplete: false,
    }
  }
  if (isKnownFreeProvider(input.run.providerId)) {
    // CLI/zero-cost без token telemetry: строки нет, но бесплатность известна → $0.00.
    return { costUsd: Math.round(input.run.costCents) / 100, costStatus: 'known', costDataStatus: 'missing', legacyIncomplete: false }
  }
  // Платный/неизвестный провайдер без строки — legacy/incomplete, стоимость не выдумываем.
  return { costUsd: null, costStatus: 'unknown', costDataStatus: 'missing', legacyIncomplete: true }
}

/** Чистая сборка Proof Pack из сырых данных источников. */
export function assembleProofPack(input: ProofPackInput): ProofPack {
  const { run } = input
  const durationMs = run.endedAt != null ? run.endedAt - run.startedAt : null

  // Решения-оверрайды: записи audit_log, где явно фиксировался обход контроля.
  const decisions = input.audit
    .filter(a => /override|обход|bypass/i.test(a.action) || /override/i.test(a.detail))
    .map(a => ({ action: a.action, detail: a.detail, at: a.timestamp }))

  // Финальный результат — последнее assistant_msg событие.
  const lastAssistant = [...input.events].reverse().find(e => e.kind === 'assistant_msg')
  const result = lastAssistant?.detail ?? null

  // Таймлайн: значимые события (инструменты/проверка/итог), без шума.
  const SIGNIFICANT = new Set(['tool_call', 'verify', 'assistant_msg', 'user_msg', 'status', 'error', 'session_start'])
  const timeline = input.events
    .filter(e => SIGNIFICANT.has(e.kind))
    .map(e => ({ kind: e.kind, label: redact(e.label), detail: redact(e.detail), status: e.status, at: e.createdAt }))

  const reviewEvents = input.events.filter(e => e.kind === 'tool_call' && e.label === 'review_before_commit')
  const review = reviewEvents[reviewEvents.length - 1]
  const reviewDetail = redact(review?.detail)
  const reviewGate: ProofPack['reviewGate'] = review
    ? {
        status: review.status === 'ok' && (review.detail ?? '').includes('REVIEW GATE: ПРОЙДЕНО') ? 'passed' : 'failed',
        detail: reviewDetail,
        at: review.createdAt,
      }
    : { status: 'missing', detail: null, at: null }

  const cost = resolveCost(input)

  return {
    generatedAt: input.generatedAt,
    run: {
      runId: run.runId,
      title: redact(run.title) ?? '',
      provider: run.providerId,
      model: run.model,
      status: run.status,
      agentMode: run.agentMode,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      durationMs,
      toolCount: run.toolCount,
      filesCount: run.filesCount,
      agentsCount: run.agentsCount,
      costUsd: cost.costUsd,
      costStatus: cost.costStatus,
      costDataStatus: cost.costDataStatus,
      turnIndex: run.turnIndex,
      error: redact(run.error)
    },
    changedFiles: input.changedFiles.map(f => ({ ...f, path: redact(f.path) ?? f.path })),
    verification: input.verification
      ? { ...input.verification, taskSummary: redact(input.verification.taskSummary) }
      : null,
    decisions: decisions.map(d => ({ ...d, action: redact(d.action) ?? d.action, detail: redact(d.detail) ?? '' })),
    timeline,
    reviewGate,
    result: redact(result),
    legacyIncomplete: cost.legacyIncomplete
  }
}

// ----------------------------------------------------------------- HTML render

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const DOD_LABEL: Record<ProofVerificationOverall, string> = {
  passed: 'ДОКАЗАНО',
  partial: 'ЧАСТИЧНО',
  failed: 'НЕ ПРОЙДЕНО',
  not_run: 'НЕ ПРОВЕРЕНО'
}
const DOD_COLOR: Record<ProofVerificationOverall, string> = {
  passed: '#3a9d5a',
  partial: '#d98a2b',
  failed: '#c0504d',
  not_run: '#8c93a0'
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}с`
  const m = Math.floor(s / 60)
  return `${m}м ${s % 60}с`
}

/**
 * VSK-PROOF-A1: подпись стоимости. known → $N.NN (известный ноль CLI остаётся $0.00);
 * unknown с современной usage-строкой → «неизвестно»; legacy без строки → честная пометка.
 * R1: ошибка чтения usage — «данные usage недоступны», НЕ legacy.
 * Единое место — HTML, Markdown и PDF (строится из Markdown) не расходятся.
 */
function costLabel(pack: ProofPack): string {
  if (pack.run.costStatus === 'known' && pack.run.costUsd != null) return `$${pack.run.costUsd.toFixed(2)}`
  if (pack.run.costDataStatus === 'unavailable') return 'неизвестно · данные usage недоступны'
  return pack.legacyIncomplete ? 'неизвестно · неполные legacy-данные' : 'неизвестно'
}

/** Чистый рендер Proof Pack → автономный HTML (inline-стили, без зависимостей). */
export function renderProofPackHtml(pack: ProofPack): string {
  const v = pack.verification
  const dodBadge = v
    ? `<span style="display:inline-block;padding:4px 12px;border-radius:6px;background:${DOD_COLOR[v.overall]};color:#fff;font-weight:700;font-size:13px;letter-spacing:0.5px">${DOD_LABEL[v.overall]} · ${v.checksPassed}/${v.checksTotal} проверок</span>`
    : `<span style="display:inline-block;padding:4px 12px;border-radius:6px;background:${DOD_COLOR.not_run};color:#fff;font-weight:700;font-size:13px">НЕ ПРОВЕРЕНО</span>`

  const filesRows = pack.changedFiles.length
    ? pack.changedFiles.map(f =>
        `<tr><td style="padding:4px 8px;font-family:monospace">${esc(f.path)}</td><td style="padding:4px 8px;color:#3a9d5a">+${f.added}</td><td style="padding:4px 8px;color:#c0504d">−${f.removed}</td><td style="padding:4px 8px;color:#8c93a0">${esc(f.status)}</td></tr>`
      ).join('')
    : '<tr><td colspan="4" style="padding:8px;color:#8c93a0">Файлы не менялись</td></tr>'

  const decisionRows = pack.decisions.length
    ? pack.decisions.map(d =>
        `<li style="margin:4px 0"><b>${esc(d.action)}</b>: ${esc(d.detail)}</li>`
      ).join('')
    : '<li style="color:#8c93a0">Обходов контроля не зафиксировано</li>'

  const timelineRows = pack.timeline.map(e => {
    const icon = e.kind === 'verify' ? '✓' : e.kind === 'tool_call' ? '🔧' : e.kind === 'assistant_msg' ? '💬' : e.kind === 'error' ? '⚠' : '·'
    const txt = e.label || e.kind
    const det = e.detail ? ` — ${esc(e.detail.slice(0, 160))}` : ''
    return `<li style="margin:3px 0;font-size:13px">${icon} <b>${esc(txt)}</b>${det}</li>`
  }).join('')

  const meta = pack.run
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>Proof Pack — ${esc(meta.title)}</title></head>
<body style="font-family:Inter,system-ui,sans-serif;max-width:880px;margin:24px auto;color:#1c2128;line-height:1.5;padding:0 16px">
  <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;border-bottom:2px solid #e1e4e8;padding-bottom:12px">
    <h1 style="margin:0;font-size:22px">🔏 Proof Pack</h1>
    ${dodBadge}
  </div>
  <p style="color:#57606a;margin:8px 0 20px">${esc(meta.title)}</p>

  <h2 style="font-size:15px;border-bottom:1px solid #e1e4e8;padding-bottom:4px">Прогон</h2>
  <table style="border-collapse:collapse;font-size:13px;width:100%">
    <tr><td style="padding:3px 8px;color:#57606a">Провайдер / модель</td><td style="padding:3px 8px">${esc(meta.provider ?? '—')} · ${esc(meta.model ?? '—')}</td></tr>
    <tr><td style="padding:3px 8px;color:#57606a">Режим</td><td style="padding:3px 8px">${esc(meta.agentMode ?? '—')}</td></tr>
    <tr><td style="padding:3px 8px;color:#57606a">Статус</td><td style="padding:3px 8px">${esc(meta.status)}${meta.error ? ` — ${esc(meta.error)}` : ''}</td></tr>
    <tr><td style="padding:3px 8px;color:#57606a">Длительность</td><td style="padding:3px 8px">${fmtDuration(meta.durationMs)}</td></tr>
    <tr><td style="padding:3px 8px;color:#57606a">Инструментов / файлов / агентов</td><td style="padding:3px 8px">${meta.toolCount} / ${meta.filesCount} / ${meta.agentsCount}</td></tr>
    <tr><td style="padding:3px 8px;color:#57606a">Стоимость</td><td style="padding:3px 8px">${esc(costLabel(pack))}</td></tr>
  </table>

  <h2 style="font-size:15px;border-bottom:1px solid #e1e4e8;padding-bottom:4px;margin-top:20px">Изменённые файлы (${pack.changedFiles.length})</h2>
  <table style="border-collapse:collapse;font-size:13px;width:100%"><tbody>${filesRows}</tbody></table>

  ${v ? `<h2 style="font-size:15px;border-bottom:1px solid #e1e4e8;padding-bottom:4px;margin-top:20px">Доказательство (DoD)</h2>
  <p style="font-size:13px">Проверок пройдено: <b>${v.checksPassed}/${v.checksTotal}</b>. Задача: ${esc(v.taskSummary ?? '—')}.</p>` : ''}

  <h2 style="font-size:15px;border-bottom:1px solid #e1e4e8;padding-bottom:4px;margin-top:20px">Review Gate</h2>
  <p style="font-size:13px"><b>${esc(pack.reviewGate.status)}</b>${pack.reviewGate.detail ? ` — ${esc(pack.reviewGate.detail)}` : ''}</p>

  <h2 style="font-size:15px;border-bottom:1px solid #e1e4e8;padding-bottom:4px;margin-top:20px">Решения и обходы</h2>
  <ul style="font-size:13px;margin:8px 0;padding-left:20px">${decisionRows}</ul>

  <h2 style="font-size:15px;border-bottom:1px solid #e1e4e8;padding-bottom:4px;margin-top:20px">Таймлайн</h2>
  <ul style="list-style:none;padding-left:0;margin:8px 0">${timelineRows || '<li style="color:#8c93a0">Событий нет</li>'}</ul>

  ${pack.result ? `<h2 style="font-size:15px;border-bottom:1px solid #e1e4e8;padding-bottom:4px;margin-top:20px">Итог</h2>
  <div style="font-size:13px;background:#f6f8fa;border-radius:6px;padding:12px;white-space:pre-wrap">${esc(pack.result.slice(0, 2000))}</div>` : ''}

  <p style="color:#8c93a0;font-size:11px;margin-top:24px;border-top:1px solid #e1e4e8;padding-top:8px">
    Сгенерировано Verstak · runId ${esc(meta.runId)} · ${new Date(pack.generatedAt).toISOString()}
  </p>
</body></html>`
}

function mdCell(s: string | null | undefined): string {
  return String(s ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** Чистый рендер Proof Pack -> Markdown для клиентской поставки / ревью в git. */
export function renderProofPackMarkdown(pack: ProofPack): string {
  const v = pack.verification
  const files = pack.changedFiles.length
    ? pack.changedFiles.map(f => `| ${mdCell(f.path)} | +${f.added} | -${f.removed} | ${mdCell(f.status)} |`).join('\n')
    : '| — | 0 | 0 | none |'
  const timeline = pack.timeline.length
    ? pack.timeline.map(e => `- ${new Date(e.at).toISOString()} · ${e.kind}${e.label ? ` · ${e.label}` : ''}${e.status ? ` · ${e.status}` : ''}${e.detail ? ` · ${e.detail.slice(0, 180)}` : ''}`).join('\n')
    : '- No timeline events'

  return [
    '# Proof Pack',
    '',
    `Task: ${pack.run.title}`,
    `Run: ${pack.run.runId}`,
    `Generated: ${new Date(pack.generatedAt).toISOString()}`,
    '',
    '## Run',
    '',
    `- Provider/model: ${pack.run.provider ?? '—'} / ${pack.run.model ?? '—'}`,
    `- Mode: ${pack.run.agentMode ?? '—'}`,
    `- Status: ${pack.run.status}${pack.run.error ? ` (${pack.run.error})` : ''}`,
    `- Duration: ${fmtDuration(pack.run.durationMs)}`,
    `- Tools/files/agents: ${pack.run.toolCount}/${pack.run.filesCount}/${pack.run.agentsCount}`,
    `- Cost: ${costLabel(pack)}`,
    '',
    '## Verification',
    '',
    v
      ? `- Status: ${v.overall}\n- Checks: ${v.checksPassed}/${v.checksTotal}\n- Summary: ${v.taskSummary ?? '—'}`
      : '- Status: not_run',
    '',
    '## Review Gate',
    '',
    `- Status: ${pack.reviewGate.status}`,
    `- Detail: ${pack.reviewGate.detail ?? '—'}`,
    '',
    '## Changed Files',
    '',
    '| File | Added | Removed | Status |',
    '| --- | ---: | ---: | --- |',
    files,
    '',
    '## Timeline',
    '',
    timeline,
    '',
    ...(pack.result ? ['## Result', '', pack.result.slice(0, 2000), ''] : []),
  ].join('\n')
}
