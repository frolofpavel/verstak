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
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
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
      expect(existsSync(join(ROOT, from)), `нет файла ${from} — сборка либо упадёт, либо соберётся без него`).toBe(true)
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
})
