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
import { join, dirname, resolve, sep } from 'path'
import { Document, Paragraph, HeadingLevel, TextRun, Packer, Table, TableRow, TableCell, WidthType } from 'docx'
import { renderVerificationHtml, type VerificationArtifact } from './verification'
import { defaultDownloadsDir, isWithinKnownRoots } from './path-policy'
import { isForbiddenPath } from './secret-scanner'

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

/**
 * Назначение DOCX — ЗАКРЫТЫЙ ПЕРЕЧЕНЬ, а НЕ свободный путь. Свободная строка пути
 * в аргументе инструмента была бы примитивом записи куда угодно (класс, который
 * закрывали в unrevert). Модель выбирает одно из трёх; конкретный каталог считает
 * НАШ код, поэтому неизвестное значение схлопывается в 'project' — никогда в путь.
 *   · project (по умолчанию) — .verstak/artifacts/{дата}/ внутри проекта;
 *   · alongside — РЯДОМ С МАТЕРИАЛАМИ, которые назвал человек: папка материалов
 *     (ctx.materialsDir — задана папкой в композере), когда известна; иначе корень
 *     проекта. «Рядом» значит рядом с тем, что человек назвал, а не в корне вслепую;
 *   · downloads — папка Загрузок.
 */
export type DocxSaveTo = 'project' | 'alongside' | 'downloads'

export function resolveDocxDir(
  saveTo: DocxSaveTo | string | undefined,
  ctx: { projectPath: string; downloadsDir?: string; materialsDir?: string }
): string {
  switch (saveTo) {
    case 'downloads': return ctx.downloadsDir ?? defaultDownloadsDir()
    // «рядом с материалами» = папка материалов, когда известна; иначе — корень
    // проекта (прежнее поведение, когда папки материалов нет).
    case 'alongside': return ctx.materialsDir ?? ctx.projectPath
    case 'project':
    case undefined:
    default: return artifactsDir(ctx.projectPath)
  }
}

/** Общий каталог-предок двух абсолютных путей (по сегментам). Нет общего — ''. */
function longestCommonDir(a: string, b: string): string {
  const as = a.split(sep)
  const bs = b.split(sep)
  const out: string[] = []
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    if (as[i] === bs[i]) out.push(as[i])
    else break
  }
  return out.join(sep)
}

/**
 * Каталог для alongside, ВЫВЕДЕННЫЙ ИЗ ФАКТА: общий каталог-предок файлов, реально
 * прочитанных в этом прогоне. Это наблюдение, а не толкование намерения — «рядом с
 * материалами» = рядом с тем, что модель действительно читала. ЖЁСТКИЙ ГАРД: результат
 * НИКОГДА не выходит за корень проекта (предок выше/вне корня → зажимаем в корень), иначе
 * из данных, которыми управляет модель, получилась бы запись за пределы проекта. Пусто,
 * если ничего не читали — вызывающий тогда падает на корень проекта (прежнее поведение).
 */
export function commonReadDir(readPaths: string[], projectRoot: string): string | undefined {
  const root = resolve(projectRoot)
  const dirs = readPaths
    .filter(p => typeof p === 'string' && p.length > 0)
    .map(p => dirname(resolve(root, p)))
  if (dirs.length === 0) return undefined
  let common = dirs[0]
  for (const d of dirs.slice(1)) common = longestCommonDir(common, d)
  // Гард: только внутри корня проекта. Выше/вне (в т.ч. пустой общий предок) → корень.
  return common && isWithinKnownRoots(common, [root]) ? common : root
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

interface TableInput {
  /** Строка заголовков (жирная, помечается tableHeader). Необязательна. */
  header?: string[]
  /** Строки данных: массив ячеек-строк. */
  rows: string[][]
}

interface SectionInput {
  heading?: string
  level?: number
  paragraphs?: string[]
  bullets?: string[]
  /** Настоящая Word-таблица (для «таблицы выводов»), а не подделка булитами. */
  table?: TableInput
}

/** Собрать настоящую таблицу Word из header + rows. */
function buildTable(t: TableInput): Table {
  const rows: TableRow[] = []
  if (t.header?.length) {
    rows.push(new TableRow({
      tableHeader: true,
      children: t.header.map(h => new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: String(h), bold: true })] })]
      }))
    }))
  }
  for (const r of t.rows ?? []) {
    rows.push(new TableRow({
      children: (r ?? []).map(c => new TableCell({
        children: [new Paragraph({ children: [new TextRun(String(c))] })]
      }))
    }))
  }
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })
}

export async function generateDocx(
  projectPath: string,
  args: { filename: string; title?: string; sections: SectionInput[]; save_to?: DocxSaveTo | string },
  opts?: { downloadsDir?: string; materialsDir?: string }
): Promise<ArtifactResult> {
  const downloadsDir = opts?.downloadsDir ?? defaultDownloadsDir()
  const materialsDir = opts?.materialsDir
  const dir = resolveDocxDir(args.save_to, { projectPath, downloadsDir, materialsDir })
  const filename = `${sanitizeFilename(args.filename)}.docx`
  const path = join(dir, filename)
  // Проверка путей стоит и на этом пути (назначение открывает запись за пределы
  // .verstak). Проверяем КАТАЛОГ: он считается нашим кодом из перечня и обязан
  // лежать в проекте ИЛИ в Downloads. Файл из каталога не выйдет — sanitizeFilename
  // убирает разделители (проверять здесь полный путь нельзя: имя, санитайзенное из
  // «../../x», начинается с точек и наивная строковая проверка сочла бы его выходом).
  // materialsDir разрешён как назначение alongside: он уже прогнан через
  // isWithinKnownRoots на входе (ai.ts, композер), т.е. это доверенный корень.
  const allowedRoots = materialsDir ? [projectPath, downloadsDir, materialsDir] : [projectPath, downloadsDir]
  if (!isWithinKnownRoots(dir, allowedRoots)) {
    throw new Error(`Каталог DOCX вне разрешённых папок (проект / материалы / Загрузки): ${dir}`)
  }
  if (isForbiddenPath(path) || isForbiddenPath(filename)) {
    throw new Error(`Запись артефакта запрещена политикой безопасности: ${path}`)
  }
  await mkdir(dir, { recursive: true })

  const children: (Paragraph | Table)[] = []
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
    if (sec.table && (sec.table.rows?.length || sec.table.header?.length)) {
      children.push(buildTable(sec.table))
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
    case undefined:
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
