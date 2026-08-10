import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { buildContextPack, MAP_BUDGET_MS, withBudget } from '../../electron/ai/context-pack'
import { getProjectMap, getDependencyMap, invalidateProjectMap, invalidateDependencyMap } from '../../electron/ai/project-map'

/**
 * Д1 (приёмка 10.08) — «подвисло всё». Разбор runtime.jsonl за 17:34–18:00
 * показал, что зависание случалось ДО старта прогона: между `ai.memory.snapshot`
 * и `ai.send.start` проходило 7–15 минут, вызовов инструментов в это время не
 * шло вовсе (то есть это НЕ следствие Д7), а три отправки стартовали ОДНОЙ
 * секундой — их разблокировало одно событие.
 *
 * Причина: проект тех прогонов — C:\Users\Pavel\Downloads, 44 949 файлов.
 * Сборка контекста строит карту проекта и граф зависимостей ПОЛНЫМ рекурсивным
 * обходом; параллельные отправки делали это независимо (три обхода 45k файлов
 * разом), а отправка ждала обход целиком, сколько бы он ни занял.
 *
 * Две правки, обе проверяются здесь: параллельные сборки делят одну работу, и у
 * ожидания карты есть бюджет — просроченная карта не задерживает отправку.
 */

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ctx-budget-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  for (let i = 0; i < 12; i++) writeFileSync(join(dir, 'src', `m${i}.ts`), `export const v${i} = ${i}\n`, 'utf8')
})
afterEach(() => {
  invalidateProjectMap(dir)
  invalidateDependencyMap(dir)
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* уборка не критична */ }
})

describe('withBudget — ожидание с бюджетом', () => {
  it('успевшая работа отдаёт свой результат', async () => {
    expect(await withBudget(Promise.resolve('карта'), 500, null)).toBe('карта')
  })

  it('не успевшая за бюджет отдаёт запасное значение, а не держит вызывающего', async () => {
    const slow = new Promise<string>(resolve => setTimeout(() => resolve('поздно'), 400))
    const started = Date.now()

    const result = await withBudget(slow, 20, null)

    expect(result).toBeNull()
    expect(Date.now() - started, 'вызывающий ждал всю медленную работу').toBeLessThan(300)
  })

  it('упавшая работа отдаёт запасное значение, а не бросает', async () => {
    expect(await withBudget(Promise.reject(new Error('нет доступа')), 500, 'запас')).toBe('запас')
  })
})

describe('Д1: параллельные сборки карты делят одну работу', () => {
  it('три одновременных запроса карты проекта дают ОДИН результат, а не три обхода', async () => {
    // Ровно случай приёмки: три отправки в разные чаты, один проект. До фикса
    // каждая запускала собственный полный обход — на 45k файлах это минуты
    // тишины и одновременный старт всех трёх, когда обходы наконец закончились.
    const [a, b, c] = await Promise.all([getProjectMap(dir), getProjectMap(dir), getProjectMap(dir)])

    expect(a, 'параллельные сборки вернули разные объекты — обход шёл трижды').toBe(b)
    expect(b).toBe(c)
  })

  it('то же для графа зависимостей', async () => {
    const [a, b] = await Promise.all([getDependencyMap(dir), getDependencyMap(dir)])
    expect(a).toBe(b)
  })

  it('КОНТРОЛЬ: после завершения сборки следующий запрос работает как раньше', async () => {
    // Дедупликация не должна превратиться в вечный кэш: запись о «сборка идёт»
    // обязана сниматься, иначе refresh перестал бы что-либо обновлять.
    const first = await getProjectMap(dir)
    writeFileSync(join(dir, 'src', 'added.ts'), 'export const added = 1\n', 'utf8')
    const refreshed = await getProjectMap(dir, true)

    expect(refreshed).not.toBe(first)
    expect(refreshed.files.some(f => f.path.endsWith('added.ts'))).toBe(true)
  })
})

describe('Д1: сборка контекста не ждёт карту дольше бюджета', () => {
  it('бюджет задан константой, а не спрятан в условии', () => {
    expect(MAP_BUDGET_MS).toBeGreaterThan(0)
  })

  it('карта успела → она в пакете, пометки о просрочке нет', async () => {
    const pack = await buildContextPack({ projectPath: dir })

    expect(pack).toContain('project_map')
    expect(pack).not.toContain('не успела построиться')
  })

  it('карта не успела → пакет собран БЕЗ неё и говорит об этом ЯВНО', async () => {
    // След обязателен: молча выпавшая карта неотличима от проекта без карты, и
    // модель просто «почему-то» перестаёт видеть структуру (§3.1 — у запасного
    // пути должна быть видимая пометка, что он сработал и почему).
    const pack = await buildContextPack({ projectPath: dir, mapBudgetMs: 0 })

    expect(pack).toContain('не успела построиться')
    expect(pack, 'модели не сказали, чем пользоваться вместо карты').toContain('find_files')
    expect(pack).not.toContain('project_map (compact)')
  })
})
