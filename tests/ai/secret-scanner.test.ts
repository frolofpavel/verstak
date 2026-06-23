import { describe, it, expect } from 'vitest'
import { isForbiddenPath, scanText, redactUrlSecrets } from '../../electron/ai/secret-scanner'

describe('redactUrlSecrets', () => {
  it('редактирует значения чувствительных параметров по имени', () => {
    expect(redactUrlSecrets('https://api.x.com/v1?token=abc123opaque')).toBe('https://api.x.com/v1?token=%5BREDACTED%5D')
    expect(redactUrlSecrets('https://x.com?api_key=u-u-i-d&q=public')).toContain('api_key=%5BREDACTED%5D')
    expect(redactUrlSecrets('https://x.com?api_key=u-u-i-d&q=public')).toContain('q=public')
    expect(redactUrlSecrets('https://x.com?secret=s&bearer=b&password=p')).toMatch(/secret=%5BREDACTED%5D.*bearer=%5BREDACTED%5D.*password=%5BREDACTED%5D/)
  })
  it('не трогает несекретные параметры (возвращает оригинал без изменений)', () => {
    expect(redactUrlSecrets('https://x.com?page=2&limit=50')).toBe('https://x.com?page=2&limit=50')
  })
  it('не-URL → без изменений', () => {
    expect(redactUrlSecrets('not a url')).toBe('not a url')
  })
})

describe('isForbiddenPath', () => {
  it('blocks .env and variants', () => {
    expect(isForbiddenPath('.env')).toBe(true)
    expect(isForbiddenPath('.env.local')).toBe(true)
    expect(isForbiddenPath('src/.env')).toBe(true)
    expect(isForbiddenPath('apps/web/.env.production')).toBe(true)
  })
  it('blocks .ssh directory contents', () => {
    expect(isForbiddenPath('.ssh/id_ed25519')).toBe(true)
    expect(isForbiddenPath('home/.ssh/config')).toBe(true)
  })
  it('blocks key files by extension', () => {
    expect(isForbiddenPath('certs/server.key')).toBe(true)
    expect(isForbiddenPath('build/cert.pem')).toBe(true)
    expect(isForbiddenPath('keystore.p12')).toBe(true)
  })
  it('blocks AWS and cloud credentials', () => {
    expect(isForbiddenPath('.aws/credentials')).toBe(true)
    expect(isForbiddenPath('.config/gcloud/application_default_credentials.json')).toBe(true)
  })
  it('blocks creds*.json / credentials*.json (B1)', () => {
    expect(isForbiddenPath('creds.json')).toBe(true)
    expect(isForbiddenPath('creds_google.json')).toBe(true)
    expect(isForbiddenPath('config/credentials_sa.json')).toBe(true)
  })
  it('allows ordinary code', () => {
    expect(isForbiddenPath('src/index.ts')).toBe(false)
    expect(isForbiddenPath('package.json')).toBe(false)
    expect(isForbiddenPath('README.md')).toBe(false)
    expect(isForbiddenPath('tsconfig.json')).toBe(false) // creds-паттерн не задевает обычные json
  })
})

