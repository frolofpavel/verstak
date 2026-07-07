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

import { ipcMain } from 'electron'
import { writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import type { SkillRegistry } from '../ai/skills/types'
import { lookupLoader } from '../ai/skills/loaders'
import { buildCapturedSkill, deriveSkillId } from '../ai/skills/capture'
import { USER_SKILLS_DIR } from '../ai/skills/loader'
import type { SkillUsageStore } from '../storage/skill-usage'

interface RunLoadersDeps {
  getSecret?: (key: string) => string | null
  skillUsage?: SkillUsageStore
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
