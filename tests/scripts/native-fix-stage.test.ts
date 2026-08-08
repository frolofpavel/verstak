import { describe, expect, it } from 'vitest'
import { createRequire } from 'module'
import { join } from 'path'

const require = createRequire(import.meta.url)
const { stageNativeFix } = require('../../scripts/patch-exe-icon.cjs')

// Класс: native-fix — резервная копия того же упакованного better_sqlite3.node. Если он
// под Node ABI, в бэкап ушёл бы БИТЫЙ модуль, а самопочинка «чинила» бы им рабочую копию.
// Гард обязан проверять ABI ИСТОЧНИКА и валить сборку до посева битого бэкапа.
describe('stageNativeFix — гард годности источника native-fix', () => {
  it('валит сборку и НЕ копирует, когда источник под Node ABI', () => {
    const copied: Array<[string, string]> = []
    expect(() =>
      stageNativeFix('/out', {
        src: 's',
        destDir: 'd',
        exists: () => true,
        classify: () => 'node',
        mkdir: () => {},
        copy: (a: string, b: string) => copied.push([a, b]),
      }),
    ).toThrow(/Electron/)
    expect(copied).toEqual([]) // битый бэкап не посеян
  })

  it('валит сборку при неопределённом ABI источника (fail-closed)', () => {
    const copied: Array<[string, string]> = []
    expect(() =>
      stageNativeFix('/out', {
        src: 's',
        destDir: 'd',
        exists: () => true,
        classify: () => 'unknown',
        mkdir: () => {},
        copy: (a: string, b: string) => copied.push([a, b]),
      }),
    ).toThrow()
    expect(copied).toEqual([])
  })

  it('копирует, когда источник под Electron ABI', () => {
    const copied: Array<[string, string]> = []
    stageNativeFix('/out', {
      src: 's',
      destDir: 'd',
      exists: () => true,
      classify: () => 'electron',
      mkdir: () => {},
      copy: (a: string, b: string) => copied.push([a, b]),
    })
    expect(copied).toEqual([['s', join('d', 'better_sqlite3.node')]])
  })

  it('пропускает без ошибки и без вызова classify, когда источника нет (прежнее поведение)', () => {
    const copied: Array<[string, string]> = []
    stageNativeFix('/out', {
      src: 's',
      destDir: 'd',
      exists: () => false,
      classify: () => {
        throw new Error('classify не должен вызываться при отсутствии источника')
      },
      mkdir: () => {},
      copy: (a: string, b: string) => copied.push([a, b]),
    })
    expect(copied).toEqual([])
  })
})
