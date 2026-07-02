import { describe, it, expect } from 'vitest'
import { isBlockedHost, assertHostAllowed } from '../../electron/connectors/ip-guard'

// Security (ревью 23.06 #8): SSRF-guard коннекторов.
describe('isBlockedHost — SSRF-guard', () => {
  describe('всегда блокируется (no-legit, оба режима)', () => {
    const cases = [
      '169.254.169.254',      // AWS/GCP metadata
      '169.254.1.1',          // link-local
      '100.100.100.200',      // Alibaba metadata
      '0.0.0.0',
      '224.0.0.1',            // multicast
      '255.255.255.255',      // broadcast (reserved)
      'metadata.google.internal',
      '[fe80::1]',            // IPv6 link-local
      'ff02::1',              // IPv6 multicast
      '::',                   // unspecified
      '::ffff:169.254.169.254', // mapped metadata
    ]
    for (const h of cases) {
      it(`${h} — блок даже на базе (allowLocalAndPrivate)`, () => {
        expect(isBlockedHost(h, { allowLocalAndPrivate: true })).toBe(true)
        expect(isBlockedHost(h)).toBe(true)
      })
    }
  })

  describe('local/private: разрешены на БАЗЕ, блокируются для РЕДИРЕКТА', () => {
    const cases = ['127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.1.1', 'localhost', '::1', '::ffff:127.0.0.1', 'fc00::1']
    for (const h of cases) {
      it(`${h}`, () => {
        expect(isBlockedHost(h, { allowLocalAndPrivate: true })).toBe(false) // база — ок
        expect(isBlockedHost(h)).toBe(true)                                  // редирект — блок
      })
    }
  })

  describe('публичные хосты — пропускаются всегда', () => {
    for (const h of ['api.github.com', '8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
      it(`${h}`, () => {
        expect(isBlockedHost(h)).toBe(false)
        expect(isBlockedHost(h, { allowLocalAndPrivate: true })).toBe(false)
      })
    }
  })

  it('пустой хост → блок', () => {
    expect(isBlockedHost('')).toBe(true)
  })

  it('IPv6 scope-id не сбивает детект (security-review)', () => {
    expect(isBlockedHost('fe80::1%eth0')).toBe(true)       // link-local со scope
    expect(isBlockedHost('[fe80::1%25eth0]')).toBe(true)   // url-encoded scope в скобках
  })
})

// Ре-ревью MEDIUM: DNS-резолв доменного имени (anti-rebinding) для редирект-хопов.
describe('assertHostAllowed — DNS-резолв доменного имени', () => {
  it('имя, резолвящееся в metadata/private, блокируется на редирект-хопе', async () => {
    const toMeta = async () => [{ address: '169.254.169.254' }]
    const toPriv = async () => [{ address: '10.0.0.5' }]
    expect(await assertHostAllowed('evil.example', { lookupImpl: toMeta })).toBeTruthy()
    expect(await assertHostAllowed('rebind.example', { lookupImpl: toPriv })).toBeTruthy()
  })
  it('metadata блокируется даже на БАЗЕ (allowLocalAndPrivate), private — нет', async () => {
    const toMeta = async () => [{ address: '169.254.169.254' }]
    const toPriv = async () => [{ address: '10.0.0.5' }]
    expect(await assertHostAllowed('x.example', { allowLocalAndPrivate: true, lookupImpl: toMeta })).toBeTruthy()
    expect(await assertHostAllowed('internal.example', { allowLocalAndPrivate: true, lookupImpl: toPriv })).toBeNull()
  })
  it('публичный резолв проходит', async () => {
    const toPub = async () => [{ address: '93.184.216.34' }]
    expect(await assertHostAllowed('example.com', { lookupImpl: toPub })).toBeNull()
  })
  it('IP-литерал не резолвится (проверяется напрямую)', async () => {
    let called = false
    const spy = async () => { called = true; return [{ address: '1.2.3.4' }] }
    expect(await assertHostAllowed('169.254.169.254', { lookupImpl: spy })).toBeTruthy()
    expect(called).toBe(false)
  })
  it('DNS-фейл → блок (fail-safe)', async () => {
    const fail = async () => { throw new Error('ENOTFOUND') }
    expect(await assertHostAllowed('nx.example', { lookupImpl: fail })).toBeTruthy()
  })
})
