import { isAbsolute, resolve, sep } from 'path'

export type SkillInstallBlockCode =
  | 'target-outside-root'
  | 'archive-path-traversal'
  | 'archive-absolute-path'
  | 'archive-executable-payload'
  | 'archive-hidden-hook'
  | 'scan-failed'

export class SkillInstallBlockedError extends Error {
  constructor(
    public readonly code: SkillInstallBlockCode,
    message: string
  ) {
    super(message)
    this.name = 'SkillInstallBlockedError'
  }
}

export interface SkillArchiveEntry {
  name: string
  sizeBytes?: number
}

export interface SkillInstallPlan {
  skillRoot: string
  targetDir: string
  entries: SkillArchiveEntry[]
  scanEntry?: (entry: SkillArchiveEntry) => void | Promise<void>
}

export interface SafeSkillInstallPlan {
  targetDirAbs: string
  entries: SkillArchiveEntry[]
}

const EXECUTABLE_EXTENSIONS = new Set([
  '.bat',
  '.cmd',
  '.com',
  '.exe',
  '.js',
  '.mjs',
  '.ps1',
  '.sh',
  '.vbs'
])

const HIDDEN_HOOK_NAMES = new Set([
  '.hooks',
  'hooks',
  'postinstall',
  'preinstall',
  'install'
])

function ensureInsideRoot(root: string, target: string): void {
  const rootAbs = resolve(root)
  const targetAbs = resolve(rootAbs, target)
  const rootPrefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep

  if (targetAbs !== rootAbs && !targetAbs.startsWith(rootPrefix)) {
    throw new SkillInstallBlockedError(
      'target-outside-root',
      `Skill install target escapes root: ${target}`
    )
  }
}

function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\.\/+/, '')
}

function extensionOf(name: string): string {
  const base = name.split('/').filter(Boolean).at(-1) ?? ''
  const idx = base.lastIndexOf('.')
  return idx >= 0 ? base.slice(idx).toLowerCase() : ''
}

function hasHiddenHookPath(name: string): boolean {
  const parts = normalizeEntryName(name).toLowerCase().split('/').filter(Boolean)
  return parts.some(part => HIDDEN_HOOK_NAMES.has(part))
}

export function assertSafeSkillArchiveEntry(entry: SkillArchiveEntry): void {
  const normalized = normalizeEntryName(entry.name)
  if (!normalized || normalized === '.') {
    throw new SkillInstallBlockedError('archive-path-traversal', 'Empty archive entry is not allowed')
  }
  if (isAbsolute(entry.name) || /^[a-z]:\//i.test(normalized)) {
    throw new SkillInstallBlockedError('archive-absolute-path', `Archive entry uses absolute path: ${entry.name}`)
  }

  const parts = normalized.split('/').filter(Boolean)
  if (parts.includes('..')) {
    throw new SkillInstallBlockedError('archive-path-traversal', `Archive entry escapes target: ${entry.name}`)
  }
  if (hasHiddenHookPath(normalized)) {
    throw new SkillInstallBlockedError('archive-hidden-hook', `Archive entry contains hidden runtime hook: ${entry.name}`)
  }
  const ext = extensionOf(normalized)
  if (ext && EXECUTABLE_EXTENSIONS.has(ext)) {
    throw new SkillInstallBlockedError('archive-executable-payload', `Archive entry contains executable payload: ${entry.name}`)
  }
}

export async function validateSkillInstallPlan(plan: SkillInstallPlan): Promise<SafeSkillInstallPlan> {
  ensureInsideRoot(plan.skillRoot, plan.targetDir)

  for (const entry of plan.entries) {
    assertSafeSkillArchiveEntry(entry)
    if (plan.scanEntry) {
      try {
        await plan.scanEntry(entry)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new SkillInstallBlockedError('scan-failed', `Skill install scan failed closed: ${msg}`)
      }
    }
  }

  return {
    targetDirAbs: resolve(plan.skillRoot, plan.targetDir),
    entries: plan.entries
  }
}
