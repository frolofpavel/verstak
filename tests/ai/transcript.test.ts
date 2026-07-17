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

  // Срез 2.0.11-C: экспорт уходит наружу — пути с именем пользователя обязаны нормализоваться.
  it('нормализует пути приватности, когда дан контекст', () => {
    const md = buildTranscriptMarkdown(
      [{ role: 'user', content: 'ошибка в C:\\Users\\Pavel\\Progetc\\Проекты\\verstak\\src\\app.ts' }],
      { pathContext: { homeDir: 'C:\\Users\\Pavel', projectRoots: ['C:\\Users\\Pavel\\Progetc\\Проекты\\verstak'] } }
    )
    expect(md).not.toContain('Pavel')
    expect(md).toContain('<проект>\\src\\app.ts')
  })

  it('без контекста путей — поведение прежнее (пути не трогаем)', () => {
    const md = buildTranscriptMarkdown([{ role: 'user', content: 'C:\\Users\\Pavel\\x' }])
    expect(md).toContain('C:\\Users\\Pavel\\x')
  })

  // Секреты и пути — обе чистки на одном тексте.
  it('секрет И путь в одном сообщении — оба вычищены', () => {
    const md = buildTranscriptMarkdown(
      [{ role: 'user', content: 'ключ sk-ant-api03-SECRETSECRETSECRET1234567890 в C:\\Users\\Pavel\\cfg' }],
      { pathContext: { homeDir: 'C:\\Users\\Pavel' } }
    )
    expect(md).not.toContain('SECRETSECRETSECRET')
    expect(md).not.toContain('Pavel')
  })

  // Ре-ревью C #1 (HIGH): заголовок сессии авто-генерится из первого сообщения и лишь
  // усекается — путь/секрет из первой строки попадали в шапку экспорта СЫРЫМИ, мимо чисток.
  it('заголовок сессии чистится так же, как тело (секрет+путь не в шапке)', () => {
    const md = buildTranscriptMarkdown(
      [{ role: 'user', content: 'x' }],
      {
        title: 'почини C:\\Users\\Pavel\\app.ts ключ sk-ant-api03-TITLESECRET1234567890',
        pathContext: { homeDir: 'C:\\Users\\Pavel' },
      }
    )
    expect(md).not.toContain('Pavel')
    expect(md).not.toContain('TITLESECRET')
  })

  // Ре-ревью C #2 (HIGH): секрет в query-параметре URL (?token=/?sig=). scanText его не
  // ловит (опаковое значение), но redactForDisplay гасит по ИМЕНИ параметра. Экспорт
  // уходит наружу — он не должен быть слабее показа на экране.
  it('секрет в query-параметре URL вычищен (как на экране)', () => {
    const md = buildTranscriptMarkdown([
      { role: 'assistant', content: 'ссылка https://api.example.com/d?token=aB3xOpaqueTokenValue1234567890 готова' }
    ])
    expect(md).not.toContain('aB3xOpaqueTokenValue')
    expect(md).toContain('REDACTED')
  })

  it('подписанный S3/Я.Диск URL (?sig=/x-amz-signature) вычищен', () => {
    const md = buildTranscriptMarkdown([
      { role: 'assistant', content: 'https://s3.example.com/f?x-amz-signature=SIGSIGSIGSIG1234567890&other=ok' }
    ])
    expect(md).not.toContain('SIGSIGSIGSIG')
  })
})
