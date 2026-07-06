export const ALLOWED_WRITE_ROOTS_KEY = 'allowed_write_roots'

export function parseAllowedWriteRoots(raw: string | null | undefined): string[] {
  if (!raw) return []
  const text = String(raw).trim()
  if (!text) return []

  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return normalizeRoots(parsed)
    } catch {
      // Fall back to line parsing below.
    }
  }

  return normalizeRoots(text.split(/\r?\n/))
}

function normalizeRoots(values: unknown[]): string[] {
  const seen = new Set<string>()
  const roots: string[] = []
  for (const value of values) {
    const root = String(value || '').trim()
    if (!root || root.startsWith('#') || seen.has(root)) continue
    seen.add(root)
    roots.push(root)
  }
  return roots
}
