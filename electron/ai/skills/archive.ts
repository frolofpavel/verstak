import { mkdir, readdir, readFile, rename } from 'fs/promises'
import { basename, join, resolve, sep } from 'path'
import { USER_SKILLS_DIR } from './loader'
import { parseSkillDoc } from './frontmatter'
import type { Skill } from './types'

export interface SkillArchiveMove {
  moved: boolean
  from?: string
  to?: string
  reason?: string
}

export function archivedSkillsDir(root = USER_SKILLS_DIR): string {
  return join(root, '.archive')
}

function isInsideRoot(filePath: string, root: string): boolean {
  const abs = resolve(filePath)
  const base = resolve(root)
  return abs === base || abs.startsWith(base.endsWith(sep) ? base : base + sep)
}

async function uniqueDestination(dir: string, filename: string): Promise<string> {
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : ''
  let candidate = join(dir, filename)
  for (let n = 2; ; n++) {
    try {
      await readFile(candidate)
      candidate = join(dir, `${stem}-${n}${ext}`)
    } catch {
      return candidate
    }
  }
}

export async function archiveUserSkillFile(skill: Skill, root = USER_SKILLS_DIR): Promise<SkillArchiveMove> {
  if (skill.source !== 'user') return { moved: false, reason: 'not-user-skill' }
  if (!skill.sourceRef.endsWith('.md')) return { moved: false, reason: 'not-markdown-file' }
  if (!isInsideRoot(skill.sourceRef, root)) return { moved: false, reason: 'outside-user-skill-root' }
  if (isInsideRoot(skill.sourceRef, archivedSkillsDir(root))) return { moved: false, reason: 'already-archived-file' }

  const dir = archivedSkillsDir(root)
  await mkdir(dir, { recursive: true })
  const to = await uniqueDestination(dir, basename(skill.sourceRef))
  await rename(skill.sourceRef, to)
  return { moved: true, from: skill.sourceRef, to }
}

export async function restoreArchivedUserSkillFile(skillId: string, root = USER_SKILLS_DIR): Promise<SkillArchiveMove> {
  const dir = archivedSkillsDir(root)
  const files = await readdir(dir).catch(() => [] as string[])
  for (const file of files) {
    if (!file.endsWith('.md')) continue
    const from = join(dir, file)
    const raw = await readFile(from, 'utf8').catch(() => null)
    if (!raw) continue
    const doc = parseSkillDoc(raw)
    const fm = doc.frontmatter as { id?: unknown; name?: unknown }
    const id = typeof fm.id === 'string' && fm.id ? fm.id : typeof fm.name === 'string' ? fm.name : null
    if (id !== skillId) continue
    const to = await uniqueDestination(root, file)
    await rename(from, to)
    return { moved: true, from, to }
  }
  return { moved: false, reason: 'archived-file-not-found' }
}
