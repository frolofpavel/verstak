// C5 (13.08): «Шаблоны для разработчиков» не ведут на снятые с поддержки пакеты.
//
// В шаблонах жили три пакета, у которых на npm стоит `deprecated: Package no
// longer supported` — server-github, server-postgres, server-puppeteer (проверено
// по живому npm 13.08). Заготовка на мёртвый пакет хуже отсутствия заготовки:
// выглядит рекомендацией продукта, а даёт отказ на первом же запуске.
//
// Живой npm в тесте не дёргаем (сеть в прогоне — источник ложного красного),
// поэтому пин держит два проверяемых свойства: перечисленные мёртвые пакеты не
// вернулись, и шаблоны не дублируют каталог P8 (браузер там уже есть — Playwright).
import { describe, it, expect } from 'vitest'
import { POPULAR_MCP_SERVERS } from '../../electron/mcp/registry'
import { MCP_CATALOG } from '../../electron/mcp/catalog'

/** Снято с поддержки на npm — проверено вручную 13.08, см. коммит C5. */
const DEPRECATED_PACKAGES = [
  '@modelcontextprotocol/server-github',
  '@modelcontextprotocol/server-postgres',
  '@modelcontextprotocol/server-puppeteer',
]

const packagesOf = (args: readonly string[]) => args.filter(a => a !== '-y' && !a.startsWith('-'))

describe('C5: шаблоны подключения', () => {
  it('ПИН: ни один шаблон не ведёт на снятый с поддержки пакет', () => {
    for (const tpl of POPULAR_MCP_SERVERS) {
      for (const dead of DEPRECATED_PACKAGES) {
        expect(tpl.args, `шаблон «${tpl.name}» ведёт на мёртвый пакет ${dead}`).not.toContain(dead)
      }
    }
  })

  it('ПИН: шаблоны не дублируют каталог — там записи проверены и обновляются', () => {
    const catalogPackages = new Set(MCP_CATALOG.flatMap(e => packagesOf(e.args)))
    for (const tpl of POPULAR_MCP_SERVERS) {
      for (const pkg of packagesOf(tpl.args)) {
        expect(catalogPackages.has(pkg), `шаблон «${tpl.name}» дублирует запись каталога (${pkg})`).toBe(false)
      }
    }
  })

  it('КОНТРОЛЬ: раздел не опустел — рабочая заготовка осталась', () => {
    // Пустой список спрятал бы весь раздел в UI (popular.length > 0), и пин выше
    // стал бы зелёным ни о чём: «мёртвых нет» верно и когда нет ничего.
    expect(POPULAR_MCP_SERVERS.length).toBeGreaterThan(0)
    expect(POPULAR_MCP_SERVERS.map(t => t.args).flat()).toContain('@modelcontextprotocol/server-filesystem')
  })

  it('КОНТРОЛЬ: шаблоны заполнены и неинтерактивны (npx с -y)', () => {
    for (const tpl of POPULAR_MCP_SERVERS) {
      expect(tpl.name.trim()).not.toBe('')
      expect(tpl.description.trim()).not.toBe('')
      if (tpl.command === 'npx') expect(tpl.args, `«${tpl.name}»: npx без -y повиснет на вопросе`).toContain('-y')
    }
  })
})
