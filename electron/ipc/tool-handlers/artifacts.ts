// Artifact-хендлеры: render_chart / generate_html / generate_docx.
// Вынесено из tool-handlers.ts (распил монолита) — поведение без изменений.
import type { ToolHandler } from './shared'

export const renderChartHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const { renderChartSvg } = await import('../../ai/charts')
      const { artifactsDir } = await import('../../ai/artifacts')
      const { mkdir, writeFile } = await import('fs/promises')
      const { join } = await import('path')
      const filename = String(call.args.filename ?? 'chart').replace(/[^a-zA-Z0-9а-яА-ЯёЁ_\-.,()\s]/g, '_').slice(0, 100) + '.svg'
      const kind = String(call.args.kind ?? 'bar') as 'bar' | 'line' | 'pie'
      const labels = Array.isArray(call.args.labels) ? call.args.labels.map(String) : []
      const values = Array.isArray(call.args.values) ? call.args.values.map(Number) : []
      if (labels.length === 0 || labels.length !== values.length) {
        return { id: call.id, name: call.name, result: '', error: 'render_chart: labels и values должны быть одинаковой длины и непустые' }
      }
      const svg = renderChartSvg({
        kind, labels, values,
        title: call.args.title ? String(call.args.title) : undefined,
        xAxisLabel: call.args.x_axis_label ? String(call.args.x_axis_label) : undefined,
        yAxisLabel: call.args.y_axis_label ? String(call.args.y_axis_label) : undefined
      })
      const dir = artifactsDir(ctx.projectPath)
      await mkdir(dir, { recursive: true })
      const path = join(dir, filename)
      await writeFile(path, svg, 'utf8')
      try { ctx.recordJournal(ctx.projectPath, 'tool', `📊 Диаграмма ${kind}: ${filename}`, `${svg.length} bytes → ${path}`) } catch { /* */ }
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-activity', callId: call.id, name: 'render_chart', label: 'render_chart', detail: `${filename} · ${kind} · ${labels.length} точек`, status: 'ok' }
      })
      // Timeline задачи (Фаза 4): диаграмма — тоже артефакт. label=имя, ref=путь.
      try { ctx.recordRunEvent?.('artifact', { label: filename, ref: path, status: 'ok' }) } catch { /* best-effort */ }
      return { id: call.id, name: call.name, result: `Chart saved: ${path}\nKind: ${kind}, ${labels.length} data points.\nИспользуй в HTML: <img src="${filename}"> (относительно той же папки артефактов).` }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

export const generateHtmlHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const { generateHtml } = await import('../../ai/artifacts')
      const filename = String(call.args.filename ?? 'untitled')
      const title = call.args.title ? String(call.args.title) : undefined
      const content = String(call.args.content_html ?? '')
      if (!content) return { id: call.id, name: call.name, result: '', error: 'generate_html: content_html обязателен' }
      const res = await generateHtml(ctx.projectPath, { filename, title, content_html: content })
      try { ctx.recordJournal(ctx.projectPath, 'tool', `📄 Артефакт HTML: ${res.filename}`, `${res.sizeBytes} bytes → ${res.path}`) } catch { /* */ }
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-activity', callId: call.id, name: 'generate_html', label: 'generate_html', detail: `${res.filename} · ${(res.sizeBytes / 1024).toFixed(1)}KB`, status: 'ok' }
      })
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'artifact-created', callId: call.id, kind: 'html', filename: res.filename, path: res.path, sizeBytes: res.sizeBytes }
      })
      // Timeline задачи (Фаза 4): создан артефакт. label=имя файла, ref=путь.
      try { ctx.recordRunEvent?.('artifact', { label: res.filename, ref: res.path, status: 'ok' }) } catch { /* best-effort */ }
      return { id: call.id, name: call.name, result: `HTML artifact saved: ${res.path}\nSize: ${res.sizeBytes} bytes` }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

export const generateDocxHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const { generateDocx } = await import('../../ai/artifacts')
      const filename = String(call.args.filename ?? 'untitled')
      const title = call.args.title ? String(call.args.title) : undefined
      const sections = Array.isArray(call.args.sections) ? call.args.sections as Array<{ heading?: string; level?: number; paragraphs?: string[]; bullets?: string[] }> : []
      if (sections.length === 0) return { id: call.id, name: call.name, result: '', error: 'generate_docx: sections обязательны (>= 1)' }
      const res = await generateDocx(ctx.projectPath, { filename, title, sections })
      try { ctx.recordJournal(ctx.projectPath, 'tool', `📄 Артефакт DOCX: ${res.filename}`, `${res.sizeBytes} bytes → ${res.path}`) } catch { /* */ }
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-activity', callId: call.id, name: 'generate_docx', label: 'generate_docx', detail: `${res.filename} · ${(res.sizeBytes / 1024).toFixed(1)}KB`, status: 'ok' }
      })
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'artifact-created', callId: call.id, kind: 'docx', filename: res.filename, path: res.path, sizeBytes: res.sizeBytes }
      })
      // Timeline задачи (Фаза 4): создан артефакт. label=имя файла, ref=путь.
      try { ctx.recordRunEvent?.('artifact', { label: res.filename, ref: res.path, status: 'ok' }) } catch { /* best-effort */ }
      return { id: call.id, name: call.name, result: `DOCX artifact saved: ${res.path}\nSize: ${res.sizeBytes} bytes` }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}
