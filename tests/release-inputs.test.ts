// Входы сборки установщика должны существовать НА ДИСКЕ и быть объявлены явно.
//
// Реальный случай (2026-07-26): `7zip-bin` никогда не был в package.json — он приезжал
// транзитивно от electron-builder. Диапазон `^26.8.1` пустил апгрейд до 26.15.3, где
// эту зависимость убрали, и `7za.exe` тихо исчез. Последствия шире сломанной сборки:
// `extraResources` кладёт этот файл в `resources/`, а автообновление в рантайме им
// распаковывает payload (`autoupdate/service.ts` бросает «Не найден 7za.exe»). То есть
// собранный релиз уехал бы к людям и сломал бы им обновление.
//
// Тест дешёвый и ловит весь класс: файл, на который ссылается сборка, обязан быть.
//
// 07.08: тест резолвил входы от `process.cwd()` и падал в ЛЮБОМ linked worktree —
// а worktree с 04.08 штатная практика параллельных линий. В worktree node_modules
// разрежён, зависимости живут в node_modules ОСНОВНОГО чекаута. Тест краснел у каждого,
// кто работает правильно, и разбирался заново. Теперь node_modules-входы ищутся ВВЕРХ по
// дереву до корня основного чекаута включительно (граница — родитель git-common-dir);
// трекаемые входы (resources/…, scripts/…) есть в любом чекауте, их ищем строго в своём
// корне. Подъём ОГРАНИЧЕН границей: вход, лежащий только в постороннем предке ВНЕ
// репозитория (соседний проект в C:\…\Проекты\*), обязан считаться отсутствующим —
// иначе проверка позеленела бы по чужому файлу и перестала стеречь то, ради чего есть.
import { describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = process.cwd()

/** Корень ОСНОВНОГО чекаута — верхняя граница подъёма. В linked worktree
 *  `git rev-parse --git-common-dir` указывает в `.git` основного репозитория, его
 *  родитель — искомый корень. В обычном чекауте граница совпадает с самим root. */
function repoBoundary(root: string): string {
  try {
    const commonDir = execSync('git rev-parse --git-common-dir', { cwd: root, encoding: 'utf8' }).trim()
    return dirname(resolve(root, commonDir))
  } catch {
    return root
  }
}

/**
 * Существует ли вход сборки на диске. node_modules-входы ищем ВВЕРХ по дереву от
 * `root` до `boundary` включительно (в linked worktree зависимости живут в
 * node_modules основного чекаута, а не в разрежённом node_modules самого worktree).
 * Трекаемые входы (не под `node_modules/`) есть в любом чекауте — их ищем строго в
 * своём `root`. Подъём НЕ выходит за `boundary`: вход, найденный только в постороннем
 * предке вне репозитория, считается отсутствующим. Пуре-функция ради контрольных
 * кейсов ниже (`exists` инъектируется), в проде вызывается с `existsSync`.
 */
function resolveBuildInput(
  from: string,
  root: string,
  boundary: string,
  exists: (p: string) => boolean = existsSync,
): boolean {
  if (!from.startsWith('node_modules/')) return exists(join(root, from))
  let dir = root
  for (;;) {
    if (exists(join(dir, from))) return true
    if (dir === boundary) return false            // достигли корня основного чекаута — выше не смотрим
    const parent = dirname(dir)
    if (parent === dir) return false              // fs-корень (git недоступен → boundary===root, сюда не дойдём)
    dir = parent
  }
}

const BOUNDARY = repoBoundary(ROOT)
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  build?: { extraResources?: Array<{ from: string; to: string }> }
}

describe('входы сборки установщика', () => {
  const extra = pkg.build?.extraResources ?? []

  it('extraResources вообще объявлены', () => {
    expect(extra.length).toBeGreaterThan(0)
  })

  it.each(extra.map(e => [e.from, e.to] as const))(
    'файл %s существует (уедет в resources/%s)',
    from => {
      expect(
        resolveBuildInput(from, ROOT, BOUNDARY),
        `нет файла ${from} — сборка либо упадёт, либо соберётся без него`,
      ).toBe(true)
    },
  )

  it('7za.exe объявлен явно, а не приезжает транзитивно', () => {
    const declared = pkg.devDependencies?.['7zip-bin'] ?? pkg.dependencies?.['7zip-bin']
    expect(declared, 'вернуть в package.json: транзитивная поставка уже ломалась').toBeTruthy()
  })

  it('путь к 7za.exe одинаков в package.json и в scripts/build-setup.cjs', () => {
    // Два места знают этот путь. Разъедутся — сборка соберётся, а установщик выйдет
    // без распаковщика, и это заметит только пользователь при обновлении.
    const script = readFileSync(join(ROOT, 'scripts', 'build-setup.cjs'), 'utf8')
    const inScript = /['"]7zip-bin['"],\s*['"]win['"],\s*['"]x64['"],\s*['"]7za\.exe['"]/.test(script)
    expect(inScript, 'build-setup.cjs больше не ищет 7za.exe по ожидаемому пути').toBe(true)
    const inPkg = extra.some(e => e.from.includes('7zip-bin') && e.from.endsWith('7za.exe'))
    expect(inPkg, 'package.json больше не кладёт 7za.exe в resources').toBe(true)
  })

  // Контроль walk-up (иначе оба гейта ниже ничего не измеряют): node_modules-вход,
  // существующий ТОЛЬКО в границе (корне основного чекаута), найден подъёмом из
  // вложенного worktree. Мутация «не подниматься» → красный.
  it('walk-up: node_modules-вход в границе найден подъёмом из worktree', () => {
    const wt = join(ROOT, 'sub', 'worktree')
    const from = 'node_modules/pkg/file.bin'
    const exists = (p: string) => p === join(ROOT, from) // есть только в границе (ROOT)
    expect(resolveBuildInput(from, wt, ROOT, exists)).toBe(true)
  })

  // КОНТРОЛЬ 1 (условие приёмки штаба): входа нет НИГДЕ → красный. Без него it.each
  // выше стал бы «всегда зелёным», если resolveBuildInput сломать в постоянный true.
  it('контроль: отсутствующий вход → false', () => {
    expect(resolveBuildInput('node_modules/__missing__/x.bin', ROOT, BOUNDARY, () => false)).toBe(false)
  })

  // КОНТРОЛЬ 2 (условие приёмки штаба): вход есть ТОЛЬКО в постороннем предке ВЫШЕ
  // границы → false. Стережёт само ограничение подъёма: без него walk-up ушёл бы за
  // пределы репозитория и позеленел по чужому node_modules соседнего проекта.
  it('контроль: вход только в постороннем предке вне репозитория → false', () => {
    const foreign = dirname(ROOT)                // на уровень выше границы — вне репозитория
    const from = 'node_modules/pkg/file.bin'
    const exists = (p: string) => p === join(foreign, from) // есть только выше границы
    expect(resolveBuildInput(from, ROOT, ROOT, exists)).toBe(false)
  })
})
