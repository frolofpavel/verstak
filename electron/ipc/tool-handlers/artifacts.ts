// Artifact-хендлеры: render_chart / generate_html / generate_docx.
// Вынесено из tool-handlers.ts (распил монолита) — поведение без изменений.
import type { ToolHandler } from './shared'
import { resolveDecision } from '../../ai/permission-rules'
import { blockReason } from '../../ai/mode-policy'
import type { ToolCall } from '../../ai/types'

/**
 * Гейт режима для артефактов (седьмой обход, 08.08). Артефакты ПИШУТ ФАЙЛ на диск, но
 * хендлеры не звали resolveDecision → проходили во ВСЕХ режимах, включая plan. Теперь
 * блокируем в plan (mode-policy классифицирует их как мутацию: block в plan, иначе auto).
 * confirm им не возвращается (нет модалки), поэтому проверяем только 'block'. Возвращает
 * error-результат для блокировки, либо null — тогда хендлер выполняется.
 */
export function artifactModeBlock(call: ToolCall, ctx: Parameters<ToolHandler['handle']>[1]): { id: string; name: string; result: ''; error: string } | null {
  const { decision, reason } = resolveDecision(call.name, call.args, ctx.agentMode, ctx.autoApprove, ctx.permissionRules)
  if (decision === 'block') {
    return { id: call.id, name: call.name, result: '', error: reason ?? blockReason(call.name, ctx.agentMode) }
  }
  return null
}

export const renderChartHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const blocked = artifactModeBlock(call, ctx)
      if (blocked) return blocked
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
      const blocked = artifactModeBlock(call, ctx)
      if (blocked) return blocked
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
      const blocked = artifactModeBlock(call, ctx)
      if (blocked) return blocked
      const { generateDocx } = await import('../../ai/artifacts')
      const filename = String(call.args.filename ?? 'untitled')
      const title = call.args.title ? String(call.args.title) : undefined
      const sections = Array.isArray(call.args.sections) ? call.args.sections as Array<{ heading?: string; level?: number; paragraphs?: string[]; bullets?: string[]; table?: { header?: string[]; rows: string[][] } }> : []
      if (sections.length === 0) return { id: call.id, name: call.name, result: '', error: 'generate_docx: sections обязательны (>= 1)' }
      // ЗАДАЧА 2: явный save_to модели побеждает; при его молчании — дефолт из
      // источника материалов (папка→alongside, вложения→downloads), заполняющий
      // пустоту, а не спорящий с моделью. Итог — «туда, где человек найдёт».
      const saveTo = call.args.save_to != null ? String(call.args.save_to) : ctx.defaultDocxSaveTo
      // ЗАДАЧА A: alongside → папка материалов. Приоритет: папка из композера
      // (ctx.materialsDir), иначе общий каталог реально прочитанных файлов (вариант i,
      // зажат в корень). Оба известны — материалы из папки, поэтому composer выигрывает.
      const materialsDir = ctx.materialsDir ?? ctx.getReadCommonDir?.()
      const res = await generateDocx(ctx.projectPath, { filename, title, sections, save_to: saveTo },
        { downloadsDir: ctx.artifactsDownloadsDir, materialsDir })
      try { ctx.recordJournal(ctx.projectPath, 'tool', `📄 Артефакт DOCX: ${res.filename}`, `${res.sizeBytes} bytes → ${res.path}`) } catch { /* */ }
      // ЗАДАЧА 2 (§3.1 видимый след): дефолт мог СМЕНИТЬ место записи (рядом/в
      // Загрузки), поэтому строка активности называет ПОЛНЫЙ ПУТЬ, а не только имя —
      // иначе «не нашёл файл» неотличимо от «файл не создан». Путь виден в таймлайне
      // независимо от того, повторит ли его модель в тексте ответа.
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-activity', callId: call.id, name: 'generate_docx', label: 'generate_docx', detail: `${res.filename} · ${(res.sizeBytes / 1024).toFixed(1)}KB · ${res.path}`, status: 'ok' }
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
