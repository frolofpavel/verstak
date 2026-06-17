export const UPDATE_OWNER = 'frolofpavel'
export const UPDATE_REPO = 'verstak'

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

export function maxSemver(versions: string[]): string | null {
  let best: string | null = null
  for (const v of versions) {
    const n = normalizeVersion(v)
    if (!SEMVER_RE.test(n)) continue
    if (!best || semverGt(n, best)) best = n
  }
  return best
}

export function releaseFeedBase(version: string): string {
  return `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/v${normalizeVersion(version)}`
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Verstak-Updater' },
    })
    if (!res.ok) return null
    return await res.json() as T
  } catch {
    return null
  }
}

async function fetchPackageJsonVersion(): Promise<string | null> {
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${UPDATE_OWNER}/${UPDATE_REPO}/main/package.json`,
      { headers: { 'User-Agent': 'Verstak-Updater' } },
    )
    if (res.ok) {
      const pkg = await res.json() as { version?: string }
      if (pkg.version) return normalizeVersion(pkg.version)
    }
  } catch { /* ignore */ }
  return null
}

/** Последняя версия: max(GitHub Release, semver-теги, package.json на main). */
export async function fetchRemoteVersion(): Promise<string | null> {
  const candidates: string[] = []

  const latestRelease = await fetchJson<{ tag_name?: string; name?: string }>(
    `https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`,
  )
  if (latestRelease?.tag_name || latestRelease?.name) {
    candidates.push(normalizeVersion(latestRelease.tag_name || latestRelease.name || ''))
  }

  const tags = await fetchJson<Array<{ name: string }>>(
    `https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/tags?per_page=30`,
  )
  const fromTags = maxSemver((tags ?? []).map(t => t.name))
  if (fromTags) candidates.push(fromTags)

  const fromPkg = await fetchPackageJsonVersion()
  if (fromPkg) candidates.push(fromPkg)

  return maxSemver(candidates)
}

/** electron-updater часто падает, если на GitHub ещё нет Release с latest.yml — это не сбой для пользователя. */
export function isBenignUpdaterError(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('404')
    || m.includes('not found')
    || m.includes('latest.yml')
    || m.includes('no published')
    || m.includes('cannot find')
    || m.includes('net::')
    || m.includes('httperror')
  )
}

export async function releaseArtifactsReady(version: string): Promise<boolean> {
  try {
    const res = await fetch(`${releaseFeedBase(version)}/latest.yml`, {
      headers: { 'User-Agent': 'Verstak-Updater' },
    })
    return res.ok
  } catch {
    return false
  }
}

export type ReleaseNote = {
  version: string
  name: string
  body: string
  htmlUrl: string
  publishedAt?: string
}

type GithubRelease = {
  tag_name?: string
  name?: string
  body?: string
  html_url?: string
  published_at?: string
  draft?: boolean
  prerelease?: boolean
}

export function cleanReleaseBody(body: string): string {
  return body.replace(/\r\n/g, '\n').replace(/\n---\n[\s\S]*$/m, '').trim()
}

function mapRelease(data: GithubRelease): ReleaseNote | null {
  if (!data.body || !data.tag_name) return null
  const version = normalizeVersion(data.tag_name)
  if (!SEMVER_RE.test(version)) return null
  return {
    version,
    name: data.name || `Verstak ${version}`,
    body: cleanReleaseBody(data.body),
    htmlUrl: data.html_url || `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases/tag/v${version}`,
    publishedAt: data.published_at,
  }
}

export async function fetchReleaseNote(version: string): Promise<ReleaseNote | null> {
  const tag = `v${normalizeVersion(version)}`
  const data = await fetchJson<GithubRelease>(
    `https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/tags/${tag}`,
  )
  return data ? mapRelease(data) : null
}

export async function fetchAllReleaseNotes(): Promise<ReleaseNote[]> {
  const list = await fetchJson<GithubRelease[]>(
    `https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases?per_page=50`,
  )
  if (!list) return []

  const notes: ReleaseNote[] = []
  for (const item of list) {
    if (item.draft) continue
    const note = mapRelease(item)
    if (note) notes.push(note)
  }

  return notes.sort((a, b) => {
    if (semverGt(a.version, b.version)) return 1
    if (semverGt(b.version, a.version)) return -1
    return 0
  })
}

/** Релизы строго после sinceVersion и не новее upToVersion (для whats-new после апдейта). */
export async function fetchReleaseNotesSince(sinceVersion: string, upToVersion: string): Promise<ReleaseNote[]> {
  const { getBundledReleaseNotesInRange, mergeReleaseNotes } = await import('./rayner-changelog')
  const all = await fetchAllReleaseNotes()
  const since = normalizeVersion(sinceVersion)
  const upTo = normalizeVersion(upToVersion)
  const github = all.filter((note) => semverGt(note.version, since) && !semverGt(note.version, upTo))
  const bundled = getBundledReleaseNotesInRange(since, upTo)
  const { polishReleaseNotes } = await import('./release-notes-official')
  return polishReleaseNotes(mergeReleaseNotes(github, bundled))
}

/** Все релизы: GitHub + встроенные заметки сборки Rayner. */
export async function fetchAllReleaseNotesMerged(): Promise<ReleaseNote[]> {
  const { getAllBundledReleaseNotes, mergeReleaseNotes } = await import('./rayner-changelog')
  const github = await fetchAllReleaseNotes()
  const { polishReleaseNotes } = await import('./release-notes-official')
  return polishReleaseNotes(mergeReleaseNotes(github, getAllBundledReleaseNotes()))
}

export async function fetchReleaseNoteMerged(version: string): Promise<ReleaseNote | null> {
  const { getBundledReleaseNote, mergeReleaseNotes } = await import('./rayner-changelog')
  const github = await fetchReleaseNote(version)
  const bundled = getBundledReleaseNote(version)
  if (!github && !bundled) return null
  const { polishReleaseNotes } = await import('./release-notes-official')
  const merged = mergeReleaseNotes(github ? [github] : [], bundled ? [bundled] : [])
  const polished = polishReleaseNotes(merged)
  return polished[0] ?? null
}