import { describe, expect, it } from 'vitest'

import { TOOL_DEFS } from '../../../electron/ai/tools'
import { decide, MUTATING_COMPUTER_TOOLS } from '../../../electron/ai/mode-policy'
import { isMutatingTool } from '../../../electron/storage/agent-runs'
import { lookupHandler } from '../../../electron/ipc/tool-handlers'
import { unknownToolHandler } from '../../../electron/ipc/tool-handlers/file-ops'
import { summarizeToolCall } from '../../../electron/ipc/tool-handlers/shared'
import { changesObservation } from '../../../electron/ai/loop-detect'
import { extractArgText } from '../../../electron/ai/permission-rules'

const COMPUTER_TOOLS = [
  'computer_observe',
  'computer_click',
  'computer_type',
  'computer_key',
  'computer_scroll',
  'computer_wait_for',
] as const

const MUTATING = [
  'computer_click',
  'computer_type',
  'computer_key',
  'computer_scroll',
] as const

const READ_ONLY = ['computer_observe', 'computer_wait_for'] as const

describe('R2 Computer Use: production tool contract', () => {
  it('publishes only the six task-scoped agent tools (window binding stays renderer-owned)', () => {
    const names = TOOL_DEFS.map(tool => tool.name).filter(name => name.startsWith('computer_'))
    expect(names).toEqual(COMPUTER_TOOLS)
    expect(names).not.toContain('computer_bind')
    expect(names).not.toContain('computer_list_windows')
    expect(names).not.toContain('computer_unbind')
  })

  it.each(COMPUTER_TOOLS)('%s has an explicit sequential handler', name => {
    const handler = lookupHandler(name)
    expect(handler, `${name} must not fall through to unknownToolHandler`).not.toBe(unknownToolHandler)
    expect(handler.mode).toBe('sequential')
  })

  it('keeps effectful computer actions out of plan mode', () => {
    expect(MUTATING_COMPUTER_TOOLS).toEqual(MUTATING)
    for (const name of MUTATING) {
      expect(decide(name, 'plan'), name).toBe('block')
      expect(isMutatingTool(name), name).toBe(true)
    }
  })

  it('keeps observe/wait read-only while unknown computer tools fail closed for crash resume', () => {
    for (const name of READ_ONLY) {
      expect(decide(name, 'plan'), name).toBe('auto-accept')
      expect(isMutatingTool(name), name).toBe(false)
    }
    expect(isMutatingTool('computer_future_effect')).toBe(true)
  })

  it('resets observation-loop state after desktop effects but not after desktop reads', () => {
    for (const name of MUTATING) expect(changesObservation(name), name).toBe(true)
    for (const name of READ_ONLY) expect(changesObservation(name), name).toBe(false)
  })

  it('summarizes every desktop action without persisting typed text', () => {
    const secretText = 'private-R2-text-that-must-not-be-logged'
    for (const name of COMPUTER_TOOLS) {
      const args = name === 'computer_type'
        ? { observationId: 'obs-1', elementRef: 'el-2', text: secretText }
        : { observationId: 'obs-1', elementRef: 'el-2', text: 'ready' }
      const summary = summarizeToolCall(name, args, { status: 'verified' })
      expect(summary?.label, name).toBe(name)
      expect(summary?.detail.trim().length, name).toBeGreaterThan(0)
      expect(JSON.stringify(summary), name).not.toContain(secretText)
    }
  })

  it('matches permission rules on an opaque target without copying typed text', () => {
    const secretText = 'private-R2-permission-value'
    const projected = extractArgText('computer_type', {
      observationId: 'obs-1', elementRef: 'el-2', text: secretText,
    })
    expect(projected).toBe('selected-element')
    expect(projected).not.toContain(secretText)
  })

  it('publishes only arguments that the production handler and selected-element controller execute', () => {
    const byName = new Map(TOOL_DEFS.map(tool => [tool.name, tool]))
    const properties = (name: string) => byName.get(name)?.parameters.properties ?? {}
    const required = (name: string) => byName.get(name)?.parameters.required ?? []

    expect(properties('computer_click')).not.toHaveProperty('x')
    expect(properties('computer_click')).not.toHaveProperty('y')
    for (const name of ['computer_click', 'computer_type', 'computer_key', 'computer_scroll']) {
      expect(required(name), name).toContain('observationId')
      expect(required(name), name).toContain('elementRef')
      expect(properties(name), name).toHaveProperty('elementRef')
    }
    expect(properties('computer_wait_for')).toHaveProperty('elementRef')
    expect(properties('computer_wait_for')).toMatchObject({ text: { type: 'string', minLength: 1 } })
    expect(required('computer_wait_for')).toContain('text')
    expect(properties('computer_type')).toMatchObject({ text: { type: 'string', minLength: 1 } })
    expect(properties('computer_type')).not.toHaveProperty('clearFirst')
    expect(properties('computer_scroll')).toMatchObject({
      deltaX: { type: 'number', enum: [-1, 0, 1] },
      deltaY: { type: 'number', enum: [-1, 0, 1] },
    })
  })

  it('publishes the complete bounded navigation-key allowlist supported by the controller', () => {
    const keyTool = TOOL_DEFS.find(tool => tool.name === 'computer_key')
    const keyProperties = keyTool?.parameters.properties as Record<string, unknown> | undefined
    expect(keyProperties?.key).toMatchObject({
      type: 'string',
      enum: ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown'],
    })
  })

  it('describes the production UIA-only boundary including verified InvokePattern without promising global input', () => {
    const descriptions = new Map(TOOL_DEFS.map(tool => [tool.name, tool.description]))
    expect(descriptions.get('computer_click')).toMatch(/UIA.*(?:Toggle|SelectionItem).*InvokePattern.*readback.*координат.*отключ/iu)
    expect(descriptions.get('computer_type')).toMatch(/UIA ValuePattern.*чанк.*до 16.*SendInput.*отключ/iu)
    expect(descriptions.get('computer_key')).toMatch(/SendInput.*отключ.*заблокирован/iu)
    expect(descriptions.get('computer_scroll')).toMatch(/UIA ScrollPattern.*один.*small step.*SendInput.*отключ/iu)
  })
})
