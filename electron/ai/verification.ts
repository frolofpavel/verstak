/**
 * Verification Artifact — «доказательство выполнения» (DoD), третий kind
 * артефакта помимо html/docx.
 *
 * Источник: COMPETITIVE_ROADMAP раздел 8. Доктрина: «не верь модели —
 * перепрогони». Статусы проверок ставит хендлер по exitCode (Фаза 2), здесь —
 * чистая логика: тип, агрегация overall и самостоятельный HTML-рендер.
 *
 * Фаза 1: только ядро — без БД, IPC, UI, tools. Поведение приложения не меняется.
 */

/** Одна проверка (команда верификации или ручная отметка). */
export interface VerificationCheck {
  command: string | null
  status: 'passed' | 'failed' | 'partial' | 'not_run'
  manual: boolean              // проверка без команды (ручная) → not_run
  summary?: string
  exitCode?: number
  tail?: string                // последние ~800 симв вывода (уже secret-scanned вызывающим)
}

/** Изменённый файл со сверкой «заявлено агентом» vs «реально тронуто». */
export interface VerificationChangedFile {
  path: string
  linesAdded?: number
  linesRemoved?: number
  claimed: boolean             // агент заявил, что трогал
  actual: boolean              // реально трогал (по undo/recordWrite)
}

/** Самодостаточный артефакт-доказательство. Сериализуется в *.verification.json. */
export interface VerificationArtifact {
  version: 1
  taskSummary: string
  overall: 'passed' | 'failed' | 'partial' | 'not_run'
  changedFiles: VerificationChangedFile[]
  checks: VerificationCheck[]
  screenshotPath?: string
  risks: string[]
  createdAt: number
  runId?: string
  chatId?: number
}

/**
 * Агрегирует overall по списку проверок.
 *
 * Правила (крайние кейсы):
 *  - пусто → 'not_run' (нечего проверять);
 *  - есть хоть один 'failed' → 'failed' (провал доминирует — это доказательство, не отчёт);
 *  - все 'passed' → 'passed';
 *  - смесь passed + not_run/manual (без failed) → 'partial' (часть проверена, часть нет);
 *  - смесь, где есть 'partial', но нет passed/failed (напр. только partial+not_run) → тоже 'partial'.
 * Иначе говоря: если все проверки в {not_run} (ничего не прогнано) → 'not_run';
 * если все прогнанные зелёные → 'passed'; во всех остальных без-fail случаях → 'partial'.
 */
export function computeOverall(checks: VerificationCheck[]): VerificationArtifact['overall'] {
  if (checks.length === 0) return 'not_run'
  if (checks.some(c => c.status === 'failed')) return 'failed'
  if (checks.every(c => c.status === 'passed')) return 'passed'
  if (checks.every(c => c.status === 'not_run')) return 'not_run'
  // Остаётся смесь без failed: passed+not_run, passed+partial, partial+not_run и т.п.
  return 'partial'
}

// ----------------------------------------------------------------- HTML рендер

/** Палитра бейджей — синхронна с charts.ts PALETTE. */
const BADGE = {
  passed: '#4ec9b0',   // success
  failed: '#f47174',   // error
  partial: '#d7ba7d',  // warning (жёлтый — часть проверена)
  not_run: '#8c93a0'   // нейтрально-серый — «ничего не проверено» ≠ «частично» (аудит P2)
} as const

const STATUS_RU: Record<VerificationCheck['status'], string> = {
  passed: 'OK',
  failed: 'FAIL',
  partial: 'частично',
  not_run: 'не запущена'
}

const OVERALL_RU: Record<VerificationArtifact['overall'], string> = {
  passed: 'Проверки пройдены',
  failed: 'Есть проваленные проверки',
  partial: 'Частично проверено',
  not_run: 'Проверки не запускались'
}

/** Экранирование HTML-спецсимволов в пользовательских строках (XSS-безопасно). */
function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]!))
}

function badge(status: VerificationCheck['status'] | VerificationArtifact['overall']): string {
  const color = BADGE[status as keyof typeof BADGE]
  const label = (STATUS_RU as Record<string, string>)[status] ?? status
  return `<span class="badge" style="background:${color}">${escapeHtml(label)}</span>`
}

/**
 * Самостоятельный HTML-документ в стиле wrapHtml из artifacts.ts (тот же шрифт,
 * отступы), но тёмная тема — это «доказательство», не клиентский документ.
 */
