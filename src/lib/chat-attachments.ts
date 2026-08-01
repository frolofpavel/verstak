import type { Attachment } from '../types/api'

export const CHAT_FILE_ACCEPT =
  'image/*,application/pdf,text/*,.json,.md,.csv,.docx,.xlsx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const ACCEPTED_MIME_PREFIXES = ['image/', 'text/', 'application/pdf', 'application/json'] as const

const ACCEPTED_MIME_EXACT = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
])

const EXT_TO_MIME: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
}

export function isLegacyDoc(filename: string): boolean {
  const lower = filename.toLowerCase()
  return lower.endsWith('.doc') && !lower.endsWith('.docx')
}

export function isAcceptableAttachment(mime: string, filename: string): boolean {
  if (isLegacyDoc(filename)) return false
  const lower = filename.toLowerCase()
  if (lower.endsWith('.docx') || lower.endsWith('.xlsx')) return true
  if (ACCEPTED_MIME_EXACT.has(mime)) return true
  if (ACCEPTED_MIME_PREFIXES.some(p => mime.startsWith(p))) return true
  if (!mime || mime === 'application/octet-stream') {
    const ext = lower.match(/\.[^.]+$/)?.[0]
    if (ext && ext in EXT_TO_MIME) return true
  }
  return false
}

export function resolveAttachmentMime(mime: string, filename: string): string {
  if (mime && mime !== 'application/octet-stream') return mime
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0]
  if (ext && EXT_TO_MIME[ext]) return EXT_TO_MIME[ext]
  return mime || 'application/octet-stream'
}

export async function blobToAttachment(
  blob: Blob,
  fallbackName: string,
  maxBytes: number,
): Promise<Attachment | null> {
  if (blob.size > maxBytes) return null
  const name = (blob as File).name || fallbackName
  if (isLegacyDoc(name)) return null
  const mimeType = resolveAttachmentMime(blob.type || '', name)
  if (!isAcceptableAttachment(mimeType, name)) return null
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  const data = btoa(binary)
  return { name, mimeType, data, size: blob.size }
}