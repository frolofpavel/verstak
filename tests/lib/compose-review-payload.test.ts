import { describe, it, expect } from 'vitest'
import { composeReviewPayload } from '../../src/lib/compose-review-payload'
import type { ChatMessage, VerificationRow } from '../../src/types/api'

/**
 * composeReviewPayload — сериализует ТОЛЬКО последний шаг основного чата для ревьюера:
 *  - last assistant + предшествующий ему user (не история целиком);
 *  - опциональный git diff (даёт реальные номера строк, иначе file:line галлюцинируются);
 *  - опциональный VERIFICATION-блок (ревьюер сверяет заявленный DoD, а не верит на слово);
 *  - длинные тексты обрезаются с маркером.
 */

function msg(role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { role, content, ...extra } as ChatMessage
}

describe('composeReviewPayload', () => {
  it('берёт ТОЛЬКО последний turn (last assistant + предшествующий user), не историю', () => {
    const out = composeReviewPayload([
      msg('user', 'СТАРЫЙ запрос'),
      msg('assistant', 'СТАРЫЙ ответ'),
      msg('user', 'НОВЫЙ запрос'),
      msg('assistant', 'НОВЫЙ ответ')
    ])
    expect(out).toContain('НОВЫЙ запрос')
    expect(out).toContain('НОВЫЙ ответ')
    expect(out).not.toContain('СТАРЫЙ запрос')
    expect(out).not.toContain('СТАРЫЙ ответ')
  })

  it('всегда есть заголовок и блок задачи, даже на пустом входе', () => {
    const out = composeReviewPayload([])
    expect(out).toContain('# Ревью последнего шага агента')
    expect(out).toContain('## Задача')
  })

  it('без diff и verification — соответствующих блоков нет', () => {
    const out = composeReviewPayload([msg('user', 'запрос'), msg('assistant', 'ответ')])
    expect(out).not.toContain('```diff')
    expect(out).not.toContain('VERIFICATION')
  })

  it('diff → fenced-блок + инструкция привязки file:line к реальным строкам', () => {
    const diff = '--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new'
    const out = composeReviewPayload([msg('user', 'q'), msg('assistant', 'a')], null, diff)
    expect(out).toContain('```diff')
    expect(out).toContain('+new')
    expect(out).toContain('Привязывай file:line')
  })

  it('verification → блок DoD с человекочитаемым итогом и просьбой сверить', () => {
    const v: VerificationRow = {
      overall: 'partial', checksPassed: 1, checksTotal: 3, changedFilesCount: 2,
      taskSummary: 'добавил фичу X'
    } as VerificationRow
    const out = composeReviewPayload([msg('user', 'q'), msg('assistant', 'готово')], v)
    expect(out).toContain('VERIFICATION (заявленный DoD)')
    expect(out).toContain('проверено частично')         // partial → RU
    expect(out).toContain('1/3')                          // checksPassed/Total
    expect(out).toContain('добавил фичу X')
    expect(out).toContain('Сверь')
  })

  it('thinking агента включается отдельным блоком', () => {
    const out = composeReviewPayload([
      msg('user', 'q'),
      msg('assistant', 'ответ', { thinking: 'внутренний ход мысли' })
    ])
    expect(out).toContain('Размышление агента')
    expect(out).toContain('внутренний ход мысли')
  })

  it('вложения last user отмечаются', () => {
    const out = composeReviewPayload([
      msg('user', 'q', { attachments: [{ name: 'screenshot.png' }] as ChatMessage['attachments'] }),
      msg('assistant', 'a')
    ])
    expect(out).toContain('Вложений: 1')
    expect(out).toContain('screenshot.png')
  })

  it('длинный ответ обрезается с маркером', () => {
    const huge = 'x'.repeat(9000)
    const out = composeReviewPayload([msg('user', 'q'), msg('assistant', huge)])
    expect(out).toContain('[...обрезано, всего 9000 символов]')
    expect(out).not.toContain('x'.repeat(8500))           // полностью не вошёл
  })

  it('assistant без предшествующего user → блок ответа есть, блока запроса нет', () => {
    const out = composeReviewPayload([msg('assistant', 'одинокий ответ')])
    expect(out).toContain('одинокий ответ')
    expect(out).not.toContain('## Запрос пользователя')
  })
})
