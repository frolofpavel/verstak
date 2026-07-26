const SEMVER_RE = /^v?(\d+\.\d+\.\d+)/

export function normalizeVersion(raw: string): string {
  const m = raw.trim().match(SEMVER_RE)
  return m ? m[1] : raw.trim().replace(/^v/, '')
}

export function semverGt(a: string, b: string): boolean {
  const pa = normalizeVersion(a).split('.').map(n => Number(n) || 0)
  const pb = normalizeVersion(b).split('.').map(n => Number(n) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return true
    if (da < db) return false
  }
  return false
}
