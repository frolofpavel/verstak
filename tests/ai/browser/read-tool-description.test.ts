import { describe, expect, it } from 'vitest'
import { TOOL_DEFS } from '../../../electron/ai/tools'

describe('browser_read_page product contract', () => {
  it('описывает текущую подключённую вкладку без ложного обещания встроенного webview', () => {
    const read = TOOL_DEFS.find(tool => tool.name === 'browser_read_page')
    expect(read?.description).toMatch(/текущей подключённой вкладки/i)
    expect(read?.description).toMatch(/elementRef/i)
    expect(read?.description).not.toMatch(/только.*встроенн|текущей странице во встроенном/i)
  })

  it('даёт модели отдельный opaque elementRef для клика в подключённой вкладке', () => {
    const click = TOOL_DEFS.find(tool => tool.name === 'browser_click')
    const properties = click?.parameters.properties as Record<string, unknown>

    expect(click?.description).toMatch(/подключ[её]нн.*elementRef/i)
    expect(properties).toHaveProperty('elementRef')
  })
})
