import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { safeRealJoin } from '../ai/path-policy'
import { isForbiddenPath } from '../ai/secret-scanner'

export interface MobileProjectRoot { path: string; name?: string; hidden?: boolean }
export interface MobileRootSummary { rootId: string; name: string; available: boolean }

function rootId(path: string): string {
  return createHash('sha256').update(`verstak-mobile-root:${path.toLowerCase()}`).digest('hex').slice(0, 24)
}

export function createRootCapabilities(projects: MobileProjectRoot[]) {
  const roots = new Map<string, MobileProjectRoot>()
  for (const project of projects) {
    if (!project.path || project.hidden) continue
    roots.set(rootId(project.path), project)
  }
  return {
    list(): MobileRootSummary[] {
      return [...roots].map(([id, project]) => ({ rootId: id, name: project.name?.trim() || basename(project.path), available: true }))
    },
    async resolve(id: string, relativePath: string): Promise<string> {
      const root = roots.get(id)
      if (!root) throw new Error('unknown root')
      if (isForbiddenPath(relativePath)) throw new Error('forbidden mobile path')
      return safeRealJoin(root.path, relativePath)
    },
    projectPath(id: string): string {
      const root = roots.get(id)
      if (!root) throw new Error('unknown root')
      return root.path
    },
  }
}

export type RootCapabilities = ReturnType<typeof createRootCapabilities>
