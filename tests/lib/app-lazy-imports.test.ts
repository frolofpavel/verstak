// Lazy-импорты App.tsx: страж, что деление на чанки настоящее.
//
// Позиция 4 плана 2026-07-27 просила разобрать 26 lazy-импортов по одному:
// «часть сборщик всё равно включает статически, и это маскирует реальную границу
// чанков». Замер на сборке от 27.07 премису НЕ подтвердил: у всех 26 компонентов
// есть собственный чанк, и ни один не подтянут статически. Убирать нечего.
//
// Но вывод протухнет молча: достаточно кому-то добавить обычный `import` нужного
// компонента в любой файл, попадающий в index-чанк, — и lazy превратится в
// украшение. Сборка при этом не падает, размер index растёт незаметно. Этот тест
// и есть страж на тот случай: он читает ИСХОДНИКИ (сборка не нужна) и краснеет,
// как только у lazy-компонента появляется статический потребитель.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, sep, relative } from 'node:path'

const ROOT = process.cwd()

/** Компоненты, которые App.tsx грузит лениво. */
function lazyComponents(): string[] {
  const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8')
  const found = [...app.matchAll(/lazy\(\(\) => import\('\.\/components\/(\w+)'\)/g)].map(m => m[1])
  // Страж обязан падать громко, если разметка объявлений изменилась и он ничего
  // не нашёл: «зелено, потому что список пуст» — худший исход для анти-дрейфа.
  if (found.length === 0) throw new Error('в App.tsx не найдено ни одного lazy(() => import(...)) — изменилась форма объявления, страж ослеп')
  return found
}

function allSourceFiles(): string[] {
  const out: string[] = []
  ;(function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
    }
  })(join(ROOT, 'src'))
  return out
}

describe('lazy-импорты App.tsx', () => {
  const lazy = lazyComponents()
  const files = allSourceFiles()

  it('их по-прежнему много — список не схлопнулся незаметно', () => {
    expect(lazy.length).toBeGreaterThanOrEqual(20)
    expect(new Set(lazy).size).toBe(lazy.length)
  })

  it('каждый lazy-компонент существует на диске', () => {
    for (const mod of lazy) {
      const found = ['tsx', 'ts'].some(ext => existsSync(join(ROOT, 'src/components', `${mod}.${ext}`)))
      expect(found, `нет файла компонента ${mod}`).toBe(true)
    }
  })

  // ГЛАВНЫЙ пин позиции 4. Статический импорт рядом с lazy = чанк схлопнулся.
  //
  // Один проход по дереву, а не по проходу на каждый компонент: наивная вложенность
  // (26 × ~500 файлов = 13 тыс. чтений) занимала 33 с и под полной нагрузкой не
  // укладывалась в таймаут vitest — страж падал не по делу. Теперь каждый файл
  // читается ровно один раз, и все value-импорты из него разбираются сразу.
  it('ни один lazy-компонент не импортируется статически', () => {
    const lazySet = new Set(lazy)
    // Захватываем имя модуля из любого value-импорта (не `import type`).
    const importRe = /^import\s+(?!type\s)[^\n]*from '[^']*\/([\w.-]+)'/gm
    const offenders: string[] = []

    for (const f of files) {
      const rel = relative(ROOT, f).replace(/\\/g, '/')
      const self = `${sep}components${sep}`
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(importRe)) {
        const mod = m[1]
        if (!lazySet.has(mod)) continue
        // Сам себя импортировать не может; файл самого компонента пропускаем.
        if (f.endsWith(`${self}${mod}.tsx`) || f.endsWith(`${self}${mod}.ts`)) continue
        offenders.push(`${mod} ← ${rel}`)
      }
    }
    expect(offenders, `lazy обесценен статическим импортом:\n${offenders.join('\n')}`).toEqual([])
  })
})
