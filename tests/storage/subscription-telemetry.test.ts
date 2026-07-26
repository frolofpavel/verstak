// 2.1.14: телеметрия пула подписок на РЕАЛЬНОЙ базе.
//
// Смысл проверок — не «счётчик увеличился», а «счётчик соответствует тому, что
// действительно произошло с аккаунтом». Поэтому события подаются теми же функциями,
// которыми их вызывает рантайм (резолвер → touch, finish('done') → success, лимит →
// switchActiveOnLimit), а не прямыми UPDATE.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import {
  createSubscriptionAccount,
  getSubscriptionAccount,
  touchSubscriptionAccount,
  markAccountSuccess,
  markAccountCooling,
  switchActiveOnLimit,
  getActiveAccount,
} from '../../electron/storage/subscription-accounts'
import { toSubscriptionAccountDTO } from '../../shared/contracts/subscription'
import { formatAccountTelemetry } from '../../src/lib/subscription-telemetry'

let dir: string
let db: ReturnType<typeof openDb>

const add = (label: string) =>
  createSubscriptionAccount(db, { providerId: 'claude-cli', label, credRef: `subacct:${label}` })
const stats = (id: number) => getSubscriptionAccount(db, id)!.stats

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vst-subtel-'))
  db = openDb(join(dir, 'test.db'))
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

describe('счётчики отражают реальные события', () => {
  it('новый аккаунт начинает с нулей и с отметкой начала учёта', () => {
    const a = add('A')
    const s = stats(a.id)
    expect(s.attempts).toBe(0)
    expect(s.successes).toBe(0)
    expect(s.since, 'без since ноль читался бы как «никогда не использовался»').toBeGreaterThan(0)
  })

  it('попытка растёт вместе с lastUsedAt — расхождению взяться неоткуда', () => {
    const a = add('A')
    touchSubscriptionAccount(db, a.id, 1000)
    touchSubscriptionAccount(db, a.id, 2000)
    const acct = getSubscriptionAccount(db, a.id)!
    expect(acct.stats.attempts).toBe(2)
    expect(acct.lastUsedAt).toBe(2000)
  })

  it('успех растёт вместе с lastSuccessAt', () => {
    const a = add('A')
    markAccountSuccess(db, a.id, 5000)
    const acct = getSubscriptionAccount(db, a.id)!
    expect(acct.stats.successes).toBe(1)
    expect(acct.lastSuccessAt, 'счётчик и отметка времени пишутся одним UPDATE').toBe(5000)
  })

  it('успехов не может стать больше без реального вызова — попытка успех не рисует', () => {
    const a = add('A')
    touchSubscriptionAccount(db, a.id)
    touchSubscriptionAccount(db, a.id)
    expect(stats(a.id)).toMatchObject({ attempts: 2, successes: 0 })
  })
})

describe('лимиты и отказы разложены по причинам', () => {
  it('квота, рейт-лимит и отказ входа считаются раздельно и все — в общий счётчик', () => {
    const a = add('A')
    markAccountCooling(db, a.id, 1_000, { scope: 'account', reason: 'quota' }, 111)
    markAccountCooling(db, a.id, 2_000, { scope: 'account', reason: 'rate-limit' }, 222)
    markAccountCooling(db, a.id, null, { scope: 'account', reason: 'auth' }, 333)
    const s = stats(a.id)
    expect(s).toMatchObject({ cooldowns: 3, quotaHits: 1, rateLimitHits: 1, authFailures: 1 })
    expect(s.lastErrorAt).toBe(333)
    expect(s.lastErrorReason).toBe('auth')
  })

  it('причина «прочее» не теряется: общий счётчик больше суммы именованных', () => {
    const a = add('A')
    markAccountCooling(db, a.id, 1_000, { scope: 'provider', reason: 'provider-unavailable' })
    markAccountCooling(db, a.id, 1_000, { scope: 'account' })  // причина не указана
    const s = stats(a.id)
    expect(s.cooldowns).toBe(2)
    expect(s.quotaHits + s.rateLimitHits + s.authFailures).toBe(0)
    expect(s.cooldowns - (s.quotaHits + s.rateLimitHits + s.authFailures), 'прочие причины выводимы').toBe(2)
  })
})

