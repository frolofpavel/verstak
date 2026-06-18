export const UPDATE_OWNER = 'frolofpavel'
export const UPDATE_REPO = 'verstak'

const SEMVER_RE = /^v?(\d+\.\d+\.\d+)/
const FETCH_TIMEOUT_MS = 15_000

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

async function electronFetch(url: string, init?: RequestInit): Promise<Response> {
  if (process.versions.electron) {
    const { net } = await import('electron')
    return net.fetch(url, init)
  }
  return fetch(url, init)
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await electronFetch(url, { ...init, signal: controller.signal })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export type GithubRateLimitInfo = {
  resetAt: number
  retryAfterSec: number
}

export type RemoteVersionProbeResult = {
  version: string | null
  rateLimit: GithubRateLimitInfo | null
}

export function rateLimitWaitMinutes(info: GithubRateLimitInfo): number {
  return Math.max(1, Math.ceil(info.retryAfterSec / 60))
}

export function mergeRateLimit(
  a: GithubRateLimitInfo | null,
  b: GithubRateLimitInfo | null,
): GithubRateLimitInfo | null {
  if (!a) return b
  if (!b) return a
  return a.resetAt >= b.resetAt ? a : b
}

/** 403/429 GitHub API + заголовки X-RateLimit-Reset / Retry-After. */
export async function parseGithubRateLimit(res: Response): Promise<GithubRateLimitInfo | null> {
  if (res.status !== 403 && res.status !== 429) return null

  const remaining = res.headers.get('x-ratelimit-remaining')
  const reset = res.headers.get('x-ratelimit-reset')
  const retryAfter = res.headers.get('retry-after')

  let isRateLimit = res.status === 429 || remaining === '0'
  if (!isRateLimit) {
    try {
      const body = await res.clone().text()
      isRateLimit = /rate limit/i.test(body)
    } catch { /* ignore */ }
  }
  if (!isRateLimit) return null

  const resetSec = reset ? Number(reset) : 0
  const resetAt = resetSec > 0 ? resetSec * 1000 : Date.now() + 3600_000
  const retryAfterSec = retryAfter
    ? Math.max(60, Number(retryAfter) || 3600)
    : Math.max(60, Math.ceil((resetAt - Date.now()) / 1000))

  return { resetAt, retryAfterSec }
}

type FetchJsonResult<T> = { data: T | null; rateLimit: GithubRateLimitInfo | null }

async function fetchJson<T>(url: string): Promise<FetchJsonResult<T>> {
  const res = await fetchWithTimeout(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Verstak-Updater' },
  })
  if (!res) return { data: null, rateLimit: null }
  if (!res.ok) {
    return { data: null, rateLimit: await parseGithubRateLimit(res) }
  }
  try {
    return { data: await res.json() as T, rateLimit: null }
  } catch {
    return { data: null, rateLimit: null }
  }
}

async function fetchPackageJsonVersion(): Promise<string | null> {
  const res = await fetchWithTimeout(
    `https://raw.githubusercontent.com/${UPDATE_OWNER}/${UPDATE_REPO}/main/package.json`,
    { headers: { 'User-Agent': 'Verstak-Updater' } },
  )
  if (!res?.ok) return null
  try {
    const pkg = await res.json() as { version?: string }
    return pkg.version ? normalizeVersion(pkg.version) : null
  } catch {
    return null
  }
}

/** Без GitHub API — редирект releases/latest/download/latest.yml. */
async function fetchVersionFromLatestYml(): Promise<string | null> {
  const res = await fetchWithTimeout(
    `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest/download/latest.yml`,
    { headers: { 'User-Agent': 'Verstak-Updater' } },
  )
  if (!res?.ok) return null
  try {
    const yml = await res.text()
    const versionMatch = yml.match(/^version:\s*(\S+)/m)
    return versionMatch ? normalizeVersion(versionMatch[1]) : null
  } catch {
    return null
  }
}

async function fetchRemoteVersionOnce(): Promise<RemoteVersionProbeResult> {
  const candidates: string[] = []
  let rateLimit: GithubRateLimitInfo | null = null

  const fromPkg = await fetchPackageJsonVersion()
  if (fromPkg) candidates.push(fromPkg)

  const fromYml = await fetchVersionFromLatestYml()
  if (fromYml) candidates.push(fromYml)

  const latestRelease = await fetchJson<{ tag_name?: string; name?: string }>(
    `https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`,
  )
  rateLimit = mergeRateLimit(rateLimit, latestRelease.rateLimit)
  if (latestRelease.data?.tag_name || latestRelease.data?.name) {
    candidates.push(normalizeVersion(latestRelease.data.tag_name || latestRelease.data.name || ''))
  }

  const tags = await fetchJson<Array<{ name: string }>>(
    `https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/tags?per_page=30`,
  )
  rateLimit = mergeRateLimit(rateLimit, tags.rateLimit)
  const fromTags = maxSemver((tags.data ?? []).map(t => t.name))
  if (fromTags) candidates.push(fromTags)

  const version = maxSemver(candidates)
  return { version, rateLimit: version ? null : rateLimit }
}

