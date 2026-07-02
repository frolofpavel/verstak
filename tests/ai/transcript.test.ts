import { describe, it, expect } from 'vitest'
import { buildTranscriptMarkdown } from '../../electron/ai/transcript'

describe('buildTranscriptMarkdown — полный экспорт диалога', () => {
  it('рендерит роли с заголовками и разделителями', () => {
    const md = buildTranscriptMarkdown([
      { role: 'user', content: 'привет' },
      { role: 'assistant', content: 'здравствуйте' }
    ], { title: 'Моя сессия', provider: 'claude' })
    expect(md).toContain('# Транскрипт: Моя сессия')
    expect(md).toContain('провайдер: claude')
    expect(md).toContain('🧑')          // роль пользователя
    expect(md).toContain('🤖')          // роль ассистента
    expect(md).toContain('привет')
    expect(md).toContain('здравствуйте')
    expect(md).toContain('---')         // разделитель между сообщениями
  })

  it('редактирует секреты (в отличие от handoff)', () => {
    const md = buildTranscriptMarkdown([
      { role: 'user', content: 'ключ sk-ant-api03-SECRETSECRETSECRET1234567890' }
    ])
    expect(md).not.toContain('SECRETSECRETSECRET')
    expect(md).toContain('REDACTED')
  })

  it('пустой диалог → только заголовок, без падения', () => {
    const md = buildTranscriptMarkdown([], { title: 'Пусто' })
    expect(md).toContain('# Транскрипт: Пусто')
    expect(md).toContain('сообщений: 0')
  })

  it('неизвестная роль отдаётся как есть', () => {
    const md = buildTranscriptMarkdown([{ role: 'tool', content: 'x' }])
    expect(md).toContain('tool')
  })

  it('таймстемп форматируется если задан', () => {
    const md = buildTranscriptMarkdown([{ role: 'user', content: 'x', createdAt: Date.parse('2026-07-02T08:05:00') }])
    expect(md).toMatch(/02\.07\.2026 08:05/)
  })
})
