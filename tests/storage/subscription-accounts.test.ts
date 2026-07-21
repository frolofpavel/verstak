import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Database as DB } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import {
  createSubscriptionAccount,
  listSubscriptionAccounts,
  getSubscriptionAccount,
  getActiveAccount,
  setActiveAccount,
  renameSubscriptionAccount,
  deleteSubscriptionAccount,
  touchSubscriptionAccount,
  switchActiveOnLimit,
  markAccountCooling,
} from '../../electron/storage/subscription-accounts'
import { createChatSessions } from '../../electron/storage/chat-sessions'

describe('subscription accounts storage', () => {
  let dir: string
  let db: DB

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-subacct-'))
    db = openDb(join(dir, 'test.db'))
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('migration 44 creates subscription_accounts table', () => {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='subscription_accounts'").get()
    expect(t).toBeTruthy()
  })

  it('creates an account; first account for a provider becomes active automatically', () => {
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'Личный Max', credRef: 'subacct:claude:1' })
    expect(a.id).toBeGreaterThan(0)
    expect(a.providerId).toBe('claude-cli')
    expect(a.label).toBe('Личный Max')
    expect(a.active).toBe(true) // первый для провайдера — активен
    expect(a.lastUsedAt).toBeNull()
  })

  it('second account for same provider does NOT auto-activate; only one active per provider', () => {
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'A', credRef: 'r1' })
    const b = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'B', credRef: 'r2' })
    expect(a.active).toBe(true)
    expect(b.active).toBe(false)
    // accounts for a DIFFERENT provider have their own active
    const g = createSubscriptionAccount(db, { providerId: 'gemini-cli', label: 'G', credRef: 'r3' })
    expect(g.active).toBe(true)
  })

  it('setActiveAccount switches exclusively within a provider, not across providers', () => {
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'A', credRef: 'r1' })
    const b = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'B', credRef: 'r2' })
    const g = createSubscriptionAccount(db, { providerId: 'gemini-cli', label: 'G', credRef: 'r3' })

    setActiveAccount(db, 'claude-cli', b.id)
    expect(getActiveAccount(db, 'claude-cli')?.id).toBe(b.id)
    expect(getSubscriptionAccount(db, a.id)?.active).toBe(false)
    // gemini's active is untouched
    expect(getActiveAccount(db, 'gemini-cli')?.id).toBe(g.id)
  })

  it('lists by provider, ordered newest first', () => {
    createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'A', credRef: 'r1' })
    createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'B', credRef: 'r2' })
    createSubscriptionAccount(db, { providerId: 'gemini-cli', label: 'G', credRef: 'r3' })
    const claude = listSubscriptionAccounts(db, 'claude-cli')
    expect(claude.map(a => a.label)).toEqual(['B', 'A'])
    expect(listSubscriptionAccounts(db).length).toBe(3)
  })

  it('rename and touch update fields', () => {
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'Old', credRef: 'r1' })
    renameSubscriptionAccount(db, a.id, 'New')
    expect(getSubscriptionAccount(db, a.id)?.label).toBe('New')
    touchSubscriptionAccount(db, a.id, 12345)
    expect(getSubscriptionAccount(db, a.id)?.lastUsedAt).toBe(12345)
  })

  it('config-dir account (Codex) persists configDir and has no secret', () => {
    const a = createSubscriptionAccount(db, { providerId: 'codex-cli', label: 'Рабочий', credRef: '', configDir: '/data/cli-accounts/codex-abc' })
    const got = getSubscriptionAccount(db, a.id)!
    expect(got.configDir).toBe('/data/cli-accounts/codex-abc')
    expect(got.credRef).toBe('')
    expect(got.active).toBe(true) // первый для codex-cli — активен
    // отдельный пул от claude-cli
    const c = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'C', credRef: 'r1' })
    expect(c.active).toBe(true)
    expect(getActiveAccount(db, 'codex-cli')?.id).toBe(a.id)
  })

  it('switchActiveOnLimit: active hits limit → cooled, next ready account activated (1.9.4)', () => {
    const now = 5_000_000_000_000
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'A', credRef: 'r1' }) // active
    const b = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'B', credRef: 'r2' })
    const coolUntil = now + 5 * 60 * 60_000

    const res = switchActiveOnLimit(db, 'claude-cli', coolUntil, now)
    expect(res.switched).toBe(true)
    expect(res.newAccountId).toBe(b.id)
    // A остывает
    const aAfter = getSubscriptionAccount(db, a.id)!
    expect(aAfter.state).toBe('cooling')
    expect(aAfter.coolingUntil).toBe(coolUntil)
    expect(aAfter.active).toBe(false)
    // B активен и готов
    const bAfter = getSubscriptionAccount(db, b.id)!
    expect(bAfter.active).toBe(true)
    expect(bAfter.state).toBe('ready')
  })

  it('switchActiveOnLimit: no other ready account → switched false (пул исчерпан)', () => {
    const now = 6_000_000_000_000
    createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'Only', credRef: 'r1' })
    const res = switchActiveOnLimit(db, 'claude-cli', now + 60_000, now)
    expect(res.switched).toBe(false)
  })

  it('switchActiveOnLimit: cooled-but-expired account is eligible again', () => {
    const now = 7_000_000_000_000
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'A', credRef: 'r1' })
    const b = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'B', credRef: 'r2' })
    // A остывает до now-1 (уже истёк) — переключение на A должно быть возможно
    switchActiveOnLimit(db, 'claude-cli', now - 1, now) // A→cooling(истёк), B active
    expect(getActiveAccount(db, 'claude-cli')?.id).toBe(b.id)
    // теперь B бьёт лимит → кандидат A (cooling истёк) снова годен
    const res = switchActiveOnLimit(db, 'claude-cli', now + 60_000, now)
    expect(res.switched).toBe(true)
    expect(res.newAccountId).toBe(a.id)
    expect(getSubscriptionAccount(db, a.id)?.state).toBe('ready')
  })

  it('switchActiveOnLimit: cooling с НЕИЗВЕСТНЫМ сроком (until=NULL) НЕ кандидат ротации (EF S3)', () => {
    const now = 8_000_000_000_000
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'A', credRef: 'r1' }) // active
    const b = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'B', credRef: 'r2' })
    // B остывает с неизвестным сроком — честно недоступен, ротация на него = ложный ready
    markAccountCooling(db, b.id, null, { scope: 'account', reason: 'quota' })
    const res = switchActiveOnLimit(db, 'claude-cli', now + 60_000, now)
    expect(res.switched).toBe(false)
    expect(getSubscriptionAccount(db, a.id)?.state).toBe('cooling')
    expect(getSubscriptionAccount(db, b.id)?.active).toBe(false)
  })

  it('EF-R1 Б3: switchActiveOnLimit с fromAccountId охлаждает АККАУНТ ПРОГОНА, не global active', () => {
    const now = 9_000_000_000_000
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'A', credRef: 'r1' })
    const b = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'B', credRef: 'r2' })
    const c = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'C', credRef: 'r3' })
    // Прогон стартовал на A, пользователь вручную переключил global active на B,
    // затем прогон на A поймал quota → охлаждать A, B не трогаем.
    setActiveAccount(db, 'claude-cli', b.id)
    const res = switchActiveOnLimit(db, 'claude-cli', now + 60_000, now, { scope: 'account', reason: 'quota' }, a.id)
    expect(res.switched).toBe(true)
    expect(res.fromLabel).toBe('A')
    const aAfter = getSubscriptionAccount(db, a.id)!
    expect(aAfter.state).toBe('cooling')
    expect(aAfter.coolingUntil).toBe(now + 60_000)
    // B не охлаждён — он не падал.
    expect(getSubscriptionAccount(db, b.id)!.state).toBe('ready')
    // Ротация ушла на готового кандидата (C), не на охлаждённый A.
    expect(res.newAccountId).toBe(c.id)
    expect(getActiveAccount(db, 'claude-cli')!.id).toBe(c.id)
  })

  it('EF-R1 Б3: fromAccountId чужого провайдера → fallback на active (защита от мусора)', () => {
    const now = 9_500_000_000_000
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'A', credRef: 'r1' })
    const g = createSubscriptionAccount(db, { providerId: 'gemini-cli', label: 'G', credRef: 'r2' })
    const res = switchActiveOnLimit(db, 'claude-cli', now + 60_000, now, undefined, g.id)
    // g не из claude-cli → охлаждён активный A (прежняя семантика).
    expect(getSubscriptionAccount(db, a.id)!.state).toBe('cooling')
    expect(getSubscriptionAccount(db, g.id)!.state).toBe('ready')
    expect(res.switched).toBe(false) // других аккаунтов claude-cli нет
  })

  it('delete removes account; if the active one is deleted, another becomes active', () => {
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'A', credRef: 'r1' })
    const b = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'B', credRef: 'r2' })
    expect(getActiveAccount(db, 'claude-cli')?.id).toBe(a.id)
    deleteSubscriptionAccount(db, a.id)
    expect(getSubscriptionAccount(db, a.id)).toBeNull()
    // оставшийся аккаунт становится активным (не осиротить провайдера без активного)
    expect(getActiveAccount(db, 'claude-cli')?.id).toBe(b.id)
  })

  it('2.0.8-B scoped cooldown: markAccountCooling пишет scope/reason/model', () => {
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'A', credRef: 'r1' })
    markAccountCooling(db, a.id, 2_000_000_000_000, { scope: 'model', reason: 'quota', model: 'claude-sonnet-4-6' })
    const got = getSubscriptionAccount(db, a.id)!
    expect(got.state).toBe('cooling')
    expect(got.cooldownScope).toBe('model')
    expect(got.cooldownReason).toBe('quota')
    expect(got.cooldownModel).toBe('claude-sonnet-4-6')
  })

  it('2.0.8-B binding: setSubscriptionBinding pinned + fork НАСЛЕДУЕТ (карточка шаг 6/7)', () => {
    const sessions = createChatSessions(db)
    const acc = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'A', credRef: 'r1' })
    const chat = sessions.create('/p', { providerId: 'claude-cli', model: 'claude-sonnet-4-6' })
    sessions.setSubscriptionBinding(chat.id, 'pinned', acc.id)
    expect(sessions.getSubscriptionBinding(chat.id)).toEqual({ accountId: acc.id, mode: 'pinned' })
    // fork наследует binding
    const branch = sessions.fork(chat.id)!
    expect(sessions.getSubscriptionBinding(branch.id)).toEqual({ accountId: acc.id, mode: 'pinned' })
  })

  it('2.0.8-B binding: pinned без accountId нормализуется в auto (не висячий pin)', () => {
    const sessions = createChatSessions(db)
    const chat = sessions.create('/p', { providerId: 'claude-cli' })
    sessions.setSubscriptionBinding(chat.id, 'pinned', null)
    expect(sessions.getSubscriptionBinding(chat.id)).toEqual({ accountId: null, mode: 'auto' })
  })

  it('2.0.8-B binding: удаление аккаунта → pinned-binding STALE, БЕЗ тихой ротации (шаг 6)', () => {
    const sessions = createChatSessions(db)
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'A', credRef: 'r1' })
    createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'B', credRef: 'r2' })
    const chat = sessions.create('/p', { providerId: 'claude-cli' })
    sessions.setSubscriptionBinding(chat.id, 'pinned', a.id)
    deleteSubscriptionAccount(db, a.id)
    // binding НЕ ротирован молча — accountId всё ещё указывает на (удалённый) a.id
    expect(sessions.getSubscriptionBinding(chat.id)).toEqual({ accountId: a.id, mode: 'pinned' })
    // но сам аккаунт исчез → резолвер (2.0.8-D) детектит unavailable + требует решения юзера
    expect(getSubscriptionAccount(db, a.id)).toBeNull()
  })

  // EF-R1 Б1: canonical codex-семейства в switch-on-limit — прогон openai-codex-oauth
  // обязан охладить/ротировать пул 'codex-cli' (аккаунты хранятся под canonical id).
  it('EF-R1 Б1: switchActiveOnLimit канонизирует openai-codex-oauth → пул codex-cli', () => {
    const a = createSubscriptionAccount(db, { providerId: 'codex-cli', label: 'Codex A', credRef: 'r1' })
    const b = createSubscriptionAccount(db, { providerId: 'codex-cli', label: 'Codex B', credRef: 'r2' })
    // Лимит поймал прогон oauth-провайдера на аккаунте A (run.account_id = a.id).
    const res = switchActiveOnLimit(db, 'openai-codex-oauth', 2_000_000_000_000, Date.now(), undefined, a.id)
    expect(res.switched).toBe(true)
    expect(res.newAccountId).toBe(b.id)
    // Охлаждён именно A (аккаунт прогона), активным стал B — в canonical-пуле codex-cli.
    expect(getSubscriptionAccount(db, a.id)?.state).toBe('cooling')
    expect(getActiveAccount(db, 'codex-cli')?.id).toBe(b.id)
  })

  it('EF-R1 Б1: canonical без fromAccountId — active ищется в codex-cli пуле, а не по raw id', () => {
    const a = createSubscriptionAccount(db, { providerId: 'codex-cli', label: 'Codex A', credRef: 'r1' })
    createSubscriptionAccount(db, { providerId: 'codex-cli', label: 'Codex B', credRef: 'r2' })
    // legacy-вызов без fromAccountId: active должен найтись по canonical 'codex-cli'.
    const res = switchActiveOnLimit(db, 'openai-codex-oauth', null)
    expect(res.switched).toBe(true)
    expect(getSubscriptionAccount(db, a.id)?.state).toBe('cooling') // until=null = срок неизвестен, но cooling честный
    expect(res.fromLabel).toBe('Codex A')
  })
})