/** Последняя версия: max(package.json на main, latest.yml, GitHub API). */
export async function fetchRemoteVersion(): Promise<RemoteVersionProbeResult> {
  let rateLimit: GithubRateLimitInfo | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const probe = await fetchRemoteVersionOnce()
    if (probe.version) return { version: probe.version, rateLimit: null }
    rateLimit = mergeRateLimit(rateLimit, probe.rateLimit)
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
    }
  }
  return { version: null, rateLimit }
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

export type ReleaseArtifactMeta = {
  version: string
  fileName: string
  sha512: string
  size: number
}

export function parseLatestYmlArtifact(yml: string, version: string): ReleaseArtifactMeta | null {
  const pathMatch = yml.match(/^path:\s*(.+)$/m)
  const shaMatch = yml.match(/^sha512:\s*(.+)$/m)
  const sizeMatch = yml.match(/^\s+size:\s*(\d+)$/m)
  if (!pathMatch?.[1] || !shaMatch?.[1]) return null
  return {
    version: normalizeVersion(version),
    fileName: pathMatch[1].trim(),
    sha512: shaMatch[1].trim(),
    size: sizeMatch?.[1] ? Number(sizeMatch[1]) : 0,
  }
}

export async function fetchReleaseArtifactMeta(version: string): Promise<ReleaseArtifactMeta | null> {
  const res = await fetchWithTimeout(`${releaseFeedBase(version)}/latest.yml`, {
    headers: { 'User-Agent': 'Verstak-Updater' },
  })
  if (!res?.ok) return null
  try {
    const yml = await res.text()
    return parseLatestYmlArtifact(yml, version)
  } catch {
    return null
  }
}

export async function releaseArtifactsReady(version: string): Promise<boolean> {
  return (await fetchReleaseArtifactMeta(version)) != null
}

/** Синхронная логика: что ставить, если в main уже новее, чем на Releases. */
export function pickInstallableUpdate(params: {
  installed: string
  repoMax: string | null
  latestRelease: string | null
  hasArtifacts: (version: string) => boolean
}): { installable: string | null; pendingVersion: string | null } {
  const { installed, repoMax, latestRelease, hasArtifacts } = params

  if (latestRelease && semverGt(latestRelease, installed) && hasArtifacts(latestRelease)) {
    return { installable: latestRelease, pendingVersion: null }
  }

  if (repoMax && semverGt(repoMax, installed) && hasArtifacts(repoMax)) {
    return { installable: repoMax, pendingVersion: null }
  }

  if (repoMax && semverGt(repoMax, installed)) {
    return { installable: null, pendingVersion: repoMax }
  }

  return { installable: null, pendingVersion: null }
}

/** Версия для скачивания: latest.yml на Releases, даже если package.json на main впереди. */
export async function resolveInstallableUpdate(
  installedVersion: string,
  repoMaxVersion: string | null,
): Promise<{ installable: string | null; pendingVersion: string | null }> {
  const latestRelease = await fetchVersionFromLatestYml()
  const artifactCache = new Map<string, boolean>()

  const hasArtifacts = async (version: string): Promise<boolean> => {
    const key = normalizeVersion(version)
    if (artifactCache.has(key)) return artifactCache.get(key)!
    const ready = await releaseArtifactsReady(key)
    artifactCache.set(key, ready)
    return ready
  }

  if (latestRelease && semverGt(latestRelease, installedVersion) && await hasArtifacts(latestRelease)) {
    return { installable: latestRelease, pendingVersion: null }
  }

  if (repoMaxVersion && semverGt(repoMaxVersion, installedVersion)) {
    if (await hasArtifacts(repoMaxVersion)) {
      return { installable: repoMaxVersion, pendingVersion: null }
    }
    return { installable: null, pendingVersion: repoMaxVersion }
  }

  return { installable: null, pendingVersion: null }
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
  const { data } = await fetchJson<GithubRelease>(
    `https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/tags/${tag}`,
  )
  return data ? mapRelease(data) : null
}

export async function fetchAllReleaseNotes(): Promise<ReleaseNote[]> {
  const { data: list } = await fetchJson<GithubRelease[]>(
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
  const { getBundledReleaseNotesInRange, mergeReleaseNotes } = await import('./bundled-changelog')
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
  const { getAllBundledReleaseNotes, mergeReleaseNotes } = await import('./bundled-changelog')
  const github = await fetchAllReleaseNotes()
  const { polishReleaseNotes } = await import('./release-notes-official')
  return polishReleaseNotes(mergeReleaseNotes(github, getAllBundledReleaseNotes()))
}

export async function fetchReleaseNoteMerged(version: string): Promise<ReleaseNote | null> {
  const { getBundledReleaseNote, mergeReleaseNotes } = await import('./bundled-changelog')
  const github = await fetchReleaseNote(version)
  const bundled = getBundledReleaseNote(version)
  if (!github && !bundled) return null
  const { polishReleaseNotes } = await import('./release-notes-official')
  const merged = mergeReleaseNotes(github ? [github] : [], bundled ? [bundled] : [])
  const polished = polishReleaseNotes(merged)
  return polished[0] ?? null
}