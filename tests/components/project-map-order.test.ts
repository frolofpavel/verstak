// @vitest-environment jsdom
//
// ДЕФЕКТ (живая проверка 22.08 на клиентском проекте alfa-development): верх «Карты»
// занимал граф зависимостей — узлы с обрезанными именами и спутанные линии, — а
// структура папок уходила под него. У проекта 351 файл, из них 71 с кодом, у
// большинства разделов честное «0 строк»: это креативы, отчёты и логи. Граф там
// технически верен и практически бесполезен, но вытеснял полезное вниз.
//
// РЕШЕНИЕ: структура первой (осмысленна для любого проекта), граф вторым и свёрнутым
// (осмыслен только для кода, а продукт не знает заранее, какой перед ним). Вопрос
// человеку не выносится: итог виден строкой, разворот — одним кликом.
//
// ГЛАВНЫЙ ПИН: порядок разделов и свёрнутость графа по умолчанию.
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react'

// Фикстура повторяет ПРОДОВУЮ форму: ProjectMapDTO/DependencyMapDTO из types/api.d.ts,
// вызовы — window.api.projectMap.get/deps (первая редакция звала несуществующий
// window.api.files.projectMap и потому не проверяла ничего; поймано красным).
const MAP = {
  root: 'C:/p',
  generatedAt: 0,
  stats: { totalFiles: 351, codeFiles: 71, totalLines: 15851, truncated: false },
  files: [
    { path: 'creatives/banner.psd', lines: 0, symbols: [] },
    { path: 'scripts/a.mjs', lines: 40, symbols: [] },
    { path: 'scripts/b.mjs', lines: 25, symbols: [] }
  ]
}
// Связи есть: b импортирует a. Значит граф НЕ пуст — проверяем именно свёрнутость,
// а не «нечего показывать».
const DEP = {
  files: {
    'scripts/a.mjs': { imports: [], importedBy: ['scripts/b.mjs'], exports: [] },
    'scripts/b.mjs': { imports: ['scripts/a.mjs'], importedBy: [], exports: [] }
  }
}

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = {
    projectMap: { get: vi.fn().mockResolvedValue(MAP), deps: vi.fn().mockResolvedValue(DEP) },
    files: { reveal: vi.fn() }
  }
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

async function mount() {
  vi.doMock('../../src/store/projectStore', () => ({ useProject: (sel: (s: unknown) => unknown) => sel({ path: 'C:/p' }) }))
  const { ProjectMapPanel } = await import('../../src/components/ProjectMapPanel')
  return render(createElement(ProjectMapPanel))
}

describe('Карта проекта: структура выше графа', () => {
  it('структура идёт ПЕРЕД графом зависимостей', async () => {
    const { container } = await mount()
    await waitFor(() => expect(container.textContent).toMatch(/Структура/))
    const text = container.textContent ?? ''
    const iStruct = text.indexOf('Структура')
    const iGraph = text.indexOf('Граф зависимостей')
    expect(iStruct).toBeGreaterThanOrEqual(0)
    expect(iGraph).toBeGreaterThanOrEqual(0)
    expect(iStruct).toBeLessThan(iGraph)
  })

  it('граф свёрнут по умолчанию — картинки на экране нет', async () => {
    const { container } = await mount()
    await waitFor(() => expect(container.textContent).toMatch(/Граф зависимостей/))
    expect(container.querySelector('.gg-pmap-graph')).toBeNull()
  })

  // КОНТРОЛЬНЫЙ КЕЙС: без него «графа нет» неотличимо от «граф сломан и не рисуется».
  it('клик по заголовку разворачивает граф — он рабочий, а не выпилен', async () => {
    const { container } = await mount()
    await waitFor(() => expect(container.querySelector('.gg-pmap-graph-toggle')).toBeTruthy())
    fireEvent.click(container.querySelector('.gg-pmap-graph-toggle')!)
    await waitFor(() => expect(container.querySelector('.gg-pmap-graph')).toBeTruthy())
  })

  it('итог в заголовке считается из тех же данных, что и картинка', async () => {
    // Расхождение здесь означало бы «12 связей» над пустой картинкой — два
    // независимых счёта разъезжаются молча.
    const { container } = await mount()
    await waitFor(() => expect(container.querySelector('.gg-pmap-graph-toggle')).toBeTruthy())
    const head = container.querySelector('.gg-pmap-graph-toggle')!.textContent ?? ''
    expect(head).toMatch(/связ/)
    expect(head).not.toMatch(/связей не найдено/)
  })
})
