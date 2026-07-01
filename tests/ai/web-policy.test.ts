import { describe, it, expect } from 'vitest'
import { isHostAllowed, checkUrlDomain, type WebPolicy } from '../../electron/ai/web-policy'

const empty: WebPolicy = { allow: [], deny: [] }

describe('web-policy — пустая политика = разрешено всё (обратная совместимость)', () => {
  it('любой хост проходит', () => {
    expect(isHostAllowed('example.com', empty).allowed).toBe(true)
    expect(isHostAllowed('docs.python.org', empty).allowed).toBe(true)
  })
})

describe('web-policy — allowlist-режим', () => {
  const policy: WebPolicy = { allow: ['python.org', '*.mozilla.org', 'github.com'], deny: [] }
  it('apex и субдомены домена из allow проходят', () => {
    expect(isHostAllowed('python.org', policy).allowed).toBe(true)      // apex
    expect(isHostAllowed('docs.python.org', policy).allowed).toBe(true) // субдомен
    expect(isHostAllowed('github.com', policy).allowed).toBe(true)
  })
  it('*.mozilla.org матчит субдомены, НЕ apex', () => {
    expect(isHostAllowed('developer.mozilla.org', policy).allowed).toBe(true)
    expect(isHostAllowed('mozilla.org', policy).allowed).toBe(false)    // apex не под *.
  })
  it('домен вне allow блокируется', () => {
    const r = isHostAllowed('evil.com', policy)
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('allow')
  })
  it('похожий-но-чужой домен не проходит (граница по точке)', () => {
    expect(isHostAllowed('notpython.org', policy).allowed).toBe(false)
    expect(isHostAllowed('python.org.evil.com', policy).allowed).toBe(false)
  })
  it('trailing-dot FQDN нормализуется (не обходит правила)', () => {
    // deny для evil.com не обходится через evil.com.
    const p: WebPolicy = { allow: [], deny: ['evil.com'] }
    expect(isHostAllowed('evil.com.', p).allowed).toBe(false)
    // и allow для python.org срабатывает для docs.python.org.
    expect(isHostAllowed('docs.python.org.', policy).allowed).toBe(true)
  })
})

describe('web-policy — deny сильнее allow', () => {
  const policy: WebPolicy = { allow: ['corp.example'], deny: ['secret.corp.example', '*.internal'] }
  it('deny блокирует даже если в allow', () => {
    expect(isHostAllowed('secret.corp.example', policy).allowed).toBe(false)
    expect(isHostAllowed('app.corp.example', policy).allowed).toBe(true) // в allow, не в deny
  })
  it('deny-only (allow пуст) блокирует только deny, остальное проходит', () => {
    const p: WebPolicy = { allow: [], deny: ['*.internal', 'metadata.google'] }
    expect(isHostAllowed('metadata.google', p).allowed).toBe(false)
    expect(isHostAllowed('foo.internal', p).allowed).toBe(false)
    expect(isHostAllowed('example.com', p).allowed).toBe(true)
  })
})

describe('web-policy — checkUrlDomain', () => {
  const policy: WebPolicy = { allow: ['python.org'], deny: [] }
  it('URL с разрешённым хостом проходит', () => {
    expect(checkUrlDomain('https://docs.python.org/3/library', policy).allowed).toBe(true)
  })
  it('URL с запрещённым хостом блокируется', () => {
    expect(checkUrlDomain('https://evil.com/x', policy).allowed).toBe(false)
  })
  it('невалидный URL блокируется', () => {
    expect(checkUrlDomain('не url', policy).allowed).toBe(false)
  })
})
