import { describe, it, expect } from 'vitest'
import { renderChartSvg } from '../../electron/ai/charts'

describe('renderChartSvg', () => {
  it('bar chart создаёт валидный SVG с rect элементами', () => {
    const svg = renderChartSvg({
      kind: 'bar',
      title: 'Тест',
      labels: ['Янв', 'Фев', 'Мар'],
      values: [10, 20, 15]
    })
    expect(svg).toContain('<svg')
    expect(svg).toContain('</svg>')
    expect(svg).toContain('<rect')
    expect(svg.match(/<rect/g)?.length).toBeGreaterThanOrEqual(4)  // 3 bars + bg
    expect(svg).toContain('Тест')
    expect(svg).toContain('Янв')
  })

  it('line chart создаёт path и circles', () => {
    const svg = renderChartSvg({
      kind: 'line',
      labels: ['A', 'B', 'C', 'D'],
      values: [5, 10, 7, 15]
    })
    expect(svg).toContain('<path')
    expect(svg.match(/<circle/g)?.length).toBe(4)
  })

  it('pie chart создаёт slices с процентами', () => {
    const svg = renderChartSvg({
      kind: 'pie',
      labels: ['Директ', 'SEO', 'Авито'],
      values: [50, 30, 20]
    })
    expect(svg.match(/<path/g)?.length).toBe(3)
    expect(svg).toContain('50%')
    expect(svg).toContain('30%')
    expect(svg).toContain('20%')
  })

  it('возвращает error SVG если labels и values не совпадают', () => {
    const svg = renderChartSvg({ kind: 'bar', labels: ['A'], values: [] })
    expect(svg).toContain('⚠')
  })

  it('экранирует HTML спецсимволы в подписях', () => {
    const svg = renderChartSvg({
      kind: 'bar',
      title: '<script>',
      labels: ['a&b'],
      values: [1]
    })
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script')
    expect(svg).toContain('a&amp;b')
  })

  it('форматирует большие числа сокращённо (K, M)', () => {
    const svg = renderChartSvg({
      kind: 'bar',
      labels: ['Big'],
      values: [2_500_000]
    })
    expect(svg).toContain('2.5M')
  })
})
