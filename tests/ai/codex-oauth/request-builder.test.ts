import { describe, it, expect } from 'vitest'
import {
  buildHeaders,
  buildBody,
  userMessage,
  functionTool,
  functionCallOutput
} from '../../../electron/ai/codex-oauth/request-builder'

describe('codex-oauth request-builder — buildHeaders', () => {
  it('ставит Bearer, honest originator:verstak и session-id через ДЕФИС', () => {
    const h = buildHeaders({
      accessToken: 'acc_123',
      accountId: 'account_zzz',
      version: '0.21.0',
      appVersion: '2.0.4',
      sessionId: 'sess_abc',
      threadId: 'thr_def'
    })
    expect(h['Authorization']).toBe('Bearer acc_123')
    // originator честный — не codex_cli_rs
    expect(h['originator']).toBe('verstak')
    expect(h['originator']).not.toBe('codex_cli_rs')
    // именно через дефис, camelCase/underscore недопустимы
    expect(h['session-id']).toBe('sess_abc')
    expect(h['sessionId']).toBeUndefined()
    expect(h['session_id']).toBeUndefined()

    expect(h['ChatGPT-Account-ID']).toBe('account_zzz')
    expect(h['Content-Type']).toBe('application/json')
    expect(h['Accept']).toBe('text/event-stream')
    expect(h['User-Agent']).toBe('Verstak/2.0.4')
    expect(h['version']).toBe('0.21.0')
    expect(h['thread-id']).toBe('thr_def')
    expect(h['x-client-request-id']).toBe('thr_def')
  })

  it('минимальный вызов: без опциональных полей не пишет undefined-заголовки', () => {
    const h = buildHeaders({ accessToken: 'tok' })
    expect(h['Authorization']).toBe('Bearer tok')
    expect(h['originator']).toBe('verstak')
    // отсутствующие поля просто не попадают в объект
    expect('ChatGPT-Account-ID' in h).toBe(false)
    expect('session-id' in h).toBe(false)
    expect('thread-id' in h).toBe(false)
    expect('version' in h).toBe(false)
    // ни одно значение не строка "undefined"
    for (const v of Object.values(h)) expect(v).not.toContain('undefined')
  })
})

describe('codex-oauth request-builder — buildBody', () => {
  it('форма Responses API: store:false, stream:true, дефолты tools/reasoning/include', () => {
    const input = [userMessage('привет')]
    const body = buildBody({ model: 'gpt-5-codex', instructions: 'sys', input })
    expect(body.model).toBe('gpt-5-codex')
    expect(body.instructions).toBe('sys')
    expect(body.input).toBe(input)
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect(body.tool_choice).toBe('auto')
    expect(body.parallel_tool_calls).toBe(false)
    // дефолты
    expect(body.tools).toEqual([])
    expect(body.reasoning).toBeNull()
    // без reasoning include пустой
    expect(body.include).toEqual([])
  })

  it('reasoning → include содержит reasoning.encrypted_content и прокидывает reasoning', () => {
    const reasoning = { effort: 'medium' as const }
    const body = buildBody({
      model: 'gpt-5-codex',
      instructions: 'sys',
      input: [userMessage('ok')],
      tools: [functionTool('read_file', 'reads', { type: 'object' })],
      reasoning
    })
    expect(body.reasoning).toBe(reasoning)
    expect(body.include).toContain('reasoning.encrypted_content')
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0].name).toBe('read_file')
  })
})

describe('codex-oauth request-builder — хелперы элементов', () => {
  it('userMessage → message/input_text shape', () => {
    expect(userMessage('текст')).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'текст' }]
    })
  })

  it('functionTool → плоский function с strict:true', () => {
    const params = { type: 'object', properties: { path: { type: 'string' } } }
    expect(functionTool('write_file', 'writes a file', params)).toEqual({
      type: 'function',
      name: 'write_file',
      description: 'writes a file',
      parameters: params,
      strict: true
    })
  })

  it('functionCallOutput → function_call_output с call_id', () => {
    expect(functionCallOutput('call_7', 'result-payload')).toEqual({
      type: 'function_call_output',
      call_id: 'call_7',
      output: 'result-payload'
    })
  })
})
