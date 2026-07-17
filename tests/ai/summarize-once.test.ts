import { describe, it, expect, vi } from 'vitest'
import { summarizeOnce } from '../../electron/ai/summarize-once'
import type { ChatProvider, ChatEvent } from '../../electron/ai/types'

/** Мок send с сохранением сигнатуры — иначе vi.fn выводит пустой кортеж аргументов. */
const spySend = () => vi.fn<ChatProvider['send']>(async function* (): AsyncGenerator<ChatEvent> {
  yield { type: 'text', text: 'итог' }
})

/**
 * Срез 2.0.11-B: одноразовый вызов модели для summary.
 *
 * Главное, что здесь проверяется — ловушка контракта провайдеров: они НЕ бросают
 * исключение на ошибке, а отдают { type: 'error' } в поток. Сборщик, который этого не
 * знает, принимает отказ провайдера за пустой ответ.
 */

const provider = (script: ChatEvent[]): ChatProvider => ({
  id: 'mock', name: 'mock', models: ['mock'],
  async *send(): AsyncGenerator<ChatEvent> { for (const e of script) yield e },
})

describe('summarizeOnce', () => {
  it('собирает текст из потока', async () => {
    const p = provider([{ type: 'text', text: 'итог ' }, { type: 'text', text: 'разговора' }])
    expect(await summarizeOnce(p, [{ role: 'user', content: 'сожми' }])).toBe('итог разговора')
  })

  // Ловушка: провайдеры yield'ят error, а не throw. Тот же класс дефекта однажды
  // сделал smart-fallback и backoff мёртвыми.
  it('событие error поднимается исключением, а НЕ выглядит пустым ответом', async () => {
    const p = provider([{ type: 'error', message: '429 rate limit' }])
    await expect(summarizeOnce(p, [{ role: 'user', content: 'сожми' }])).rejects.toThrow('429 rate limit')
  })

  it('error после текста тоже поднимается (частичный итог — не итог)', async () => {
    const p = provider([{ type: 'text', text: 'начало...' }, { type: 'error', message: 'оборвалось' }])
    await expect(summarizeOnce(p, [{ role: 'user', content: 'сожми' }])).rejects.toThrow('оборвалось')
  })

  it('error без описания не превращается в пустое исключение', async () => {
    const p = provider([{ type: 'error', message: '' }])
    await expect(summarizeOnce(p, [{ role: 'user', content: 'сожми' }])).rejects.toThrow(/ошибку/)
  })

  it('пустой поток → пустая строка (сервис расценит как осечку)', async () => {
    expect(await summarizeOnce(provider([]), [{ role: 'user', content: 'сожми' }])).toBe('')
  })

  it('служебные события не попадают в итог', async () => {
    const p = provider([
      { type: 'thought', text: 'размышляю про себя' },
      { type: 'text', text: 'настоящий итог' },
    ])
    expect(await summarizeOnce(p, [{ role: 'user', content: 'сожми' }])).toBe('настоящий итог')
  })

  // Сжатие контекста не должно ходить в файлы и что-то менять в мире.
  it('инструменты модели не даются', async () => {
    const send = spySend()
    await summarizeOnce({ id: 'm', name: 'm', models: ['m'], send }, [{ role: 'user', content: 'x' }])
    expect(send.mock.calls[0][1]).toEqual([])
  })

  it('abort-сигнал пробрасывается провайдеру (Stop рвёт стрим, а не платит за него)', async () => {
    const send = spySend()
    const ctrl = new AbortController()
    await summarizeOnce({ id: 'm', name: 'm', models: ['m'], send }, [{ role: 'user', content: 'x' }], ctrl.signal)
    expect(send.mock.calls[0][3]).toBe(ctrl.signal)
  })
})
