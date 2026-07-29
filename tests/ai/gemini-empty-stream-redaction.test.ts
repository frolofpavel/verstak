// Сырой ответ модели, который доходит ЧЕЛОВЕКУ НА ЭКРАН (29.07).
//
// Когда Gemini возвращает пустой поток, провайдер объясняет почему и показывает
// образец первого чанка — это правильно и убирать нельзя: без образца сообщение
// «пусто, разбирайтесь сами» теряет всю ценность. Но образец шёл сырым, мимо
// `scanText`. Это ХУЖЕ вчерашней строки в логе, которую мы убрали: лог никто не
// читает, а сюда смотрит человек.
//
// Пины ниже проверяют оба свойства сразу, потому что порознь каждое можно
// «выполнить» испортив другое: секрет не доходит И образец доходит.
import { describe, it, expect } from 'vitest'
import { createGeminiProvider } from '../../electron/ai/gemini'
import type { ChatEvent, ChatMessage } from '../../electron/ai/types'

/** Ключ формы `google-api` — ровно то, что `scanText` обязан узнать. */
const KEY = 'AIza' + 'B'.repeat(35)

/** SDK-заглушка: провайдер принимает её параметром `sdk` (шов уже был). */
function sdkYielding(chunks: unknown[]) {
  return {
    models: {
      generateContentStream: async () => (async function* () {
        for (const c of chunks) yield c
      })(),
    },
  }
}

const ASK: ChatMessage[] = [{ role: 'user', content: 'привет' }]

async function collect(chunks: unknown[]): Promise<string> {
  const provider = createGeminiProvider({ apiKey: 'test', sdk: sdkYielding(chunks) })
  const out: string[] = []
  for await (const ev of provider.send(ASK, [], undefined, undefined) as AsyncIterable<ChatEvent>) {
    if (ev.type === 'text' && typeof ev.text === 'string') out.push(ev.text)
  }
  return out.join('')
}

describe('пустой поток Gemini: образец доходит до человека ОЧИЩЕННЫМ', () => {
  it('секрет из чанка НЕ достаётся пользователю', async () => {
    const text = await collect([{ note: KEY }])

    expect(text, 'мы не в той ветке — тест проверяет не то').toContain('пустой ответ')
    expect(text, 'ключ ушёл человеку сырым').not.toContain(KEY)
    expect(text, 'следа очистки нет — значит scanText не отработал').toContain('[REDACTED:google-api]')
  })

  // ГЛАВНЫЙ КОНТРОЛЬ ЗАДАЧИ: диагностику убирать нельзя. Без этого пина «фикс»
  // мог бы состоять в том, чтобы вообще перестать показывать образец.
  it('образец без секретов доходит до человека как был — диагностика жива', async () => {
    const text = await collect([{ candidates: [{ finishReason: undefined }], marker: 'пусто-без-секретов' }])

    expect(text).toContain('пустой ответ')
    expect(text, 'образец пропал — человек лишился объяснения').toContain('пусто-без-секретов')
    expect(text).not.toContain('[REDACTED')
  })

  it('в сообщении остаются счётчики, по которым человек понимает масштаб', async () => {
    const text = await collect([{ a: 1 }, { b: 2 }])
    expect(text).toContain('2 chunks')
  })

  // КОНТРОЛЬ ВТОРОЙ СТОРОНЫ: обычный ответ модели через очистку не портится.
  it('контроль: непустой ответ отдаётся дословно', async () => {
    const text = await collect([{ text: 'Готово: посчитал 2 + 2 = 4.' }])
    expect(text).toBe('Готово: посчитал 2 + 2 = 4.')
  })

  // Ветка с известной причиной образец не показывает вовсе — и не должна.
  it('контроль: при явной причине показывается причина, а не дамп', async () => {
    const text = await collect([{ promptFeedback: { blockReason: 'SAFETY' }, secret: KEY }])
    expect(text).toContain('заблокирован')
    expect(text, 'дамп просочился в ветку с известной причиной').not.toContain(KEY)
  })
})
