import { describe, it, expect } from 'vitest'
import {
  CodexSseReducer,
  reduceCodexSse,
  type CodexSseEvent
} from '../../electron/ai/codex-oauth/sse-reducer'

describe('CodexSseReducer — текстовый стрим', () => {
  it('накапливает output_text.delta и завершается по completed', () => {
    const events: CodexSseEvent[] = [
      { type: 'response.created' },
      { type: 'response.output_text.delta', delta: 'Привет' },
      { type: 'response.output_text.delta', delta: ', ' },
      { type: 'response.output_text.delta', delta: 'мир' },
      {
        type: 'response.output_item.done',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Привет, мир' }]
        }
      },
      { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 } } }
    ]
    const r = reduceCodexSse(events)
    expect(r.text).toBe('Привет, мир')
    expect(r.toolCalls).toEqual([])
    expect(r.done).toBe(true)
    expect(r.error).toBeUndefined()
  })

  it('без message-item отдаёт текст из накопленных дельт (fallback)', () => {
    const r = reduceCodexSse([
      { type: 'response.output_text.delta', delta: 'a' },
      { type: 'response.output_text.delta', delta: 'b' },
      { type: 'response.completed', response: {} }
    ])
    expect(r.text).toBe('ab')
    expect(r.done).toBe(true)
  })
})

describe('CodexSseReducer — function_call', () => {
  it('собирает tool-call из дельт аргументов + output_item.done с распарсенным JSON', () => {
    const events: CodexSseEvent[] = [
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"src/a.ts"}' },
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_abc',
          name: 'read_file',
          arguments: '{"path":"src/a.ts"}',
          status: 'completed'
        }
      },
      { type: 'response.completed', response: {} }
    ]
    const r = reduceCodexSse(events)
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0].callId).toBe('call_abc')
    expect(r.toolCalls[0].name).toBe('read_file')
    expect(r.toolCalls[0].arguments).toEqual({ path: 'src/a.ts' })
    expect(r.text).toBe('')
    expect(r.done).toBe(true)
  })

  it('битый JSON аргументов не роняет — возвращает исходную строку', () => {
    const r = reduceCodexSse([
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'fc_9', call_id: 'call_9', name: 'do_it', arguments: '{oops' }
      },
      { type: 'response.completed', response: {} }
    ])
    expect(r.toolCalls[0].arguments).toBe('{oops')
  })

  it('function_call_arguments.done авторитетнее накопленных дельт', () => {
    const r = reduceCodexSse([
      { type: 'response.function_call_arguments.delta', item_id: 'fc_2', delta: '{"partial"' },
      { type: 'response.function_call_arguments.done', item_id: 'fc_2', arguments: '{"q":"final"}' },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'search' }
      },
      { type: 'response.completed', response: {} }
    ])
    // arguments из .done, а не сломанная накопленная строка дельт
    expect(r.toolCalls[0].arguments).toEqual({ q: 'final' })
    expect(r.toolCalls[0].name).toBe('search')
    expect(r.toolCalls[0].callId).toBe('call_2')
  })
})

describe('CodexSseReducer — регрессия Hermes (output=null)', () => {
  it('completed с response.output=null, но пришедшими output_item.done → результат НЕ пустой', () => {
    const events: CodexSseEvent[] = [
      {
        type: 'response.output_item.done',
        item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'настоящий ответ' }] }
      },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'fc_h', call_id: 'call_h', name: 'run_command', arguments: '{"cmd":"ls"}' }
      },
      // Приватный backend отдаёт output: null — мы его игнорируем.
      {
        type: 'response.completed',
        response: { output: null, usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } }
      }
    ]
    const r = reduceCodexSse(events)
    expect(r.text).toBe('настоящий ответ')
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0].name).toBe('run_command')
    expect(r.toolCalls[0].arguments).toEqual({ cmd: 'ls' })
    // текст точно не потерян
    expect(r.text.length).toBeGreaterThan(0)
  })
})

describe('CodexSseReducer — usage mapping', () => {
  it('мапит все поля usage в camelCase', () => {
    const r = reduceCodexSse([
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 40 },
            output_tokens: 20,
            output_tokens_details: { reasoning_tokens: 12 },
            total_tokens: 120
          }
        }
      }
    ])
    expect(r.usage).toEqual({
      inputTokens: 100,
      cachedTokens: 40,
      outputTokens: 20,
      reasoningTokens: 12,
      totalTokens: 120
    })
  })

  it('отсутствующие вложенные детали usage → нули, не падает', () => {
    const r = reduceCodexSse([
      { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } } }
    ])
    expect(r.usage).toEqual({
      inputTokens: 5,
      cachedTokens: 0,
      outputTokens: 7,
      reasoningTokens: 0,
      totalTokens: 12
    })
  })
})

describe('CodexSseReducer — ошибки', () => {
  it('response.failed → error + done', () => {
    const r = reduceCodexSse([
      { type: 'response.output_text.delta', delta: 'частично' },
      { type: 'response.failed', response: { error: { message: 'rate limit', code: '429' } } }
    ])
    expect(r.error).toBe('rate limit')
    expect(r.done).toBe(true)
  })

  it('error-событие со строкой', () => {
    const r = reduceCodexSse([{ type: 'error', error: 'boom' }])
    expect(r.error).toBe('boom')
    expect(r.done).toBe(true)
  })

  it('error-событие с объектом {message}', () => {
    const r = reduceCodexSse([{ type: 'error', error: { message: 'stream broke' } }])
    expect(r.error).toBe('stream broke')
  })

  it('failed без деталей → дефолтная строка', () => {
    const r = reduceCodexSse([{ type: 'response.failed' }])
    expect(r.error).toBe('Codex Responses stream failed')
  })
})

describe('CodexSseReducer — прямой push/getResult', () => {
  it('до completed done=false, результат читается инкрементально', () => {
    const reducer = new CodexSseReducer()
    reducer.push({ type: 'response.output_text.delta', delta: 'ещё пишу' })
    const mid = reducer.getResult()
    expect(mid.done).toBe(false)
    expect(mid.text).toBe('ещё пишу')
    reducer.push({ type: 'response.completed', response: {} })
    expect(reducer.getResult().done).toBe(true)
  })
})
