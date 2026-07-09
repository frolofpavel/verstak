/**
 * IPC handlers для скиллов.
 *
 * Каналы:
 *   skills:list             → Skill[]
 *   skills:get              (id) → Skill | null
 *   skills:refresh          → { added, updated, failed }
 *   skills:status           → { lastRefreshAt, serverReachable, total }
 *   skills:run-loaders      (skillId, arg?, projectPath?) → { context: string, labels: string[] }
 */

import { dialog, ipcMain } from 'electron'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, extname, join } from 'path'
import { randomUUID } from 'crypto'
import JSZip from 'jszip'
import type { SkillRegistry } from '../ai/skills/types'
import { lookupLoader } from '../ai/skills/loaders'
import { buildCapturedSkill, deriveSkillId } from '../ai/skills/capture'
import { parseSkillFile, USER_SKILLS_DIR } from '../ai/skills/loader'
import { archiveUserSkillFile, restoreArchivedUserSkillFile } from '../ai/skills/archive'
import type { SkillUsageStore } from '../storage/skill-usage'
import type { Skill } from '../ai/skills/types'

interface RunLoadersDeps {
  getSecret?: (key: string) => string | null
  skillUsage?: SkillUsageStore
}

interface PendingSkillImport {
  id: string
  name: string
  description?: string
  raw: string
  sourcePath: string
  targetPath: string
  existing: Skill | null
  comparison: SkillImportComparison
}

interface SkillImportComparison {
  currentRuleCount: number
  incomingRuleCount: number
  sameRules: string[]
  addedRules: string[]
  removedRules: string[]
  changedRules: Array<{ current: string; incoming: string }>
  summary: string
}

const pendingImports = new Map<string, PendingSkillImport[]>()

function normalizeRuleText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?]+$/g, '').trim()
}

function pluralRu(count: number, one: string, few: string, many: string): string {
  const abs = Math.abs(count)
  const mod10 = abs % 10
  const mod100 = abs % 100
  if (mod100 >= 11 && mod100 <= 14) return many
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}

function ruleCountText(count: number): string {
  return `${count} ${pluralRu(count, 'правило', 'правила', 'правил')}`
}

function extractSkillRules(skill: Pick<Skill, 'systemPrompt' | 'description' | 'suggested_prompts' | 'tools_allow'> | null): string[] {
  if (!skill) return []
  const lines = [
    skill.description ?? '',
    ...(skill.suggested_prompts ?? []),
    ...(skill.tools_allow ?? []).map(tool => `Инструмент: ${tool}`),
    ...skill.systemPrompt.split(/\r?\n/)
  ]
  const rules: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const list = trimmed.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/)
    const heading = trimmed.match(/^#{1,4}\s+(.+)$/)
    const picked = list?.[1] ?? heading?.[1] ?? null
    if (!picked) continue
    const clean = picked.replace(/\s+/g, ' ').trim()
    if (clean.length >= 8 && !rules.some(rule => normalizeRuleText(rule) === normalizeRuleText(clean))) {
      rules.push(clean)
    }
  }
  return rules.slice(0, 80)
}

function compareSkills(current: Skill | null, incoming: Skill): SkillImportComparison {
  const currentRules = extractSkillRules(current)
  const incomingRules = extractSkillRules(incoming)
  const currentNorm = new Map(currentRules.map(rule => [normalizeRuleText(rule), rule]))
  const incomingNorm = new Map(incomingRules.map(rule => [normalizeRuleText(rule), rule]))
  const sameRules = incomingRules.filter(rule => currentNorm.has(normalizeRuleText(rule)))
  const addedRules = incomingRules.filter(rule => !currentNorm.has(normalizeRuleText(rule))).slice(0, 12)
  const removedRules = currentRules.filter(rule => !incomingNorm.has(normalizeRuleText(rule))).slice(0, 12)
  const changedRules: Array<{ current: string; incoming: string }> = []
  const pairs = Math.min(currentRules.length, incomingRules.length)
  for (let i = 0; i < pairs; i++) {
    if (normalizeRuleText(currentRules[i]) !== normalizeRuleText(incomingRules[i])) {
      changedRules.push({ current: currentRules[i], incoming: incomingRules[i] })
    }
    if (changedRules.length >= 6) break
  }
  const summary = current
    ? `В текущем скилле ${ruleCountText(currentRules.length)}, в новом ${ruleCountText(incomingRules.length)}. Совпадает ${ruleCountText(sameRules.length)}, добавится ${ruleCountText(addedRules.length)}, отличается ${ruleCountText(changedRules.length)}.`
    : `Новый скилл: найдено ${ruleCountText(incomingRules.length)}.`
  return {
    currentRuleCount: currentRules.length,
    incomingRuleCount: incomingRules.length,
    sameRules: sameRules.slice(0, 12),
    addedRules,
    removedRules,
    changedRules,
    summary
  }
}

