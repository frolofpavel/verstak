import { createHash } from 'crypto'
import { fuseRanks } from '../memory-fusion'
import type { CoreMemoryBlocks } from '../core-memory'
import type { MemoryProvider, MemorySnapshotEntry } from './provider'
import { cloneMemoryEntries } from './provider'

export interface RunMemorySnapshot {
  projectPath: string
  query: string
  entries: MemorySnapshotEntry[]
  consolidationHint: string | null
  coreMemory: CoreMemoryBlocks
  createdAt: number
}

export interface BuildRunMemorySnapshotInput {
  projectPath: string
  query: string
  includeRecall?: boolean
  limit?: number
  now?: () => number
}

export function buildRunMemorySnapshot(provider: MemoryProvider, input: BuildRunMemorySnapshotInput): RunMemorySnapshot {
  const includeRecall = input.includeRecall ?? true
  const limit = input.limit ?? 5
  const query = input.query
  const relevance = includeRecall ? provider.recall(input.projectPath, query, limit) : []
  const recency = includeRecall
    ? provider.recent(input.projectPath, 20).filter(m => !m.tags.includes('session-summary')).slice(0, limit)
    : []
  const entries = cloneMemoryEntries(fuseRanks([relevance, recency]).slice(0, limit))
  const coreMemory = provider.loadCore(input.projectPath)

  return {
    projectPath: input.projectPath,
    query,
    entries,
    consolidationHint: includeRecall ? (provider.consolidationHint?.(input.projectPath) ?? null) : null,
    coreMemory: { memory: coreMemory.memory, user: coreMemory.user },
    createdAt: input.now?.() ?? Date.now(),
  }
}

export function snapshotPromptMemories(snapshot: RunMemorySnapshot): Array<{ type: string; content: string; tags: string[] }> {
  return snapshot.entries.map(entry => ({
    type: entry.type,
    content: entry.content,
    tags: [...entry.tags],
  }))
}

export function memorySnapshotFingerprint(snapshot: RunMemorySnapshot): string {
  const stable = {
    projectPath: snapshot.projectPath,
    query: snapshot.query,
    entryIds: snapshot.entries.map(entry => entry.id),
    consolidation: Boolean(snapshot.consolidationHint),
    coreMemoryChars: snapshot.coreMemory.memory.length,
    coreUserChars: snapshot.coreMemory.user.length,
  }
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 12)
}
