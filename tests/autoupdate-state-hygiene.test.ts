import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync, readdirSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Гигиена состояния автообновления (внеплановый P0-срез про доставку релизов).
 *
 * Повод: на машине Павла нашли осиротевший `state.json.<pid>.<ts>.tmp` от 11.07 и `lock`
 * от прерванной попытки. Разбор по коду показал ДВЕ РАЗНЫЕ вещи, и путать их нельзя:
 *  · lock — НЕ баг: TTL 20 мин + проверка живости pid уже есть. Здесь это закреплено
 *    характеризацией, чтобы «оптимизация» не выкинула защиту;
 *  · осиротевший tmp — реален (rename не случился, чистить было некому), но безвреден;
 *    копится годами. Минимальная уборка по возрасту.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vst-state-'))
  process.env.LOCALAPPDATA = dir
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const root = () => join(dir, 'Verstak', 'AutoUpdate')

describe('гигиена state автообновления', () => {
  it('осиротевший tmp старше часа подметается при следующей записи', async () => {
    const { writeState } = await import('../electron/autoupdate/state')
    mkdirSync(root(), { recursive: true })
    const orphan = join(root(), 'state.json.22692.1752000000000.tmp')
    writeFileSync(orphan, '{"брошено":true}')
    // Состариваем на 2 часа — как tmp от 11.07 у Павла.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(orphan, old, old)

    writeState({ schemaVersion: 1, status: 'idle', updatedAt: Date.now() })

    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(join(root(), 'state.json'))).toBe(true) // состояние записалось
  })

  it('СВЕЖИЙ чужой tmp не трогаем (могла идти параллельная запись)', async () => {
    const { writeState } = await import('../electron/autoupdate/state')
    mkdirSync(root(), { recursive: true })
    const fresh = join(root(), 'state.json.99999.1752099999999.tmp')
    writeFileSync(fresh, '{"идёт":"прямо сейчас"}')

    writeState({ schemaVersion: 1, status: 'idle', updatedAt: Date.now() })

    expect(existsSync(fresh)).toBe(true) // не наше дело — руки прочь
  })

  it('уборка не роняет запись состояния (best-effort)', async () => {
    const { writeState, readState } = await import('../electron/autoupdate/state')
    mkdirSync(root(), { recursive: true })
    writeFileSync(join(root(), 'state.json.1.1.tmp'), 'мусор')
    const s = writeState({ schemaVersion: 1, status: 'downloading', updatedAt: Date.now(), version: '2.0.8' } as never)
    expect(s.status).toBe('downloading')
    expect(readState()?.version).toBe('2.0.8')
  })

  it('не трогаем чужие файлы рядом (только <state.json>.*.tmp)', async () => {
    const { writeState } = await import('../electron/autoupdate/state')
    mkdirSync(root(), { recursive: true })
    const foreign = join(root(), 'lock')
    const alsoForeign = join(root(), 'other.json.1.1.tmp')
    writeFileSync(foreign, '{}')
    writeFileSync(alsoForeign, '{}')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(alsoForeign, old, old)

    writeState({ schemaVersion: 1, status: 'idle', updatedAt: Date.now() })

    expect(existsSync(foreign)).toBe(true)
    expect(existsSync(alsoForeign)).toBe(true) // префикс другой — не наш мусор
  })
})

describe('lock: стейл-обработка (характеризация — защита УЖЕ есть, не потерять)', () => {
  it('лок мёртвого процесса перехватывается (иначе автообновление залипло бы навсегда)', async () => {
    const { acquireLock } = await import('../electron/autoupdate/state')
    mkdirSync(root(), { recursive: true })
    // pid, которого заведомо нет; startedAt свежий → спасает именно проверка живости.
    writeFileSync(join(root(), 'lock'), JSON.stringify({ pid: 999_999, operation: 'download', startedAt: Date.now() }))
    const release = acquireLock('download', '2.0.8')
    expect(typeof release).toBe('function')
    release()
  })

  it('ЗАВИСШИЙ владелец (лок не обновлялся дольше TTL) → лок перехватывается', async () => {
    const { acquireLock } = await import('../electron/autoupdate/state')
    mkdirSync(root(), { recursive: true })
    // Владелец жив как процесс, но операцию не двигает: heartbeat молчит дольше TTL.
    // Тогда отобрать лок — правильно, иначе автообновление залипло бы навсегда.
    writeFileSync(join(root(), 'lock'), JSON.stringify({
      pid: process.pid, operation: 'download', startedAt: Date.now() - 24 * 60 * 60 * 1000,
    }))
    const release = acquireLock('download', '2.0.8')
    expect(typeof release).toBe('function')
    release()
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // РЕВЬЮ P0 нашло, что фикс докачки мог сделать ХУЖЕ исходного бага:
  // 360 МБ качаются дольше TTL(20 мин), а startedAt не обновлялся → лок отбирался у ЖИВОЙ
  // РАБОТАЮЩЕЙ загрузки → стартовала вторая в тот же `.part` → оба append → каша → хеш не
  // сходится → `.part` удаляется. Механизм, созданный СОХРАНЯТЬ прогресс, стирал бы его.
  // ─────────────────────────────────────────────────────────────────────────────
  it('ЖИВАЯ загрузка (heartbeat идёт) НЕ теряет лок даже дольше TTL', async () => {
    const { acquireLock, touchLock } = await import('../electron/autoupdate/state')
    const release = acquireLock('download+extract', '2.0.8')
    // Симулируем: загрузка идёт 25 минут, отчитываясь о прогрессе.
    writeFileSync(join(root(), 'lock'), JSON.stringify({
      ...JSON.parse(readFileSync(join(root(), 'lock'), 'utf8')),
      startedAt: Date.now() - 25 * 60 * 1000,
    }))
    touchLock() // ← байты идут, владелец жив и работает
    expect(() => acquireLock('check')).toThrow(/busy/i) // чужой check НЕ смеет отобрать
    release()
  })

  it('release НЕ удаляет чужой лок (иначе check снёс бы лок работающей загрузки)', async () => {
    const { acquireLock } = await import('../electron/autoupdate/state')
    const releaseA = acquireLock('download+extract', '2.0.8')
    // Кто-то перехватил лок (например протухший по TTL) и теперь владелец — он.
    writeFileSync(join(root(), 'lock'), JSON.stringify({ pid: 999_999, operation: 'check', startedAt: Date.now(), token: 'чужой' }))
    releaseA() // наш release не должен трогать лок, которым уже владеет другой
    expect(existsSync(join(root(), 'lock'))).toBe(true)
  })

  it('живой свежий лок ЧУЖОЙ операции по-прежнему блокирует (иначе две загрузки разом)', async () => {
    const { acquireLock } = await import('../electron/autoupdate/state')
    const release = acquireLock('download', '2.0.8')
    expect(() => acquireLock('extract', '2.0.8')).toThrow(/busy/i)
    release()
    expect(readdirSync(root()).includes('lock')).toBe(false) // release убрал за собой
  })
})