function targetFileNameForSkill(id: string): string {
  const safe = id.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill'
  return `${safe}.md`
}

function importedSkillFolderId(sourcePath: string): string | undefined {
  const virtualPath = sourcePath.includes('#') ? sourcePath.slice(sourcePath.indexOf('#') + 1) : sourcePath
  const parts = virtualPath.split(/[\\/]+/).filter(Boolean)
  const fileName = parts.at(-1)?.toLowerCase()
  if (fileName !== 'skill.md') return undefined
  return parts.at(-2)?.replace(/[^a-z0-9_-]+/gi, '-') || undefined
}

async function collectSkillFiles(inputPath: string, out: Array<{ sourcePath: string; raw: string }>, depth = 0): Promise<void> {
  if (depth > 5) return
  const s = await stat(inputPath)
  if (s.isFile()) {
    const lower = inputPath.toLowerCase()
    if (lower.endsWith('.zip')) {
      const zip = await JSZip.loadAsync(await readFile(inputPath))
      const entries = Object.values(zip.files)
        .filter(entry => !entry.dir && entry.name.toLowerCase().endsWith('.md'))
        .sort((a, b) => {
          const as = basename(a.name).toLowerCase() === 'skill.md' ? 0 : 1
          const bs = basename(b.name).toLowerCase() === 'skill.md' ? 0 : 1
          return as - bs || a.name.localeCompare(b.name)
        })
      for (const entry of entries.slice(0, 100)) {
        out.push({ sourcePath: `${inputPath}#${entry.name}`, raw: await entry.async('string') })
      }
      return
    }
    if (lower.endsWith('.md')) {
      out.push({ sourcePath: inputPath, raw: await readFile(inputPath, 'utf8') })
    }
    return
  }
  if (!s.isDirectory()) return
  const entries = await readdir(inputPath, { withFileTypes: true })
  const sorted = entries.sort((a, b) => {
    const as = a.name.toLowerCase() === 'skill.md' ? 0 : 1
    const bs = b.name.toLowerCase() === 'skill.md' ? 0 : 1
    return as - bs || a.name.localeCompare(b.name)
  })
  for (const entry of sorted) {
    if (entry.name.startsWith('.') && entry.name !== '.skill') continue
    await collectSkillFiles(join(inputPath, entry.name), out, depth + 1)
    if (out.length >= 100) return
  }
}

async function createImportPreview(registry: SkillRegistry, paths: string[]) {
  const files: Array<{ sourcePath: string; raw: string }> = []
  for (const path of paths) await collectSkillFiles(path, files)
  const imports: PendingSkillImport[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const folderId = importedSkillFolderId(file.sourcePath)
    const parsed = parseSkillFile(file.raw, file.sourcePath, 'user', folderId)
    if (!parsed || seen.has(parsed.id)) continue
    seen.add(parsed.id)
    const existing = registry.get(parsed.id)
    const targetPath = join(USER_SKILLS_DIR, targetFileNameForSkill(parsed.id))
    imports.push({
      id: parsed.id,
      name: parsed.name ?? parsed.id,
      description: parsed.description,
      raw: file.raw,
      sourcePath: file.sourcePath,
      targetPath,
      existing,
      comparison: compareSkills(existing, parsed)
    })
  }
  return imports
}