describe('scanText', () => {
  it('redacts OpenAI keys', () => {
    const { redacted, hits } = scanText('api: sk-proj-abcdefghijklmnopqrstuvwx end')
    expect(redacted).not.toContain('sk-proj-abcdefghijklmnopqrstuvwx')
    expect(hits).toContain('openai-key')
  })
  it('redacts GitHub PATs', () => {
    const { redacted, hits } = scanText('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(redacted).toContain('[REDACTED:github-token]')
    expect(hits).toContain('github-token')
  })
  it('redacts AWS access keys', () => {
    const { redacted, hits } = scanText('AKIAIOSFODNN7EXAMPLE')
    expect(redacted).toContain('[REDACTED:aws-access-key]')
    expect(hits).toContain('aws-access-key')
  })
  it('redacts private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAA==\n-----END RSA PRIVATE KEY-----'
    const { redacted, hits } = scanText(pem)
    expect(redacted).toContain('[REDACTED:private-key-block]')
    expect(hits).toContain('private-key-block')
    expect(redacted).not.toContain('MIIEowIBAA==') // тело ключа не утекло
  })

  it('redacts a private key whose -----END----- is missing (truncated dump)', () => {
    // Частичная утечка: вывод обрезан до END — тело всё равно должно быть скрыто
    const partial = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA...\nAAAAB3Nza...'
    const { redacted, hits } = scanText(partial)
    expect(redacted).toContain('[REDACTED:private-key-block]')
    expect(hits).toContain('private-key-block')
    expect(redacted).not.toContain('b3BlbnNzaC1rZXktdjEAAAA') // тело ключа не утекло
    expect(redacted).not.toContain('AAAAB3Nza')
  })
  it('redacts basic-auth in URLs', () => {
    const { redacted, hits } = scanText('connect: https://admin:p4ss@1c.example.com/odata')
    expect(redacted).toContain('[REDACTED:basic-auth]')
    expect(hits).toContain('http-basic-auth')
  })
  it('passes ordinary code through', () => {
    const code = 'function add(a, b) { return a + b }'
    const { redacted, hits } = scanText(code)
    expect(redacted).toBe(code)
    expect(hits).toEqual([])
  })

  // Контракт run_command / verify:exec / MCP-вывода: оба потока команды
  // пропускаются через scanText.redacted перед отправкой в UI и модели.
  // Многострочный дамп с несколькими типами секретов — всё должно быть скрыто.
  it('redacts a realistic multi-line command stdout dump', () => {
    const stdout = [
      'Loading env...',
      'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'export AWS_KEY=AKIAIOSFODNN7EXAMPLE',
      'done.'
    ].join('\n')
    const { redacted, hits } = scanText(stdout)
    expect(redacted).toContain('[REDACTED:github-token]')
    expect(redacted).toContain('[REDACTED:aws-access-key]')
    expect(redacted).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(redacted).toContain('Loading env...') // обычный текст сохранён
    expect(hits).toContain('github-token')
    expect(hits).toContain('aws-access-key')
  })

  // Аудит M1: RU/TG/Yandex токены — ключи 22 новых RU-коннекторов.
  describe('RU / TG / Yandex токены (M1)', () => {
    it('redacts VK access token (vk1.a...)', () => {
      const { redacted, hits } = scanText('token=vk1.a.AbCdEf0123456789AbCdEf0123456789AbCdEf01 end')
      expect(redacted).not.toContain('vk1.a.AbCdEf0123456789')
      expect(hits).toContain('vk-token')
    })
    it('redacts Yandex OAuth (y0_...)', () => {
      const { redacted, hits } = scanText('OAuth y0_AgAAAABcDeFgHiJkLmNoPqRsTuVwXyZ012345')
      expect(redacted).not.toContain('y0_AgAAAABcDeFgHiJkLmNoPqRsTuVwXyZ012345')
      expect(hits).toContain('yandex-oauth')
    })
    it('redacts Telegram bot token (123:AA...)', () => {
      const { redacted, hits } = scanText('TG: 123456789:AAH4xYz_abcdefghijklmnopqrstuvwxyz0 ok')
      expect(redacted).not.toContain('123456789:AAH4xYz_abcdefghijklmnopqrstuvwxyz0')
      expect(hits).toContain('telegram-bot-token')
    })
    it('redacts DaData X-Secret / Контур api_key value, keeps the keyword', () => {
      const r1 = scanText('X-Secret: 0123456789abcdef0123456789abcdef01234567')
      expect(r1.redacted).toContain('[REDACTED:auth-value]')
      expect(r1.redacted).not.toContain('0123456789abcdef0123456789abcdef01234567')
      const r2 = scanText('api_key=550e8400-e29b-41d4-a716-446655440000')
      expect(r2.redacted).toContain('[REDACTED:auth-value]')
      expect(r2.redacted).not.toContain('550e8400-e29b-41d4-a716-446655440000')
    })
    it('does NOT redact bare UUIDs without auth keyword (no false positive)', () => {
      const code = 'entity id 550e8400-e29b-41d4-a716-446655440000 returned'
      const { redacted, hits } = scanText(code)
      expect(redacted).toBe(code)
      expect(hits).toEqual([])
    })
  })
})
