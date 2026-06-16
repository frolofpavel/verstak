/**
 * Генератор артефактов — HTML и DOCX. Сохраняются в
 * {projectPath}/.verstak/artifacts/{YYYY-MM-DD}/{filename}.{ext}
 *
 * Источник: V3 Plan раздел 8.
 *
 * Возвращает {path, kind, sizeBytes} — путь к файлу для preview pane или
 * для send_document через telegram коннектор.
 */

import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { Document, Paragraph, HeadingLevel, TextRun, Packer } from 'docx'
import { renderVerificationHtml, type VerificationArtifact } from './verification'

export interface ArtifactResult {
  path: string
  kind: 'html' | 'docx'
  sizeBytes: number
  filename: string
}

/** Корень для артефактов внутри проекта. */
export function artifactsDir(projectPath: string): string {
  const today = new Date()
  const y = today.getFullYear()
  const m = String(today.getMonth() + 1).padStart(2, '0')
  const d = String(today.getDate()).padStart(2, '0')
  return join(projectPath, '.verstak', 'artifacts', `${y}-${m}-${d}`)
}

export function sanitizeFilename(name: string): string {
  // Убираем расширение если случайно дано, и опасные символы.
  return name
    .replace(/\.(html?|docx?|pdf|md|txt)$/i, '')
    .replace(/[^a-zA-Z0-9а-яА-ЯёЁ_\-.,()\s]/g, '_')
    .slice(0, 120) || 'artifact'
}

// ----------------------------------------------------------------- HTML

export async function generateHtml(
  projectPath: string,
  args: { filename: string; title?: string; content_html: string }
): Promise<ArtifactResult> {
  const dir = artifactsDir(projectPath)
  await mkdir(dir, { recursive: true })
  const filename = `${sanitizeFilename(args.filename)}.html`
  const path = join(dir, filename)
  const html = wrapHtml(args.title, args.content_html)
  await writeFile(path, html, 'utf8')
  return { path, kind: 'html', sizeBytes: Buffer.byteLength(html, 'utf8'), filename }
}

function wrapHtml(title: string | undefined, body: string): string {
  const safeTitle = (title ?? 'Документ').replace(/</g, '&lt;')
  // Body уже может содержать <style> — оборачиваем без дополнительных нарушений
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
         max-width: 900px; margin: 40px auto; padding: 0 24px; line-height: 1.6;
         color: #1a1d22; }
  h1 { font-size: 28px; margin-top: 0; letter-spacing: -0.015em; }
  h2 { font-size: 22px; border-bottom: 1px solid #e6e8ec; padding-bottom: 6px; margin-top: 40px; }
  h3 { font-size: 17px; margin-top: 24px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th { background: #f5f7fa; padding: 8px 12px; text-align: left; border-bottom: 2px solid #e6e8ec; }
  td { padding: 8px 12px; border-bottom: 1px solid #e6e8ec; vertical-align: top; }
  code { background: #f5f7fa; padding: 1px 5px; border-radius: 3px; font-family: 'Consolas', monospace; }
  pre { background: #f5f7fa; padding: 14px; border-radius: 6px; overflow-x: auto; }
</style>
</head>
<body>
${body}
</body>
</html>
`
}

// ----------------------------------------------------------------- DOCX

interface SectionInput {
  heading?: string
  level?: number
  paragraphs?: string[]
  bullets?: string[]
}

export async function generateDocx(
  projectPath: string,
  args: { filename: string; title?: string; sections: SectionInput[] }
): Promise<ArtifactResult> {
  const dir = artifactsDir(projectPath)
  await mkdir(dir, { recursive: true })
  const filename = `${sanitizeFilename(args.filename)}.docx`
  const path = join(dir, filename)

  const children: Paragraph[] = []
  if (args.title) {
    children.push(new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: args.title, bold: true, size: 36 })]
    }))
  }

  for (const sec of args.sections ?? []) {
    if (sec.heading) {
      const level = pickHeadingLevel(sec.level)
      children.push(new Paragraph({
        heading: level,
        children: [new TextRun({ text: sec.heading, bold: true })]
      }))
    }
    for (const p of sec.paragraphs ?? []) {
      children.push(new Paragraph({ children: [new TextRun(p)] }))
    }
    for (const b of sec.bullets ?? []) {
      children.push(new Paragraph({
        bullet: { level: 0 },
        children: [new TextRun(b)]
      }))
    }
  }

  const doc = new Document({
    creator: 'Verstak',
    sections: [{ properties: {}, children }]
  })
  const buf = await Packer.toBuffer(doc)
  await writeFile(path, buf)
  return { path, kind: 'docx', sizeBytes: buf.length, filename }
}

function pickHeadingLevel(level: number | undefined): typeof HeadingLevel[keyof typeof HeadingLevel] {
  switch (level) {
    case 1: return HeadingLevel.HEADING_1
    case 3: return HeadingLevel.HEADING_3
    case 2:
    default: return HeadingLevel.HEADING_2
  }
}

// --------------------------------------------------- Verification (DoD)

/**
 * Пишет verification-артефакт парой файлов в ту же artifactsDir/{date}/:
 *  - {slug}.verification.json — источник истины (JSON.stringify(art));
 *  - {slug}.verification.html — рендер для preview.
 * slug = sanitizeFilename(taskSummary) с fallback 'verification'.
 * Пути берутся через те же хелперы, что generateHtml — без дублирования логики.
 * sizeBytes — размер html.
 */
export async function writeVerificationArtifact(
  projectPath: string,
  art: VerificationArtifact
): Promise<{ jsonPath: string; htmlPath: string; sizeBytes: number; filename: string }> {
  const dir = artifactsDir(projectPath)
  await mkdir(dir, { recursive: true })
  const baseSlug = sanitizeFilename(art.taskSummary || 'verification') || 'verification'
  // Суффикс уникальности — без него повторная аттестация похожей задачи затирала
  // прежний .verification.json/.html (объявленный источником истины), а строка в
  // БД продолжала на него указывать (аудит P1). runId короткий, иначе timestamp.
  const suffix = art.runId ? art.runId.slice(0, 8) : art.createdAt.toString(36)
  const slug = `${baseSlug}-${suffix}`
  const jsonName = `${slug}.verification.json`
  const htmlName = `${slug}.verification.html`
  const jsonPath = join(dir, jsonName)
  const htmlPath = join(dir, htmlName)
  const html = renderVerificationHtml(art)
  await writeFile(jsonPath, JSON.stringify(art, null, 2), 'utf8')
  await writeFile(htmlPath, html, 'utf8')
  return { jsonPath, htmlPath, sizeBytes: Buffer.byteLength(html, 'utf8'), filename: htmlName }
}