describe('ротация считается на обоих концах', () => {
  it('увод с A на B: A получает уход и остывание, B — приход', () => {
    const a = add('A')
    const b = add('B')
    // A активен первым (пул создаётся по одному, активным становится первый).
    expect(getActiveAccount(db, 'claude-cli')?.id).toBe(a.id)

    const res = switchActiveOnLimit(db, 'claude-cli', 9_999, 1_000, { scope: 'account', reason: 'quota' })
    expect(res.switched).toBe(true)
    expect(res.newAccountId).toBe(b.id)

    expect(stats(a.id)).toMatchObject({ rotationsOut: 1, rotationsIn: 0, cooldowns: 1, quotaHits: 1 })
    expect(stats(b.id)).toMatchObject({ rotationsIn: 1, rotationsOut: 0, cooldowns: 0 })
  })

  it('пул исчерпан — ротации не было, значит и счётчик не растёт', () => {
    const a = add('A')
    const res = switchActiveOnLimit(db, 'claude-cli', 9_999, 1_000, { scope: 'account', reason: 'quota' })
    expect(res.switched).toBe(false)
    const s = stats(a.id)
    // Охлаждение произошло — оно засчитано. Ротации не было — не засчитана.
    expect(s.cooldowns).toBe(1)
    expect(s.rotationsOut).toBe(0)
  })

  it('счётчики переживают перезапуск — они durable, а не в памяти процесса', () => {
    const a = add('A')
    touchSubscriptionAccount(db, a.id)
    markAccountSuccess(db, a.id)
    const path = join(dir, 'test.db')
    db.close()
    db = openDb(path)
    expect(stats(a.id)).toMatchObject({ attempts: 1, successes: 1 })
  })
})

describe('миграция существующей базы', () => {
  it('аккаунт, заведённый до телеметрии, получает since — а не молчаливые нули', () => {
    // Эмулируем «старую» строку: колонки телеметрии сбрасываем как после ALTER TABLE.
    const a = add('A')
    db.prepare('UPDATE subscription_accounts SET stats_since = NULL, attempts_total = 0 WHERE id = ?').run(a.id)
    expect(stats(a.id).since).toBeNull()
    // Именно на этом различии Doctor и UI говорят «учёт не вёлся» вместо «0 попыток».
    db.prepare('UPDATE subscription_accounts SET stats_since = ? WHERE id = ?').run(777, a.id)
    expect(stats(a.id).since).toBe(777)
  })
})

/**
 * Сквозная проверка честности: событие → storage → DTO → строка в интерфейсе.
 * Здесь ловится класс «в базе одно, на экране другое» — самый неприятный вид вранья,
 * потому что он выглядит как рабочая функция.
 */
describe('storage → DTO → интерфейс: цифры не расходятся', () => {
  it('то, что реально произошло, доезжает до renderer без потерь', () => {
    const a = add('A')
    const b = add('B')
    // Сценарий: 3 попытки, 2 ответа, потом лимит с уводом на B.
    touchSubscriptionAccount(db, a.id)
    markAccountSuccess(db, a.id)
    touchSubscriptionAccount(db, a.id)
    markAccountSuccess(db, a.id)
    touchSubscriptionAccount(db, a.id)
    switchActiveOnLimit(db, 'claude-cli', 9_999, 1_000, { scope: 'account', reason: 'quota' })

    const dto = toSubscriptionAccountDTO(getSubscriptionAccount(db, a.id)!, { hasCredential: true, now: 1_000 })
    expect(dto.stats).toMatchObject({
      attempts: 3, successes: 2, cooldowns: 1, quotaHits: 1, rotationsOut: 1,
    })

    const view = formatAccountTelemetry(dto.stats)
    expect(view.line).toContain('3 попыток')
    expect(view.line).toContain('2 ответов')
    expect(view.line).toContain('67%')     // 2 из 3, а не выдуманные 100
    expect(view.line).toContain('1 лимитов')
    expect(view.line).toContain('1 уводов')
    expect(view.alarming).toBe(false)

    const dtoB = toSubscriptionAccountDTO(getSubscriptionAccount(db, b.id)!, { hasCredential: true, now: 1_000 })
    expect(dtoB.stats.rotationsIn).toBe(1)
  })

  it('DTO не протаскивает секреты вместе со счётчиками', () => {
    const a = add('A')
    touchSubscriptionAccount(db, a.id)
    const dto = toSubscriptionAccountDTO(getSubscriptionAccount(db, a.id)!, { hasCredential: true, now: 1 })
    const raw = JSON.stringify(dto)
    expect(raw).not.toContain('subacct:')
    expect(raw).not.toContain('credRef')
    expect(raw).not.toContain('configDir')
  })

  it('аккаунт без учёта: DTO несёт since=null, и интерфейс не рисует нули', () => {
    const a = add('A')
    db.prepare('UPDATE subscription_accounts SET stats_since = NULL WHERE id = ?').run(a.id)
    const dto = toSubscriptionAccountDTO(getSubscriptionAccount(db, a.id)!, { hasCredential: true, now: 1 })
    expect(dto.stats.since).toBeNull()
    expect(formatAccountTelemetry(dto.stats).line).toMatch(/не велась/i)
  })
})
