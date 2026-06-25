import { describe, it, expect } from 'vitest'
import { executeCodeHandler } from '../../electron/ipc/tool-handlers/execute-code'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'

// T1.4 PTC — проверка ХЕНДЛЕРА end-to-end (движок ptc.ts покрыт отдельно): execute_code
// строит read-only тулзы через FileTools.execute, прогоняет скрипт, гейтит по режиму.
function makeCtx(
  agentMode: string,
  execImpl: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): ToolContext {
  return {
    agentMode,
    sendId: 1,
    sender: { send: () => {} },
    tools: { execute: execImpl },
  } as unknown as ToolContext
}

const call = (code: string) => ({ id: 'c1', name: 'execute_code', args: { code } })

describe('executeCodeHandler', () => {
  it('auto: оркеструет read-only тулзы и возвращает только итог', async () => {
    const seen: string[] = []
    const ctx = makeCtx('auto', async (name, args) => {
      seen.push(`${name}:${JSON.stringify(args)}`)
      return name === 'read_file' ? 'FILE_CONTENT' : ''
    })
    const r = await executeCodeHandler.handle(
      call('const c = await tools.read_file({path:"a.ts"}); log("got:" + c)'),
      ctx,
    )
    expect(r.error).toBeUndefined()
    expect(String(r.result)).toContain('got:FILE_CONTENT')
    expect(seen.some(s => s.startsWith('read_file:'))).toBe(true)
  })

  it('plan: execute_code заблокирован (trust = команда)', async () => {
    let ran = false
    const ctx = makeCtx('plan', async () => { ran = true; return 'x' })
    const r = await executeCodeHandler.handle(call('log("hi")'), ctx)
    expect(r.error).toBeTruthy()
    expect(ran).toBe(false) // скрипт не исполнялся
  })

  it('write/command-тулзы внутри песочницы недоступны (только read-only)', async () => {
    const ctx = makeCtx('auto', async (name) => name)
    const r = await executeCodeHandler.handle(call('await tools.write_file({path:"x", content:"y"})'), ctx)
    // write_file не в PTC_READONLY_TOOLS → tools.write_file undefined → ошибка скрипта
    expect(`${r.result}${r.error ?? ''}`).toMatch(/ошибк|error|not a function/i)
  })

  it('пустой code → ошибка', async () => {
    const ctx = makeCtx('auto', async () => '')
    const r = await executeCodeHandler.handle(call('   '), ctx)
    expect(r.error).toBeTruthy()
  })
})
