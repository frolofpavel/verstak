import { Buffer } from 'node:buffer'
import { extractDocxTextFromBuffer, extractXlsxTextFromBuffer } from './office'
import type { Attachment, ChatMessage } from './types'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export function isDocxAttachment(att: Attachment): boolean {
  if (att.mimeType === DOCX_MIME) return true
  return /\.docx$/i.test(att.name)
}

export function isXlsxAttachment(att: Attachment): boolean {
  if (att.mimeType === XLSX_MIME) return true
  return /\.xlsx$/i.test(att.name)
}

/** Office-вложение, которое сервер разворачивает в текст (провайдеры бинарь не
 *  читают): docx (mammoth) или xlsx (exceljs). */
export function isOfficeAttachment(att: Attachment): boolean {
  return isDocxAttachment(att) || isXlsxAttachment(att)
}

/** Исход конвейера по ОДНОМУ office-вложению — единый источник и для инлайна текста
 *  (expandOfficeAttachments), и для код-сводки материалов (materials-context). */
export type OfficeExtraction = { ok: true; text: string } | { ok: false; reason: string }
/** @deprecated старое имя — оставлено как мост до полной миграции потребителей. */
export type DocxExtraction = OfficeExtraction

export async function extractDocxAttachment(att: Attachment): Promise<OfficeExtraction> {
  try {
    const text = await extractDocxTextFromBuffer(Buffer.from(att.data, 'base64'))
    return { ok: true, text }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export async function extractXlsxAttachment(att: Attachment): Promise<OfficeExtraction> {
  try {
    const text = await extractXlsxTextFromBuffer(Buffer.from(att.data, 'base64'))
    return { ok: true, text }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** Исход конвейера по любому office-вложению (диспетчер по типу). */
export async function extractOfficeAttachment(att: Attachment): Promise<OfficeExtraction> {
  return isXlsxAttachment(att) ? extractXlsxAttachment(att) : extractDocxAttachment(att)
}

/**
 * Office-вложения чата (docx/xlsx) → текст в content. Бинарник убираем из
 * attachments — провайдеры его не читают.
 */
export async function expandOfficeAttachments(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const out: ChatMessage[] = []
  for (const m of messages) {
    if (m.role !== 'user' || !m.attachments?.some(isOfficeAttachment)) {
      out.push(m)
      continue
    }
    const officeAtts = m.attachments.filter(isOfficeAttachment)
    const blocks: string[] = []
    for (const att of officeAtts) {
      const res = await extractOfficeAttachment(att)
      if (res.ok) blocks.push(`--- Содержимое вложения «${att.name}» ---\n${res.text}`)
      else blocks.push(`--- Вложение «${att.name}»: не удалось извлечь текст (${res.reason}) ---`)
    }
    const prefix = blocks.join('\n\n')
    const content = m.content ? `${prefix}\n\n${m.content}` : prefix
    const attachments = m.attachments.filter(a => !isOfficeAttachment(a))
    out.push({
      ...m,
      content,
      attachments: attachments.length > 0 ? attachments : undefined,
    })
  }
  return out
}
