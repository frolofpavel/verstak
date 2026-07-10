import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'os'

// runtime-log тянет electron (app/ipcMain) на загрузке — мокаем.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, ipcMain: { handle: () => {} } }))

const { sanitize } = await import('../electron/runtime-log')

describe('runtime-log sanitize — редакция ЗНАЧЕНИЙ, не только по имени ключа (1.9.8 #6)', () => {
  it('секрет в строковом значении под НЕ-секрет ключом (stderr) редактируется', () => {
    const out = sanitize({ stderr: 'fatal: remote https://user:supersecretpw@github.com rejected' }) as { stderr: string }
    expect(out.stderr).not.toContain('supersecretpw')
  })

  it('Authorization: Bearer в значении гасится', () => {
    const out = sanitize({ detail: 'req headers Authorization: Bearer sk-ant-abcdefghij0123456789klmno' }) as { detail: string }
    expect(out.detail).not.toContain('sk-ant-abcdefghij0123456789klmno')
  })

  it('секрет в message/stack ошибки редактируется', () => {
    const err = new Error('auth failed: api_key=sk-proj-abcdefghij1234567890')
    const out = sanitize(err) as { message: string }
    expect(out.message).not.toContain('sk-proj-abcdefghij1234567890')
  })

  it('редакция по имени ключа сохранена (быстрый первый слой)', () => {
    const out = sanitize({ token: 'anything', password: 'x' }) as Record<string, string>
    expect(out.token).toBe('[redacted]')
    expect(out.password).toBe('[redacted]')
  })

  it('чистые значения не трогаются', () => {
    const out = sanitize({ event: 'run_start', count: 5, ok: true }) as Record<string, unknown>
    expect(out).toEqual({ event: 'run_start', count: 5, ok: true })
  })
})