export function renderVerificationHtml(art: VerificationArtifact): string {
  const checksRows = art.checks.length
    ? art.checks.map(c => {
        const cmd = c.command ? `<code>${escapeHtml(c.command)}</code>` : '<span class="muted">— (ручная)</span>'
        const exit = c.exitCode === undefined ? '<span class="muted">—</span>' : String(c.exitCode)
        const tail = c.tail ? `<pre>${escapeHtml(c.tail)}</pre>` : '<span class="muted">—</span>'
        const summary = c.summary ? `<div class="summary">${escapeHtml(c.summary)}</div>` : ''
        return `<tr>
  <td>${cmd}${summary}</td>
  <td>${badge(c.status)}</td>
  <td class="num">${exit}</td>
  <td>${tail}</td>
</tr>`
      }).join('\n')
    : '<tr><td colspan="4" class="muted">Проверок нет.</td></tr>'

  const filesList = art.changedFiles.length
    ? art.changedFiles.map(f => {
        // Подсветка расхождений claimed≠actual.
        let mark = ''
        if (f.claimed && !f.actual) mark = '<span class="mismatch warn">заявлен, но не тронут</span>'
        else if (!f.claimed && f.actual) mark = '<span class="mismatch warn">тронут, но не заявлен</span>'
        const stat = (f.linesAdded !== undefined || f.linesRemoved !== undefined)
          ? ` <span class="stat">+${f.linesAdded ?? 0} / −${f.linesRemoved ?? 0}</span>`
          : ''
        return `<li><code>${escapeHtml(f.path)}</code>${stat} ${mark}</li>`
      }).join('\n')
    : '<li class="muted">Файлы не менялись.</li>'

  const risksList = art.risks.length
    ? `<ul class="risks">${art.risks.map(r => `<li>${escapeHtml(r)}</li>`).join('\n')}</ul>`
    : '<p class="muted">Рисков не отмечено.</p>'

  const screenshot = art.screenshotPath
    ? `<h2>Скриншот</h2><img src="${escapeHtml(art.screenshotPath)}" alt="UI screenshot" class="shot">`
    : ''

  const passedCount = art.checks.filter(c => c.status === 'passed').length
  const created = new Date(art.createdAt).toISOString().replace('T', ' ').slice(0, 19)

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verification — ${escapeHtml(art.taskSummary).slice(0, 80)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
         max-width: 900px; margin: 40px auto; padding: 0 24px; line-height: 1.6;
         color: #d4d7dd; background: #1a1d22; }
  h1 { font-size: 26px; margin-top: 0; letter-spacing: -0.015em; color: #f0f2f5; }
  h2 { font-size: 19px; border-bottom: 1px solid #2c3038; padding-bottom: 6px; margin-top: 36px; color: #f0f2f5; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th { background: #23262d; padding: 8px 12px; text-align: left; border-bottom: 2px solid #2c3038; color: #a8adb8; }
  td { padding: 8px 12px; border-bottom: 1px solid #2c3038; vertical-align: top; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  code { background: #23262d; padding: 1px 5px; border-radius: 3px; font-family: 'Consolas', monospace; color: #d7ba7d; }
  pre { background: #23262d; padding: 10px; border-radius: 6px; overflow-x: auto; margin: 6px 0 0;
        font-family: 'Consolas', monospace; font-size: 12px; color: #c8ccd4; max-height: 240px; }
  .badge { display: inline-block; padding: 2px 9px; border-radius: 4px; font-size: 12px; font-weight: 600;
           color: #14161a; white-space: nowrap; }
  .overall { font-size: 14px; padding: 4px 12px; }
  .meta { color: #8c93a0; font-size: 13px; margin-top: 4px; }
  .muted { color: #6b7280; }
  .summary { color: #a8adb8; font-size: 12px; margin-top: 4px; }
  .stat { color: #8c93a0; font-size: 12px; font-variant-numeric: tabular-nums; }
  .mismatch { display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .mismatch.warn { background: #d7ba7d; color: #14161a; }
  ul { margin: 8px 0; padding-left: 22px; }
  .shot { max-width: 100%; border: 1px solid #2c3038; border-radius: 6px; margin-top: 10px; }
</style>
</head>
<body>
<h1>Доказательство выполнения</h1>
<p>${badge(art.overall)} <span class="overall">${escapeHtml(OVERALL_RU[art.overall])}</span></p>
<p class="meta">${escapeHtml(art.taskSummary)}</p>
<p class="meta">DoD: ${passedCount}/${art.checks.length} · ${created}${art.runId ? ` · run ${escapeHtml(art.runId)}` : ''}</p>

<h2>Проверки</h2>
<table>
<thead><tr><th>Команда</th><th>Статус</th><th>exit</th><th>Вывод</th></tr></thead>
<tbody>
${checksRows}
</tbody>
</table>

<h2>Изменённые файлы</h2>
<ul>
${filesList}
</ul>

<h2>Риски</h2>
${risksList}
${screenshot}
</body>
</html>
`
}
