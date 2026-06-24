import { describe, it, expect } from 'vitest'
import { parseTextToolCalls } from '../../electron/ai/tool-call-repair'

// T1.5 — слабые/RU-модели (Ollama-сборки, GigaChat, Qwen, Mistral, gpt-oss) часто
// отдают вызов инструмента ТЕКСТОМ, а не структурным tool_calls. Без восстановления
// он падает в чат прозой и тулза не исполняется. Парсер вытаскивает вызов из
// известных текстовых форматов. Чистая логика — тестируется напрямую.
describe('parseTextToolCalls', () => {
  it('Qwen / Hermes <tool_call>{name,arguments}</tool_call>', () => {
    const t = 'Сейчас прочитаю файл.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "src/a.ts"}}\n</tool_call>'
    expect(parseTextToolCalls(t)).toEqual([{ name: 'read_file', args: { path: 'src/a.ts' } }])
  })

  it('тег <function=NAME>{args}</function> (args напрямую)', () => {
    const t = '<function=run_command>{"command": "ls -la"}</function>'
    expect(parseTextToolCalls(t)).toEqual([{ name: 'run_command', args: { command: 'ls -la' } }])
  })

  it('Harmony (gpt-oss): to=functions.NAME ... <|message|>{args}<|call|>', () => {
    const t = '<|channel|>commentary to=functions.read_file <|constrain|>json<|message|>{"path": "x.py"}<|call|>'
    expect(parseTextToolCalls(t)).toEqual([{ name: 'read_file', args: { path: 'x.py' } }])
  })

  it('Mistral [TOOL_CALLS][ {name,arguments} ]', () => {
    const t = '[TOOL_CALLS][{"name": "write_file", "arguments": {"path": "a", "content": "hi"}}]'
    expect(parseTextToolCalls(t)).toEqual([{ name: 'write_file', args: { path: 'a', content: 'hi' } }])
  })

  it('голый/огороженный JSON {tool, parameters}', () => {
    const t = 'Вот вызов:\n```json\n{"tool": "list_files", "parameters": {"dir": "."}}\n```'
    expect(parseTextToolCalls(t)).toEqual([{ name: 'list_files', args: { dir: '.' } }])
  })

  it('несколько вызовов подряд', () => {
    const t = '<tool_call>{"name":"a","arguments":{"x":1}}</tool_call><tool_call>{"name":"b","arguments":{"y":2}}</tool_call>'
    expect(parseTextToolCalls(t)).toEqual([{ name: 'a', args: { x: 1 } }, { name: 'b', args: { y: 2 } }])
  })

  it('обычная проза без вызова → []', () => {
    expect(parseTextToolCalls('Готово, я прочитал файл и всё понял.')).toEqual([])
  })

  it('пустой/мусор → [] (не падает)', () => {
    expect(parseTextToolCalls('')).toEqual([])
    expect(parseTextToolCalls('<tool_call>не json</tool_call>')).toEqual([])
  })

  it('args отсутствуют → пустой объект, не падает', () => {
    expect(parseTextToolCalls('<function=get_status></function>')).toEqual([{ name: 'get_status', args: {} }])
  })
})
