import { describe, it, expect, beforeEach } from 'vitest'
import { captureToolObservation } from '../../electron/ai/memory-hooks'

type Saved = { projectPath: string; type: string; content: string; tags: string[] }

function collector() {
  const saved: Saved[] = []
  const saveMemory = (projectPath: string, type: string, content: string, tags: string[]) => {
    saved.push({ projectPath, type, content, tags })
    return { id: `m${saved.length}` }
  }
  return { saved, saveMemory }
}

describe('memory-hooks — captureToolObservation', () => {
  // Дедуп — модульный, поэтому уникализируем команды между тестами.
  let n = 0
  beforeEach(() => { n++ })

  it('редактирует секрет в команде перед записью (ревью HIGH)', () => {
    const { saved, saveMemory } = collector()
    captureToolObservation(saveMemory, {
      tool: 'run_command',
      args: { command: `curl -H 'Authorization: Bearer sk-ant-api03-SECRET${n}'` },
      result: 'exit code 0',
      projectPath: '/proj/a'
    })
    expect(saved).toHaveLength(1)
    expect(saved[0].content).not.toContain('sk-ant-api03-SECRET')
    expect(saved[0].content).toContain('REDACTED')
  })

  it('дедуп привязан к проекту: та же команда в разных проектах пишется в оба (ревью LOW)', () => {
    const { saved, saveMemory } = collector()
    const cmd = `echo build-${n}`
    captureToolObservation(saveMemory, { tool: 'run_command', args: { command: cmd }, result: 'exit code 0', projectPath: '/proj/a' })
    captureToolObservation(saveMemory, { tool: 'run_command', args: { command: cmd }, result: 'exit code 0', projectPath: '/proj/b' })
    // разные проекты → 2 записи (раньше проект B глушился дедупом проекта A)
    expect(saved.map(s => s.projectPath)).toEqual(['/proj/a', '/proj/b'])
  })

  it('дубль в ОДНОМ проекте гасится', () => {
    const { saved, saveMemory } = collector()
    const cmd = `echo same-${n}`
    captureToolObservation(saveMemory, { tool: 'run_command', args: { command: cmd }, result: 'exit code 0', projectPath: '/proj/a' })
    captureToolObservation(saveMemory, { tool: 'run_command', args: { command: cmd }, result: 'exit code 0', projectPath: '/proj/a' })
    expect(saved).toHaveLength(1)
  })
})
