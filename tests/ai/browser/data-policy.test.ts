// data-policy.test.ts — ClientDataPolicy / provider browser-context gating (план §6).
//
// Главные свойства (BR-014):
//   • forbidden provider не получает DOM/screenshot при fallback
//   • sensitive data classification → всегда 'ask'
//   • providerAllow='deny' → всегда deny
//   • allowlist + redactScreenshotsByDefault → DOM ok, screenshot нет

import { describe, it, expect } from 'vitest'
import {
  decideProviderBrowserContext,
  grantProviderAccess,
  revokeProviderAccess,
  DEFAULT_DATA_POLICY,
} from '../../../electron/ai/browser/data-policy'
import type { ClientDataPolicy } from '../../../electron/ai/browser/types'

describe('decideProviderBrowserContext — default policy', () => {
  it('default policy → ask (явное решение Павла требуется)', () => {
    const r = decideProviderBrowserContext(DEFAULT_DATA_POLICY, 'kimi')
    expect(r.kind).toBe('ask')
  })
})

describe('decideProviderBrowserContext — denylist', () => {
  it('provider в deniedProviders → deny', () => {
    const p: ClientDataPolicy = {
      ...DEFAULT_DATA_POLICY,
      providerAllow: 'allow',
      deniedProviders: ['claude'],
    }
    const r = decideProviderBrowserContext(p, 'claude')
    expect(r.kind).toBe('deny')
    if (r.kind === 'deny') {
      expect(r.reason).toContain('denylist')
    }
  })
})

describe('decideProviderBrowserContext — sensitive data', () => {
  it('sensitive classification → всегда ask, даже при allow', () => {
    const p: ClientDataPolicy = {
      ...DEFAULT_DATA_POLICY,
      providerAllow: 'allow',
      allowedProviders: ['kimi'],
      dataClassification: 'sensitive',
    }
    const r = decideProviderBrowserContext(p, 'kimi')
    expect(r.kind).toBe('ask')
  })
})

describe('decideProviderBrowserContext — providerAllow=allow', () => {
  it('providerAllow=allow, empty allowedProviders, redact=true → redact-screenshot-only', () => {
    const p: ClientDataPolicy = {
      ...DEFAULT_DATA_POLICY,
      providerAllow: 'allow',
      allowedProviders: [],
      redactScreenshotsByDefault: true,
    }
    const r = decideProviderBrowserContext(p, 'kimi')
    expect(r.kind).toBe('redact-screenshot-only')
  })
  it('providerAllow=allow, provider в allowedProviders, redact=false → allow', () => {
    const p: ClientDataPolicy = {
      ...DEFAULT_DATA_POLICY,
      providerAllow: 'allow',
      allowedProviders: ['kimi'],
      redactScreenshotsByDefault: false,
    }
    const r = decideProviderBrowserContext(p, 'kimi')
    expect(r.kind).toBe('allow')
  })
  it('providerAllow=allow, provider НЕ в allowedProviders → deny', () => {
    const p: ClientDataPolicy = {
      ...DEFAULT_DATA_POLICY,
      providerAllow: 'allow',
      allowedProviders: ['kimi'],
    }
    const r = decideProviderBrowserContext(p, 'claude')
    expect(r.kind).toBe('deny')
  })
})

describe('decideProviderBrowserContext — providerAllow=deny', () => {
  it('всегда deny', () => {
    const p: ClientDataPolicy = { ...DEFAULT_DATA_POLICY, providerAllow: 'deny' }
    const r = decideProviderBrowserContext(p, 'kimi')
    expect(r.kind).toBe('deny')
  })
})

describe('decideProviderBrowserContext — edge cases', () => {
  it('пустой providerId → deny', () => {
    const r = decideProviderBrowserContext(DEFAULT_DATA_POLICY, '')
    expect(r.kind).toBe('deny')
  })
})

describe('grantProviderAccess — после явного решения Павла', () => {
  it('добавляет провайдера в allowlist и ставит providerAllow=allow', () => {
    const updated = grantProviderAccess(DEFAULT_DATA_POLICY, 'glm')
    expect(updated.providerAllow).toBe('allow')
    expect(updated.allowedProviders).toContain('glm')
  })
})

describe('revokeProviderAccess — при security-событии', () => {
  it('добавляет в denylist и убирает из allowlist', () => {
    const p: ClientDataPolicy = {
      ...DEFAULT_DATA_POLICY,
      providerAllow: 'allow',
      allowedProviders: ['kimi', 'glm'],
    }
    const updated = revokeProviderAccess(p, 'glm')
    expect(updated.deniedProviders).toContain('glm')
    expect(updated.allowedProviders).not.toContain('glm')
    expect(updated.allowedProviders).toContain('kimi')
  })
})

describe('RED: forbidden provider не получает DOM/screenshot при fallback (§6, BR-014)', () => {
  it('если провайдер forbidden → controller не передаст ему observation', () => {
    // Симуляция: task с policy где 'glm' в denylist. Handoff на 'glm' из-за 429.
    const p: ClientDataPolicy = {
      ...DEFAULT_DATA_POLICY,
      deniedProviders: ['glm'],
    }
    const r = decideProviderBrowserContext(p, 'glm')
    expect(r.kind).toBe('deny')
    // controller, увидев deny, не передаст observation.text/screenshot новому
    // провайдеру — run блокируется или выбирается другой route (план §6).
  })
})
