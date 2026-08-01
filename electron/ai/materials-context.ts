/**
 * VSK-PRODUCT-A1 3b (часть 2/2): вывод НАБОРА материалов (M) и источника на старте
 * прогона. Ядро сводки (materials-summary.ts) считает исходы; здесь — откуда берётся
 * САМ набор и его источник.
 *
 * У двух источников РАЗНАЯ ПРАВДА, и путать их нельзя:
 *  · ВЛОЖЕНИЯ — read-инструменты по ним НЕ вызываются вообще; docx разворачивается в
 *    текст на сервере (attachment-text), прочие документные типы доставляются модели
 *    инлайном. Исход берётся ИЗ КОНВЕЙЕРА, а не из tool-вызовов; категории «не открывал»
 *    у вложений НЕТ по построению (их не выбирают — они все пришли).
 *  · ПАПКА — M = документы В КОРНЕ выбранного каталога (без рекурсии); исходы трекаются
 *    read-вызовами в самом прогоне (runner-api), «не открывал» здесь осмысленно.
 */
import { readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { ChatMessage } from './types'
import type { ReadOutcome } from './materials-summary'
import { extractOfficeAttachment, isOfficeAttachment } from './attachment-text'

/** Документные расширения набора (общие для папки и вложений). Совпадает с accept
 *  композера по документам; изображения материалами НЕ считаются. */
export const DOC_EXTENSIONS = new Set(['.docx', '.xlsx', '.pdf', '.txt', '.md', '.csv'])

export function isDocumentName(name: string): boolean {
  return DOC_EXTENSIONS.has(extname(name).toLowerCase())
}

/** Исходы КОНВЕЙЕРА вложений последнего пользовательского хода. null — документных
 *  вложений нет. Каждый материал получает исход → notOpened у вложений всегда пуст. */
export async function deriveAttachmentMaterials(
  lastUser: ChatMessage | null | undefined,
): Promise<{ items: string[]; outcomes: ReadOutcome[] } | null> {
  const atts = (lastUser?.attachments ?? []).filter(a => isOfficeAttachment(a) || isDocumentName(a.name))
  if (atts.length === 0) return null
  const items: string[] = []
  const outcomes: ReadOutcome[] = []
  for (const a of atts) {
    items.push(a.name)
    if (isOfficeAttachment(a)) {
      // docx/xlsx разворачиваются на сервере (mammoth/exceljs) — исход из конвейера.
      const res = await extractOfficeAttachment(a)
      outcomes.push(res.ok ? { path: a.name, ok: true } : { path: a.name, ok: false, reason: res.reason })
    } else {
      // pdf/txt/md/csv доставляются модели инлайном — считаем прочитанными.
      outcomes.push({ path: a.name, ok: true })
    }
  }
  return { items, outcomes }
}

/** Документы В КОРНЕ папки (без рекурсии), абсолютными путями, отсортированы.
 *  Граница набора НАМЕРЕННО плоская: материалы в подпапках в M не входят — строка
 *  сводки называет эту границу явно («В корне папки N документов»). */
export function listFolderMaterials(root: string): string[] {
  let entries: string[]
  try { entries = readdirSync(root) } catch { return [] }
  const out: string[] = []
  for (const name of entries) {
    if (!isDocumentName(name)) continue
    const abs = join(root, name)
    try { if (statSync(abs).isFile()) out.push(abs) } catch { /* недоступный элемент пропускаем */ }
  }
  return out.sort()
}
