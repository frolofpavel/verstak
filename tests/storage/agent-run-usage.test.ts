// Срез 2.0.8-F: persistence usage. Каветат #1 — идемпотентность (double-finalize / crash-resume
// не создаёт 2-ю строку) — RED-тест ПЕРВЫМ. Плюс pricing_known=0 ≠ $0, дефект B в стоимости,
// null-семантика, cache-hit только где знаменатель известен, диагностика без текста промпта.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Database as DB } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { persistRunUsage, computeRunCost, listRunUsage, usageSummary, usageHash, createRunUsage } from '../../electron/storage/agent-run-usage'
import { normalizedUsage } from '../../shared/contracts/usage'

describe('agent_run_usage persistence (2.0.8-F)', () => {
  let dir: string
  let db: DB
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-run-usage-'))
    db = openDb(join(dir, 'test.db'))
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  const usage = (over = {}) => normalizedUsage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, inputAccounting: 'exclusive', ...over })
  const input = (over = {}) => ({ runId: 'r1', providerId: 'claude', model: 'claude-sonnet-4-6', transport: 'API', accountId: null, usage: usage(), ...over })

  it('migration 50 создаёт agent_run_usage', () => {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_run_usage'").get()).toBeTruthy()
  })

  // КАВЕТАТ #1 (ПЕРВЫМ): double-finalize / crash-resume-переигровка → РОВНО одна строка.
  it('идемпотентность: повторный persist того же run_id → 1 строка (INSERT OR IGNORE)', () => {
    persistRunUsage(db, input(), 1000)
    persistRunUsage(db, input({ usage: usage({ inputTokens: 999999 }) }), 2000) // «переигровка» с другими цифрами
    const rows = listRunUsage(db, {})
    expect(rows).toHaveLength(1)
    expect(rows[0].inputTokens).toBe(100) // первая запись победила, вторая — no-op
    expect(rows[0].runId).toBe('r1')
  })

  // Каветат #2: неизвестная цена → pricing_known=0, cost=null (НЕ $0).
  it('неизвестная модель → pricing_known=0, cost_amount=null (не $0)', () => {
    const c = computeRunCost('openai', 'gpt-НЕИЗВЕСТНАЯ', usage({ inputAccounting: 'inclusive' }))
    expect(c.pricingKnown).toBe(0)
    expect(c.costAmount).toBeNull()
    persistRunUsage(db, input({ runId: 'r2', providerId: 'openai', model: 'gpt-НЕИЗВЕСТНАЯ', usage: usage({ inputAccounting: 'inclusive' }) }), 1000)
    expect(listRunUsage(db, {})[0].pricingKnown).toBe(0)
    expect(listRunUsage(db, {})[0].costAmount).toBeNull()
  })

  it('CLI/локальные — заведомо бесплатны: pricing_known=1, cost=0 (НЕ «неизвестно»)', () => {
    expect(computeRunCost('claude-cli', 'claude-code', usage())).toEqual({ costAmount: 0, currency: 'USD', pricingKnown: 1 })
    expect(computeRunCost('ollama', 'llama3.3', usage())).toMatchObject({ costAmount: 0, pricingKnown: 1 })
  })

  // Дефект B (денежный) в persistence-стоимости: Claude=exclusive → billable НЕ вычитает cached.
  it('дефект B: exclusive Claude — стоимость по полному input, не заниженная', () => {
    // input=100 (свежий), cache_read=900, output=50. billable=100 (НЕ max(0,100−900)=0).
    // sonnet: 100/1M×$3 + 900/1M×$0.3 + 50/1M×$15 = 0.0003 + 0.00027 + 0.00075 = 0.00132.
    const excl = computeRunCost('claude', 'claude-sonnet-4-6', usage())
    expect(excl.costAmount!).toBeCloseTo(0.00132, 6)
    // Если бы вычитали (как inclusive-баг): billable=0 → только cachedCost 0.00027 → строго меньше.
    const inclBug = computeRunCost('claude', 'claude-sonnet-4-6', usage({ inputAccounting: 'inclusive' }))
    expect(excl.costAmount!).toBeGreaterThan(inclBug.costAmount!)
  })

  it('null токены сохраняются как null, НЕ 0 (каветат null-семантики)', () => {
    persistRunUsage(db, input({ runId: 'r3', usage: normalizedUsage({ inputAccounting: 'unknown' }) }), 1000)
    const row = listRunUsage(db, {})[0]
    expect(row.inputTokens).toBeNull()
    expect(row.outputTokens).toBeNull()
    expect(row.cacheReadTokens).toBeNull()
  })

  it('cache diagnostic хранит ТОЛЬКО reason-код (без текста промпта)', () => {
    persistRunUsage(db, input({ runId: 'r4', cacheDiagnosticCode: 'system-prompt-changed' }), 1000)
    const row = listRunUsage(db, {})[0]
    expect(row.cacheDiagnosticCode).toBe('system-prompt-changed')
    // структурно: RunUsageInput не имеет поля с текстом промпта → утечь нечему.
  })

  it('usageSummary: cache-hit доля ТОЛЬКО где знаменатель известен, иначе null', () => {
    persistRunUsage(db, input({ runId: 'a', usage: usage({ inputTokens: 1000, cacheReadTokens: 300 }) }), 1000)  // знаменатель известен
    persistRunUsage(db, input({ runId: 'b', usage: normalizedUsage({ outputTokens: 50, inputAccounting: 'unknown' }) }), 1100) // input не сообщён
    const groups = usageSummary(db, 0)
    const g = groups.find(x => x.model === 'claude-sonnet-4-6')!
    expect(g.runs).toBe(2)
    // Claude = EXCLUSIVE: reported input (1000) НЕ включает кэш → весь промпт = 1000+300=1300.
    // Честная доля = 300/1300 ≈ 0.2308 (а НЕ 300/1000=0.3 — это был бы дефект B в знаменателе).
    expect(g.cacheHitShare).toBeCloseTo(300 / 1300, 4)
  })

  // ─── Дефект B в ЗНАМЕНАТЕЛЕ доли (ревью P0, 3 линзы независимо): доля считалась
  //     cacheRead / reported input без учёта inputAccounting. У Claude (exclusive) reported
  //     input не содержит кэш → «доля» штатно улетала за 100%.
  it('РЕГРЕССИЯ: exclusive с большим кэшем → доля ≤ 100% (было 8000%)', () => {
    // Реальная форма Claude: 500 свежих токенов + 40000 из кэша.
    persistRunUsage(db, input({ runId: 'big', usage: normalizedUsage({ inputTokens: 500, outputTokens: 100, cacheReadTokens: 40000, inputAccounting: 'exclusive' }) }), 1000)
    const g = usageSummary(db, 0)[0]
    expect(g.cacheHitShare).toBeLessThanOrEqual(1)          // доля не может быть > 100%
    expect(g.cacheHitShare).toBeCloseTo(40000 / 40500, 4)   // ≈ 98.8% — честно и осмысленно
  })

  // Ре-ревью P0: у Claude ТРИ непересекающиеся корзины промпта — input / cache_creation
  // (запись) / cache_read (чтение). Знаменатель обязан включать ВСЕ три, иначе прогон
  // прогрева кэша (write) выпадает из промпта и доля завышается кратно.
  it('exclusive: знаменатель включает и cache_WRITE (прогрев кэша — тоже часть промпта)', () => {
    // Прогон прогрева: 500 свежих + 40000 записано в кэш, из кэша не читали.
    persistRunUsage(db, input({ runId: 'warm', usage: normalizedUsage({ inputTokens: 500, outputTokens: 100, cacheWriteTokens: 40000, cacheReadTokens: 0, inputAccounting: 'exclusive' }) }), 1000)
    const g = usageSummary(db, 0)[0]
    // промпт = 500 + 0 + 40000 = 40500; из кэша прочитано 0 → доля 0, а НЕ 0/500.
    expect(g.cacheHitShare).toBe(0)
  })

  it('exclusive: прогрев + попадание → честная доля промпта, а не завышенная', () => {
    persistRunUsage(db, input({ runId: 'w', usage: normalizedUsage({ inputTokens: 500, outputTokens: 10, cacheWriteTokens: 40000, cacheReadTokens: 0, inputAccounting: 'exclusive' }) }), 1000)
    persistRunUsage(db, input({ runId: 'h', usage: normalizedUsage({ inputTokens: 200, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 40000, inputAccounting: 'exclusive' }) }), 2000)
    const g = usageSummary(db, 0)[0]
    // знаменатель = (500+0+40000) + (200+40000+0) = 80700; числитель = 40000 → ≈0.4957.
    expect(g.cacheHitShare).toBeCloseTo(40000 / 80700, 4)
    expect(g.cacheHitShare).toBeLessThan(0.6) // НЕ 0.98 (как было бы без cacheWrite в знаменателе)
  })

  it('inclusive (OpenAI/Gemini): cached ⊂ input → знаменатель = сам input', () => {
    persistRunUsage(db, input({ runId: 'inc', providerId: 'openai', model: 'gpt-5', usage: normalizedUsage({ inputTokens: 1000, outputTokens: 10, cacheReadTokens: 300, inputAccounting: 'inclusive' }) }), 1000)
    const g = usageSummary(db, 0)[0]
    expect(g.cacheHitShare).toBeCloseTo(0.3, 4) // 300/1000 — здесь 0.3 ВЕРНО
  })

  // Данные противоречат заявленной семантике: inclusive обещает cached ⊂ input, значит
  // cacheRead > input невозможно. Если провайдер такое прислал — наша модель про него неверна,
  // и честный ответ «нет данных», а не доля 333%.
  it('inclusive с противоречивыми данными (cacheRead > input) → null, а не >100%', () => {
    persistRunUsage(db, input({ runId: 'bad', providerId: 'openai', model: 'gpt-5', usage: normalizedUsage({ inputTokens: 300, outputTokens: 10, cacheReadTokens: 1000, inputAccounting: 'inclusive' }) }), 1000)
    const g = usageSummary(db, 0)[0]
    expect(g.cacheHitShare).toBeNull()
  })

  it('unknown-семантика в знаменатель НЕ берётся (доля неинтерпретируема) → null', () => {
    persistRunUsage(db, input({ runId: 'unk', usage: normalizedUsage({ inputTokens: 1000, outputTokens: 10, cacheReadTokens: 300, inputAccounting: 'unknown' }) }), 1000)
    const g = usageSummary(db, 0)[0]
    expect(g.cacheHitShare).toBeNull()
  })

  it('usageSummary: нет строк с известным input → cacheHitShare = null (не «0%»)', () => {
    persistRunUsage(db, input({ runId: 'c', usage: normalizedUsage({ outputTokens: 10, inputAccounting: 'unknown' }) }), 1000)
    const g = usageSummary(db, 0)[0]
    expect(g.cacheHitShare).toBeNull()
  })

  // ─── Cache-диагностика (минимальная честная версия): «что изменилось против прошлого
  //     прогона ЭТОГО чата». Не утверждение «поэтому промахнулись» — только факт изменения.
  describe('cache-diagnostic', () => {
    // agent_runs нужен: диагностика находит чат прогона через join.
    const seedRun = (runId: string, chatId: number | null) =>
      db.prepare(
        `INSERT INTO agent_runs (run_id, project_path, chat_id, owner, title, status, started_at)
         VALUES (?, '/p', ?, 'main', 't', 'done', 1)`
      ).run(runId, chatId)

    it('первый прогон чата → first-request (кэшу неоткуда взяться)', () => {
      seedRun('r1', 7)
      persistRunUsage(db, input({ runId: 'r1', systemPromptHash: 'aaa', toolsHash: 'ttt' }), 1000)
      expect(listRunUsage(db, {})[0].cacheDiagnosticCode).toBe('first-request')
    })

    it('system-prompt изменился против прошлого прогона чата → system-prompt-changed', () => {
      seedRun('r1', 7); seedRun('r2', 7)
      persistRunUsage(db, input({ runId: 'r1', systemPromptHash: 'aaa', toolsHash: 'ttt' }), 1000)
      persistRunUsage(db, input({ runId: 'r2', systemPromptHash: 'bbb', toolsHash: 'ttt' }), 2000)
      expect(listRunUsage(db, {}).find(r => r.runId === 'r2')!.cacheDiagnosticCode).toBe('system-prompt-changed')
    })

    it('набор инструментов дрейфанул (system тот же) → tools-drift', () => {
      seedRun('r1', 7); seedRun('r2', 7)
      persistRunUsage(db, input({ runId: 'r1', systemPromptHash: 'aaa', toolsHash: 'ttt' }), 1000)
      persistRunUsage(db, input({ runId: 'r2', systemPromptHash: 'aaa', toolsHash: 'zzz' }), 2000)
      expect(listRunUsage(db, {}).find(r => r.runId === 'r2')!.cacheDiagnosticCode).toBe('tools-drift')
    })

    it('условия те же → unknown (НЕ выдумываем причину промаха)', () => {
      seedRun('r1', 7); seedRun('r2', 7)
      persistRunUsage(db, input({ runId: 'r1', systemPromptHash: 'aaa', toolsHash: 'ttt' }), 1000)
      persistRunUsage(db, input({ runId: 'r2', systemPromptHash: 'aaa', toolsHash: 'ttt' }), 2000)
      expect(listRunUsage(db, {}).find(r => r.runId === 'r2')!.cacheDiagnosticCode).toBe('unknown')
    })

    it('ЧУЖОЙ чат не считается прошлым прогоном (изоляция по chat_id)', () => {
      seedRun('other', 99); seedRun('mine', 7)
      persistRunUsage(db, input({ runId: 'other', systemPromptHash: 'xxx' }), 1000)
      persistRunUsage(db, input({ runId: 'mine', systemPromptHash: 'aaa' }), 2000)
      // для чата 7 это ПЕРВЫЙ прогон, хоть в БД и есть более ранняя строка чужого чата
      expect(listRunUsage(db, {}).find(r => r.runId === 'mine')!.cacheDiagnosticCode).toBe('first-request')
    })

    // Ревью P0: после апдейта agent_runs полон истории, а agent_run_usage пуст (миграция 50
    // не бэкфиллит). Назвать такой прогон «первым в этом чате» — соврать пользователю.
    it('старый чат без истории usage (после апдейта) → unknown, а НЕ «первый прогон»', () => {
      seedRun('old1', 7)   // прогоны были ДО включения учёта расхода…
      seedRun('old2', 7)
      seedRun('now', 7)
      persistRunUsage(db, input({ runId: 'now', systemPromptHash: 'aaa' }), 5000) // …а строка usage — первая
      expect(listRunUsage(db, {})[0].cacheDiagnosticCode).toBe('unknown')
    })

    it('чат действительно новый (нет прошлых agent_runs) → first-request', () => {
      seedRun('one', 8)
      persistRunUsage(db, input({ runId: 'one', systemPromptHash: 'aaa' }), 1000)
      expect(listRunUsage(db, {})[0].cacheDiagnosticCode).toBe('first-request')
    })

    it('прогон вне чата (chat_id NULL) → unknown (сравнивать не с чем)', () => {
      seedRun('nochat', null)
      persistRunUsage(db, input({ runId: 'nochat', systemPromptHash: 'aaa' }), 1000)
      expect(listRunUsage(db, {})[0].cacheDiagnosticCode).toBe('unknown')
    })

    it('явно переданный код побеждает авто-диагностику', () => {
      seedRun('r1', 7)
      persistRunUsage(db, input({ runId: 'r1', cacheDiagnosticCode: 'ttl-expired', systemPromptHash: 'aaa' }), 1000)
      expect(listRunUsage(db, {})[0].cacheDiagnosticCode).toBe('ttl-expired')
    })

    // Каветат #3: в БД уходят ТОЛЬКО хеши — текста промпта нет ни в одной колонке.
    it('SECURITY: текст промпта не попадает в БД — только хеш', () => {
      seedRun('r1', 7)
      const secretPrompt = 'СЕКРЕТНЫЙ системный промпт с токеном sk-ant-abc123'
      persistRunUsage(db, input({ runId: 'r1', systemPromptHash: usageHash(secretPrompt) }), 1000)
      const raw = JSON.stringify(db.prepare('SELECT * FROM agent_run_usage').all())
      expect(raw).not.toContain('СЕКРЕТНЫЙ')
      expect(raw).not.toContain('sk-ant-abc123')
      expect(raw).toContain(usageHash(secretPrompt)) // хеш — да, текст — нет
    })

    it('usageHash: одинаковый текст → одинаковый хеш, разный → разный; текст не восстановим', () => {
      expect(usageHash('abc')).toBe(usageHash('abc'))
      expect(usageHash('abc')).not.toBe(usageHash('abd'))
      expect(usageHash('abc')).not.toContain('abc')
    })
  })

  // VSK-PROOF-A1: Proof Pack читает честность стоимости СТРОГО по своему runId —
  // точечный SQL WHERE run_id = ?, без list().find() по времени/chatId/provider.
  describe('RunUsage.get — точный lookup по runId (VSK-PROOF-A1)', () => {
    it('get(runId): строка есть → RunUsageRow; отсутствует → null', () => {
      const ru = createRunUsage(db)
      persistRunUsage(db, input({ runId: 'r-get' }), 1000)
      const row = ru.get('r-get')
      expect(row).not.toBeNull()
      expect(row!.runId).toBe('r-get')
      expect(row!.pricingKnown).toBe(1)
      expect(row!.costAmount).not.toBeNull()
      expect(ru.get('no-such-run')).toBeNull()
    })

    it('точный join: две строки разных runId не смешивают pricingKnown', () => {
      const ru = createRunUsage(db)
      // priced — claude-sonnet-4-6 (есть в PRICES), unpriced — модель вне таблицы цен.
      persistRunUsage(db, input({ runId: 'priced' }), 1000)
      persistRunUsage(db, input({ runId: 'unpriced', providerId: 'openai', model: 'gpt-НЕИЗВЕСТНАЯ', usage: usage({ inputAccounting: 'inclusive' }) }), 2000)
      expect(ru.get('priced')!.pricingKnown).toBe(1)
      expect(ru.get('priced')!.costAmount).not.toBeNull()
      expect(ru.get('unpriced')!.pricingKnown).toBe(0)
      expect(ru.get('unpriced')!.costAmount).toBeNull()
      // и обратная проверка: priced НЕ подхватил unknown от соседа
      expect(ru.get('priced')!.pricingKnown).not.toBe(ru.get('unpriced')!.pricingKnown)
    })
  })
})
