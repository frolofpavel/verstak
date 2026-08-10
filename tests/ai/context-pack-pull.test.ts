// V2 ось A (волна 2.6.0): тяжёлый контекст переведён из push в pull.
//
// ДЕФЕКТ, ИЗМЕРЕННЫЙ ДО ПРАВКИ. Сборка контекста ЖДАЛА карту проекта и граф
// зависимостей (withBudget, 8 с). Замер на каталоге в 44 964 файла:
// «Привет» — 8461 мс, и по истечении бюджета пакет всё равно собирался БЕЗ
// карты. Человек платил 8.5 секунды за пустоту. На обычном проекте (verstak) —
// 3669 мс.
//
// ЧТО ЗАКРЕПЛЕНО. (1) Сборка контекста не ждёт карту: медленная сборка не
// задерживает пакет. (2) Готовая карта из кэша по-прежнему попадает в пакет —
// pull не значит «карты больше нет». (3) Отсутствие карты оставляет след,
// называющий ЗАМЕНУ (get_project_map). (4) Повторная отправка после истечения
// TTL отдаёт карту немедленно и не пересобирает её синхронно.
//
// Это НЕ классификатор «простой запрос» (§3.1 — код видит меньше модели):
// решение не зависит от текста запроса вовсе, только от готовности кэша.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { buildContextPack } from '../../electron/ai/context-pack'
import {
  getProjectMap, getDependencyMap, getProjectMapIfReady, getDependencyMapIfReady,
  invalidateProjectMap, invalidateDependencyMap,
} from '../../electron/ai/project-map'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ctx-pull-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  for (let i = 0; i < 12; i++) writeFileSync(join(dir, 'src', `m${i}.ts`), `export const v${i} = ${i}\n`, 'utf8')
})
afterEach(() => {
  invalidateProjectMap(dir)
  invalidateDependencyMap(dir)
  vi.restoreAllMocks()
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* уборка не критична */ }
})

describe('V2 ось A: сборка контекста не ждёт карту проекта', () => {
  it('холодный кэш → пакет собирается БЕЗ ожидания и зовёт взять карту инструментом', async () => {
    const started = Date.now()
    const pack = await buildContextPack({ projectPath: dir, latestUserMessage: 'Привет' })

    expect(pack).toContain('get_project_map')
    expect(pack).not.toContain('project_map (compact)')
    // Порог с запасом: реальная цена pull-пути — единицы миллисекунд; прежний
    // push-путь на большом дереве стоил 8461 мс.
    expect(Date.now() - started, 'сборка контекста всё ещё ждёт карту').toBeLessThan(1500)
  })

  it('КОНТРОЛЬ: карта прогрета → она В ПАКЕТЕ (pull не значит «карты больше нет»)', async () => {
    await getProjectMap(dir)
    await getDependencyMap(dir)

    const pack = await buildContextPack({ projectPath: dir })

    expect(pack, 'готовая карта не попала в пакет — потеряли то, ради чего всё делалось').toContain('project_map (compact)')
    expect(pack).not.toContain('карта проекта в этом запросе не приложена')
  })

  // ГРАНИЦА ЭТОГО ТЕСТА, названная прямо. Юнит-тест не может держать каталог на
  // 45 000 файлов, а подменить внутренний вызов getProjectMap спаем нельзя: внутри
  // ESM-модуля вызов идёт напрямую, мимо экспорта. Поэтому «медленное дерево не
  // задерживает пакет» доказывается ЗАМЕРОМ (scripts/bench/preflight-bench.mjs,
  // цифры до/после в отчёте), а здесь закрепляется наблюдаемое свойство, из
  // которого это следует: пакет собран без карты И фоновая сборка реально идёт.
  it('после холодной сборки карта прогревается В ФОНЕ (иначе pull её никогда не даст)', async () => {
    const pack = await buildContextPack({ projectPath: dir })
    expect(pack).toContain('карта проекта в этом запросе не приложена')

    // Дожидаемся фоновой сборки — но ЖДЁТ ТЕСТ, а не пользовательская отправка.
    await getProjectMap(dir)

    expect(getProjectMapIfReady(dir), 'фоновая сборка не запускалась — карта не появится никогда').not.toBeNull()
    const second = await buildContextPack({ projectPath: dir })
    expect(second, 'вторая отправка так и не увидела прогретую карту').toContain('project_map (compact)')
  })
})

describe('V2 ось A: повторная отправка не пересобирает карту', () => {
  it('просроченный по TTL кэш отдаётся НЕМЕДЛЕННО, обновление уходит в фон', async () => {
    await getProjectMap(dir)
    // Проматываем TTL (30 с): при прежнем поведении следующая отправка ждала
    // полный обход заново — ровно «повторная отправка пересобирает карту».
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000)

    const map = getProjectMapIfReady(dir)

    expect(map, 'просроченный кэш выкинули и заставили ждать пересборку').not.toBeNull()
    expect(map!.files.length).toBeGreaterThan(0)
  })

  it('готовый граф отдаётся из кэша, отсутствующий — не ждётся', async () => {
    expect(getDependencyMapIfReady(dir), 'холодный граф отдали как готовый').toBeNull()
    await getDependencyMap(dir)
    expect(getDependencyMapIfReady(dir)).not.toBeNull()
  })
})
