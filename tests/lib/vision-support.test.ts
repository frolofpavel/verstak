import { describe, it, expect } from 'vitest'
import {
  providerSupportsVision,
  providerFamily,
  buildVisionAlternatives,
  isImageAttachment,
} from '../../src/lib/vision-support'
import type { VisionProviderLite } from '../../src/lib/vision-support'

const PROVIDERS: VisionProviderLite[] = [
  { id: 'grok-cli', name: 'Grok Build', shortLabel: 'Grok Build', models: ['auto'], defaultModel: 'auto', transport: 'CLI' },
  { id: 'grok', name: 'Grok', shortLabel: 'Grok', models: ['grok-4', 'grok-4-fast'], defaultModel: 'grok-4', transport: 'API' },
  { id: 'claude-cli', name: 'Claude Code', models: ['auto'], defaultModel: 'auto', transport: 'CLI' },
  { id: 'claude', name: 'Claude', models: ['claude-sonnet-4-6'], defaultModel: 'claude-sonnet-4-6', transport: 'API' },
]

describe('vision-support', () => {
  it('CLI не поддерживает vision', () => {
    expect(providerSupportsVision('grok-cli')).toBe(false)
    expect(providerSupportsVision('grok')).toBe(true)
  })

  it('providerFamily группирует CLI и API', () => {
    expect(providerFamily('grok-cli')).toBe('grok')
    expect(providerFamily('grok')).toBe('grok')
    expect(providerFamily('codex-cli')).toBe('openai')
  })

  it('isImageAttachment', () => {
    expect(isImageAttachment('image/png')).toBe(true)
    expect(isImageAttachment('text/plain')).toBe(false)
  })

  it('buildVisionAlternatives для grok-cli → модели Grok API', () => {
    const alts = buildVisionAlternatives(
      'grok-cli',
      PROVIDERS,
      new Set(['grok::grok-4']),
      new Set(['grok-cli', 'grok']),
    )
    expect(alts).toHaveLength(1)
    expect(alts[0].providerId).toBe('grok')
    expect(alts[0].model).toBe('grok-4')
    expect(alts[0].authorized).toBe(true)
  })

  it('неподключённый API-сиблинг — одна строка без авторизации', () => {
    const alts = buildVisionAlternatives(
      'grok-cli',
      PROVIDERS,
      new Set(),
      new Set(['grok-cli']),
    )
    expect(alts).toHaveLength(1)
    expect(alts[0].providerId).toBe('grok')
    expect(alts[0].authorized).toBe(false)
  })

  it('vision-провайдер — пустой список альтернатив', () => {
    const alts = buildVisionAlternatives('grok', PROVIDERS, new Set(), new Set(['grok']))
    expect(alts).toHaveLength(0)
  })
})