export function registerSkillsIpc(registry: SkillRegistry, deps: RunLoadersDeps = {}): void {
  ipcMain.handle('skills:list', () => registry.list())
  ipcMain.handle('skills:get', (_e, id: string) => registry.get(id))
  ipcMain.handle('skills:refresh', () => registry.refresh())
  ipcMain.handle('skills:status', () => registry.status())
  ipcMain.handle('skills:usage', () => deps.skillUsage?.list() ?? [])
  ipcMain.handle('skills:record-use', (_e, skillId: string) => {
    const skill = registry.get(skillId)
    if (!skill) throw new Error(`Unknown skill: ${skillId}`)
    return deps.skillUsage?.recordUse(skill.id) ?? null
  })
  ipcMain.handle('skills:archive', async (_e, skillId: string) => {
    const skill = registry.get(skillId)
    if (!skill) throw new Error(`Unknown skill: ${skillId}`)
    const file = await archiveUserSkillFile(skill)
    const usage = deps.skillUsage?.archive(skill.id) ?? null
    await registry.refresh()
    return { ok: true as const, id: skill.id, source: skill.source, file, usage }
  })
  ipcMain.handle('skills:restore', async (_e, skillId: string) => {
    const file = await restoreArchivedUserSkillFile(skillId)
    const usage = deps.skillUsage?.restore(skillId) ?? null
    await registry.refresh()
    return { ok: true as const, id: skillId, file, usage }
  })

  ipcMain.handle('skills:import-preview', async () => {
    try {
      const picked = await dialog.showOpenDialog({
        title: 'Установить скилл',
        properties: ['openFile', 'openDirectory', 'multiSelections'],
        filters: [
          { name: 'Skill files', extensions: ['md', 'zip'] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      if (picked.canceled || picked.filePaths.length === 0) return { ok: false as const, cancelled: true as const }
      const imports = await createImportPreview(registry, picked.filePaths)
      if (imports.length === 0) return { ok: false as const, error: 'В выбранных файлах не найдено скиллов с id/name.' }
      const token = randomUUID()
      pendingImports.set(token, imports)
      return {
        ok: true as const,
        token,
        skills: imports.map(item => ({
          id: item.id,
          name: item.name,
          description: item.description,
          sourcePath: item.sourcePath,
          targetPath: item.targetPath,
          existing: item.existing ? {
            id: item.existing.id,
            name: item.existing.name,
            source: item.existing.source,
            sourceRef: item.existing.sourceRef
          } : null,
          comparison: item.comparison
        }))
      }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('skills:import-commit', async (_e, input: { token: string; replace?: boolean }) => {
    const imports = pendingImports.get(input?.token)
    if (!imports) return { ok: false as const, error: 'Предпросмотр импорта устарел. Выбери файл ещё раз.' }
    try {
      await mkdir(USER_SKILLS_DIR, { recursive: true })
      const installed: string[] = []
      const skipped: string[] = []
      const backups: string[] = []
      for (const item of imports) {
        const hasConflict = !!item.existing || existsSync(item.targetPath)
        if (hasConflict && !input.replace) {
          skipped.push(item.id)
          continue
        }
        if (existsSync(item.targetPath)) {
          const backupPath = `${item.targetPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
          await copyFile(item.targetPath, backupPath)
          backups.push(backupPath)
        }
        await writeFile(item.targetPath, item.raw, 'utf8')
        installed.push(item.id)
      }
      pendingImports.delete(input.token)
      await registry.refresh()
      return { ok: true as const, installed, skipped, backups }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * Skill Capture: сохранить успешный прогон как скилл-скаффолд в
   * ~/.verstak/skills/<id>.md (human-approve — на стороне UI до вызова).
   * Дедупит id при коллизии, обновляет реестр. Возвращает { ok, id, path }.
   */
  ipcMain.handle('skills:capture', async (_e, input: { title: string; summary?: string; toolsAllow?: string[] }) => {
    try {
      const base = deriveSkillId(input?.title ?? '')
      await mkdir(USER_SKILLS_DIR, { recursive: true })
      let id = base
      for (let n = 2; existsSync(join(USER_SKILLS_DIR, `${id}.md`)); n++) id = `${base}-${n}`
      const skill = buildCapturedSkill({
        title: input?.title ?? '',
        summary: input?.summary,
        toolsAllow: input?.toolsAllow,
        capturedAt: new Date().toISOString().slice(0, 10),
        id,
      })
      const filePath = join(USER_SKILLS_DIR, skill.filename)
      await writeFile(filePath, skill.markdown, 'utf8')
      await registry.refresh()
      return { ok: true as const, id: skill.id, path: filePath }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * Запустить context loaders для указанного скилла. Возвращает собранный
   * markdown который renderer инжектит в первое user-message чата.
   *
   * trigger='chat_open' → запускаем loader'ы с runs_on='chat_open'.
   * trigger='slash_arg' → loader'ы которые ждут аргумент slash (например
   * load_client_card для /my-skill my-client).
   */
  ipcMain.handle('skills:run-loaders', async (_e, skillId: string, opts: { arg?: string; projectPath?: string | null; trigger: 'chat_open' | 'slash_arg' }) => {
    const skill = registry.get(skillId)
    if (!skill || !skill.context_loaders) return { context: '', labels: [] }
    const loaders = skill.context_loaders.filter(l => l.runs_on === opts.trigger)
    if (loaders.length === 0) return { context: '', labels: [] }
    const parts: string[] = []
    const labels: string[] = []
    for (const l of loaders) {
      const fn = lookupLoader(l.impl)
      if (!fn) {
        parts.push(`_(loader «${l.impl}» не найден в registry)_`)
        continue
      }
      try {
        const result = await fn({
          arg: opts.arg,
          projectPath: opts.projectPath ?? null,
          getSecret: deps.getSecret
        })
        if (result) {
          parts.push(result.markdown)
          if (result.label) labels.push(result.label)
        }
      } catch (err) {
        parts.push(`_(loader «${l.impl}» упал: ${err instanceof Error ? err.message : String(err)})_`)
      }
    }
    return { context: parts.join('\n\n---\n\n'), labels }
  })
}
