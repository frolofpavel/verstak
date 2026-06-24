import { describe, it, expect } from 'vitest'
import { runPtcCode } from '../../electron/ai/ptc'

// T1.4 PTC (Programmatic Tool Calling): агент пишет скрипт, оркестрирующий тулзы;
// в контекст попадает только итог (log/return), а не каждый промежуточный результат
// — кратно меньше токенов на read-тяжёлых задачах. Движок vm-в-процессе: фреш-контекст
// (нет process/require/fs), read-only тулзы инъектятся, таймаут. Юнит-тест на фейках.
const fakeTools = {
  read_file: async (args: Record<string, unknown>) => `content of ${args.path}`,
  list_directory: async () => 'a.ts\nb.ts',
}

describe('runPtcCode', () => {
  it('перехватывает log в output', async () => {
    const r = await runPtcCode({ code: 'log("hello")', tools: {} })
    expect(r.output).toBe('hello')
    expect(r.error).toBeUndefined()
  })

  it('вызывает инъектированные тулзы и считает вызовы', async () => {
    const r = await runPtcCode({ code: 'const c = await tools.read_file({path:"x.ts"}); log(c)', tools: fakeTools })
    expect(r.output).toContain('content of x.ts')
    expect(r.toolCalls).toBe(1)
  })

  it('оркестрирует много вызовов, в output только итог', async () => {
    const code = `
      const files = (await tools.list_directory({})).split("\\n")
      let n = 0
      for (const f of files) { await tools.read_file({path:f}); n++ }
      log("прочитано " + n + " файлов")
    `
    const r = await runPtcCode({ code, tools: fakeTools })
    expect(r.output).toBe('прочитано 2 файлов')
    expect(r.toolCalls).toBe(3) // 1 list + 2 read
  })

  it('песочница без process/require/fs (read-only)', async () => {
    const r = await runPtcCode({ code: 'log(typeof process + "," + typeof require)', tools: {} })
    expect(r.output).toBe('undefined,undefined')
  })

  it('синхронный бесконечный цикл → таймаут (не вешает)', async () => {
    const r = await runPtcCode({ code: 'while(true){}', tools: {}, timeoutMs: 200 })
    expect(r.error).toBeTruthy()
  })

  it('брошенная ошибка перехвачена, частичный output сохранён', async () => {
    const r = await runPtcCode({ code: 'log("before"); throw new Error("boom")', tools: {} })
    expect(r.output).toContain('before')
    expect(r.error).toContain('boom')
  })

  it('огромный вывод обрезается до maxOutput', async () => {
    const r = await runPtcCode({ code: 'for(let i=0;i<5000;i++) log("x".repeat(50))', tools: {}, maxOutput: 1000, timeoutMs: 3000 })
    expect(r.output.length).toBeLessThan(1300)
  })

  it('возвращённое значение без log становится output', async () => {
    const r = await runPtcCode({ code: 'return 2+2', tools: {} })
    expect(r.output).toBe('4')
  })

  it('вызов неизвестной тулзы → ошибка скрипта, не краш движка', async () => {
    const r = await runPtcCode({ code: 'await tools.write_file({path:"x"})', tools: fakeTools })
    expect(r.error).toBeTruthy()
  })
})
