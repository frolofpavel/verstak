import { describe, it, expect } from 'vitest'
import {
  buildRunMemorySnapshot,
  memorySnapshotFingerprint,
  snapshotPromptMemories,
} from '../../electron/ai/memory/run-snapshot'
import type { MemoryProvider, MemorySnapshotEntry } from '../../electron/ai/memory/provider'

const entry = (id: string, content: string, tags: string[] = []): MemorySnapshotEntry => ({
  id,
  type: 'fact',
  content,
  tags,
  created_at: 1,
})

describe('run memory snapshot', () => {
  it('freezes recall/core memory at run start', () => {
    const relevance = [entry('rel', 'bug lives in calc.mjs')]
    const recency = [entry('summary', 'old chat summary', ['session-summary']), entry('recent', 'prefer small diffs')]
    const provider: MemoryProvider = {
      recall: () => relevance,
      recent: () => recency,
      consolidationHint: () => 'consolidate memory',
      loadCore: () => ({ memory: 'core memory', user: 'user rules' }),
    }

    const snapshot = buildRunMemorySnapshot(provider, {
      projectPath: '/project',
      query: 'fix calc bug',
      now: () => 123,
    })
    const promptMemories = snapshotPromptMemories(snapshot)

    relevance[0].content = 'mutated after snapshot'
    recency[1].tags.push('mutated')

    expect(snapshot.createdAt).toBe(123)
    expect(snapshot.entries.map(m => m.id)).toEqual(['rel', 'recent'])
    expect(promptMemories).toEqual([
      { type: 'fact', content: 'bug lives in calc.mjs', tags: [] },
      { type: 'fact', content: 'prefer small diffs', tags: [] },
    ])
    expect(snapshot.coreMemory).toEqual({ memory: 'core memory', user: 'user rules' })
    expect(snapshot.consolidationHint).toBe('consolidate memory')
  })

  it('can skip archival recall while still freezing core memory', () => {
    const provider: MemoryProvider = {
      recall: () => { throw new Error('should not recall') },
      recent: () => { throw new Error('should not load recency') },
      consolidationHint: () => 'unused',
      loadCore: () => ({ memory: 'always loaded', user: '' }),
    }

    const snapshot = buildRunMemorySnapshot(provider, {
      projectPath: '/project',
      query: '',
      includeRecall: false,
    })

    expect(snapshot.entries).toEqual([])
    expect(snapshot.consolidationHint).toBeNull()
    expect(snapshot.coreMemory.memory).toBe('always loaded')
  })

  it('creates a stable content-free fingerprint for prompt-cache diagnostics', () => {
    const provider: MemoryProvider = {
      recall: () => [entry('a', 'secret-ish content')],
      recent: () => [],
      loadCore: () => ({ memory: 'core', user: '' }),
    }

    const one = buildRunMemorySnapshot(provider, { projectPath: '/project', query: 'q', now: () => 1 })
    const two = buildRunMemorySnapshot(provider, { projectPath: '/project', query: 'q', now: () => 999 })

    expect(memorySnapshotFingerprint(one)).toBe(memorySnapshotFingerprint(two))
    expect(memorySnapshotFingerprint(one)).toMatch(/^[a-f0-9]{12}$/)
  })
})
