import { Buffer } from 'node:buffer'
import { extractDocxTextFromBuffer } from './office'
import type { Attachment, ChatMessage } from './types'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export function isDocxAttachment(att: Attachment): boolean {
  if (att.mimeType === DOCX_MIME) return true
  return /\.docx$/i.test(att.name)
}

/** Исход конвейера по ОДНОМУ docx-вложению — единый источник и для инлайна текста
 *  (expandOfficeAttachments), и для код-сводки материалов (materials-context). */
export type DocxExtraction = { ok: true; text: string } | { ok: false; reason: string }

export async function extractDocxAttachment(att: Attachment): Promise<DocxExtraction> {
  try {
    const text = await extractDocxTextFromBuffer(Buffer.from(att.data, 'base64'))
    return { ok: true, text }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * DOCX во вложениях чата → текст в content (mammoth).
 * Бинарник docx убираем из attachments — провайдеры его не читают.
 */
export async function expandOfficeAttachments(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const out: ChatMessage[] = []
  for (const m of messages) {
    if (m.role !== 'user' || !m.attachments?.some(isDocxAttachment)) {
      out.push(m)
      continue
    }
    const docxAtts = m.attachments.filter(isDocxAttachment)
    const blocks: string[] = []
    for (const att of docxAtts) {
      const res = await extractDocxAttachment(att)
      if (res.ok) blocks.push(`--- Содержимое вложения «${att.name}» ---\n${res.text}`)
      else blocks.push(`--- Вложение «${att.name}»: не удалось извлечь текст (${res.reason}) ---`)
    }
    const prefix = blocks.join('\n\n')
    const content = m.content ? `${prefix}\n\n${m.content}` : prefix
    const attachments = m.attachments.filter(a => !isDocxAttachment(a))
    out.push({
      ...m,
      content,
      attachments: attachments.length > 0 ? attachments : undefined,
    })
  }
  return out
}