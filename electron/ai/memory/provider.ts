import { loadCoreMemory, type CoreMemoryBlocks } from '../core-memory'

export interface MemorySnapshotEntry {
  id: string
  type: string
  content: string
  tags: string[]
  created_at: number
}

export interface MemoryProvider {
  recall(projectPath: string, query: string, limit: number): MemorySnapshotEntry[]
  recent(projectPath: string, limit: number): MemorySnapshotEntry[]
  consolidationHint?(projectPath: string): string | null
  loadCore(projectPath: string): CoreMemoryBlocks
}

export interface LegacyMemoryProviderDeps {
  searchMemories: (projectPath: string, query: string, limit: number) => MemorySnapshotEntry[]
  memoryConsolidationHint?: (projectPath: string) => string | null
  loadCore?: (projectPath: string) => CoreMemoryBlocks
}

function cloneEntry(entry: MemorySnapshotEntry): MemorySnapshotEntry {
  return {
    id: entry.id,
    type: entry.type,
    content: entry.content,
    tags: [...entry.tags],
    created_at: entry.created_at,
  }
}

export function cloneMemoryEntries(entries: MemorySnapshotEntry[]): MemorySnapshotEntry[] {
  return entries.map(cloneEntry)
}

export function createLegacyMemoryProvider(deps: LegacyMemoryProviderDeps): MemoryProvider {
  return {
    recall(projectPath, query, limit) {
      return cloneMemoryEntries(deps.searchMemories(projectPath, query, limit))
    },
    recent(projectPath, limit) {
      return cloneMemoryEntries(deps.searchMemories(projectPath, '', limit))
    },
    consolidationHint(projectPath) {
      return deps.memoryConsolidationHint?.(projectPath) ?? null
    },
    loadCore(projectPath) {
      const blocks = (deps.loadCore ?? loadCoreMemory)(projectPath)
      return { memory: blocks.memory, user: blocks.user }
    },
  }
}
