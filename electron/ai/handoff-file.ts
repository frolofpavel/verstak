export interface HandoffFileNameOptions {
  sessionId: number
  title?: string | null
  now?: number | Date
}

export function sanitizeHandoffFilePart(value: string | null | undefined): string {
  const cleaned = (value ?? 'handoff')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)

  return cleaned || 'handoff'
}

export function buildHandoffFileName(options: HandoffFileNameOptions): string {
  const date = options.now instanceof Date
    ? options.now
    : new Date(options.now ?? Date.now())
  const stamp = date.toISOString().replace(/[:.]/g, '-')
  const title = sanitizeHandoffFilePart(options.title)
  return `verstak-handoff-${options.sessionId}-${title}-${stamp}.md`
}
