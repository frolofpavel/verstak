import type { ChatProvider, ChatMessage } from './types'

/**
 * Одноразовый вызов модели вне agent-loop — срез 2.0.11-B (для summary компакции).
 *
 * ГЛАВНАЯ ЛОВУШКА ЗДЕСЬ. Провайдеры Verstak НЕ бросают исключение на ошибке — они
 * отдают событие `{ type: 'error' }` в поток и спокойно завершаются. Наивный сборщик
 * («собери все text и верни») принял бы отказ провайдера за пустой ответ. Для компакции
 * это тихо превратило бы «модель упала» в «модель вернула пустоту» — разные причины с
 * одинаковым молчанием. Поэтому error-событие здесь ЯВНО поднимается исключением.
 *
 * (Тот же класс дефекта однажды сделал smart-fallback и backoff мёртвыми: они ждали
 * throw, которого провайдеры не делают.)
 */

export async function summarizeOnce(
  provider: ChatProvider,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  // Инструменты не даём принципиально: задача summary — пересказать, а не пойти
  // читать файлы или что-то менять. Сжатие контекста не должно ничего делать с миром.
  let text = ''
  for await (const ev of provider.send(messages, [], undefined, signal)) {
    if (ev.type === 'error') {
      throw new Error(ev.message || 'провайдер вернул ошибку без описания')
    }
    if (ev.type === 'text') text += ev.text
  }
  return text.trim()
}
