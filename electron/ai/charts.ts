/**
 * SVG chart renderer — простой bar/line/pie без npm зависимостей.
 *
 * Источник: V3 Plan раздел 4.4 (Artifact layer / render_chart).
 *
 * Зачем своя реализация:
 *  - chartjs-node-canvas требует native canvas (тяжёлая сборка на Electron).
 *  - Для агентских отчётов нужны простые визуализации, не интерактивные графики.
 *  - SVG = scalable, легко эмбедится в HTML артефакты и DOCX (через base64).
 *
 * Поддержка: bar (vertical), line, pie. Палитра — основные цвета GG темы.
 *
 * Возвращает строку с готовым <svg>…</svg>. Дальше можно сохранить как файл
 * или вставить в HTML/DOCX артефакт.
 */

export type ChartKind = 'bar' | 'line' | 'pie'

export interface ChartInput {
  kind: ChartKind
  title?: string
  /** Метки оси X (или сегментов pie). */
  labels: string[]
  /** Значения. Длина = labels.length. */
  values: number[]
  /** Опциональные тематические подписи. */
  xAxisLabel?: string
  yAxisLabel?: string
  /** Ширина SVG в пикселях (default 600). */
  width?: number
  /** Высота SVG в пикселях (default 360). */
  height?: number
}

const PALETTE = ['#5b8dff', '#4ec9b0', '#d7ba7d', '#c668ff', '#f47174', '#7aa3ff', '#3a6ee8', '#1f9d80']

export function renderChartSvg(input: ChartInput): string {
  const w = input.width ?? 600
  const h = input.height ?? 360
  if (input.labels.length !== input.values.length || input.labels.length === 0) {
    return errorSvg('labels.length должен совпадать с values.length и быть > 0')
  }
  switch (input.kind) {
    case 'bar': return renderBar(input, w, h)
    case 'line': return renderLine(input, w, h)
    case 'pie': return renderPie(input, w, h)
  }
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!))
}

function errorSvg(msg: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="80">
    <rect width="100%" height="100%" fill="#f47174" opacity="0.1"/>
    <text x="20" y="45" font-family="sans-serif" font-size="13" fill="#f47174">⚠ chart: ${escapeXml(msg)}</text>
  </svg>`
}

function renderBar(input: ChartInput, w: number, h: number): string {
  const margin = { top: input.title ? 36 : 16, right: 16, bottom: 50, left: 50 }
  const chartW = w - margin.left - margin.right
  const chartH = h - margin.top - margin.bottom
  const maxVal = Math.max(...input.values, 0)
  const minVal = Math.min(...input.values, 0)
  const range = maxVal - minVal || 1
  const barWidth = (chartW / input.values.length) * 0.7
  const barGap = (chartW / input.values.length) * 0.3

  const bars = input.values.map((v, i) => {
    const barH = (Math.abs(v) / range) * chartH
    const x = margin.left + (i + 0.5) * (chartW / input.values.length) - barWidth / 2
    const y = margin.top + chartH - (v >= 0 ? barH : 0)
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barH.toFixed(1)}" fill="${PALETTE[i % PALETTE.length]}" rx="2"/>
      <text x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" font-size="11" fill="#1a1d22">${formatNumber(v)}</text>`
  }).join('\n')

  const xLabels = input.labels.map((label, i) => {
    const x = margin.left + (i + 0.5) * (chartW / input.values.length)
    const y = margin.top + chartH + 18
    return `<text x="${x.toFixed(1)}" y="${y}" text-anchor="middle" font-size="11" fill="#545a64">${escapeXml(label.slice(0, 20))}</text>`
  }).join('\n')

  return svgWrap(w, h, input.title, `
    ${axis(margin, chartW, chartH, maxVal, minVal)}
    ${bars}
    ${xLabels}
    ${input.yAxisLabel ? `<text x="14" y="${(margin.top + chartH / 2).toFixed(1)}" font-size="11" fill="#8c93a0" transform="rotate(-90 14 ${(margin.top + chartH / 2).toFixed(1)})">${escapeXml(input.yAxisLabel)}</text>` : ''}
  `)
}

function renderLine(input: ChartInput, w: number, h: number): string {
  const margin = { top: input.title ? 36 : 16, right: 16, bottom: 50, left: 50 }
  const chartW = w - margin.left - margin.right
  const chartH = h - margin.top - margin.bottom
  const maxVal = Math.max(...input.values, 0)
  const minVal = Math.min(...input.values, 0)
  const range = maxVal - minVal || 1

  const points = input.values.map((v, i) => {
    const x = margin.left + (input.values.length === 1 ? chartW / 2 : (i * chartW) / (input.values.length - 1))
    const y = margin.top + chartH - ((v - minVal) / range) * chartH
    return { x, y, v }
  })
  const path = 'M ' + points.map(p => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ')
  const dots = points.map(p =>
    `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="${PALETTE[0]}"/>
     <text x="${p.x.toFixed(1)}" y="${(p.y - 8).toFixed(1)}" text-anchor="middle" font-size="10" fill="#1a1d22">${formatNumber(p.v)}</text>`
  ).join('\n')
  const xLabels = input.labels.map((label, i) => {
    const x = margin.left + (input.values.length === 1 ? chartW / 2 : (i * chartW) / (input.values.length - 1))
    return `<text x="${x.toFixed(1)}" y="${(margin.top + chartH + 18).toFixed(1)}" text-anchor="middle" font-size="11" fill="#545a64">${escapeXml(label.slice(0, 20))}</text>`
  }).join('\n')

  return svgWrap(w, h, input.title, `
    ${axis(margin, chartW, chartH, maxVal, minVal)}
    <path d="${path}" stroke="${PALETTE[0]}" stroke-width="2.5" fill="none"/>
    ${dots}
    ${xLabels}
  `)
}

function renderPie(input: ChartInput, w: number, h: number): string {
  const cx = w / 2
  const cy = (input.title ? 36 : 16) + (h - (input.title ? 36 : 16)) / 2 - 10
  const radius = Math.min(w, h - (input.title ? 36 : 16) - 20) / 3
  const total = input.values.reduce((a, b) => a + b, 0)
  if (total === 0) return errorSvg('pie chart: сумма значений = 0')

  let cumulative = 0
  const slices = input.values.map((v, i) => {
    const startAngle = (cumulative / total) * 2 * Math.PI - Math.PI / 2
    cumulative += v
    const endAngle = (cumulative / total) * 2 * Math.PI - Math.PI / 2
    const x1 = cx + radius * Math.cos(startAngle)
    const y1 = cy + radius * Math.sin(startAngle)
    const x2 = cx + radius * Math.cos(endAngle)
    const y2 = cy + radius * Math.sin(endAngle)
    const largeArc = (v / total) > 0.5 ? 1 : 0
    const path = `M ${cx} ${cy} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${radius} ${radius} 0 ${largeArc} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z`
    const midAngle = (startAngle + endAngle) / 2
    const labelX = cx + (radius + 18) * Math.cos(midAngle)
    const labelY = cy + (radius + 18) * Math.sin(midAngle)
    const pct = Math.round((v / total) * 100)
    return `<path d="${path}" fill="${PALETTE[i % PALETTE.length]}" stroke="#fff" stroke-width="2"/>
      <text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" font-size="11" fill="#1a1d22">${escapeXml(input.labels[i].slice(0, 18))} (${pct}%)</text>`
  }).join('\n')

  return svgWrap(w, h, input.title, slices)
}

function axis(margin: { top: number; left: number }, chartW: number, chartH: number, maxVal: number, minVal: number): string {
  // Простые горизонтальные сетки на 0, 25, 50, 75, 100%.
  const lines: string[] = []
  for (let i = 0; i <= 4; i++) {
    const y = margin.top + (chartH * i) / 4
    const val = maxVal - ((maxVal - minVal) * i) / 4
    lines.push(`<line x1="${margin.left}" y1="${y.toFixed(1)}" x2="${margin.left + chartW}" y2="${y.toFixed(1)}" stroke="#e6e8ec" stroke-width="1" stroke-dasharray="2,3"/>`)
    lines.push(`<text x="${margin.left - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#8c93a0">${formatNumber(val)}</text>`)
  }
  return lines.join('\n')
}

function svgWrap(w: number, h: number, title: string | undefined, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">
    <rect width="100%" height="100%" fill="#ffffff"/>
    ${title ? `<text x="${w / 2}" y="22" text-anchor="middle" font-size="14" font-weight="600" fill="#1a1d22">${escapeXml(title)}</text>` : ''}
    ${body}
  </svg>`
}

function formatNumber(n: number): string {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  if (Number.isInteger(n)) return String(n)
  return n.toFixed(2)
}
