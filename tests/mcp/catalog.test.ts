// P8 «MCP первоклассный»: каталог готовых серверов — данные, не инфраструктура.
// Тест стережёт целостность каталога: подключение в один шаг возможно только если
// команда реальна, env-поля описаны, а секреты не зашиты ни в args, ни в данные.
import { describe, it, expect } from 'vitest'
import { MCP_CATALOG, type McpCatalogEntry } from '../../electron/mcp/catalog'

describe('MCP catalog integrity', () => {
  it('покрывает российские сервисы из постановки 12.08', () => {
    // 1С, Контур.Фокус, amoCRM, Авито, ВК, Yandex Tracker, HeadHunter, 2ГИС, MOEX, ЦБ
    const required = ['1c-odata', 'kontur-focus', 'amocrm', 'avito', 'vk', 'yandex-tracker', 'hh', '2gis', 'moex', 'cbr']
    const ids = MCP_CATALOG.map(e => e.id)
    for (const id of required) expect(ids, `нет записи каталога "${id}"`).toContain(id)
    expect(MCP_CATALOG.filter(e => e.group === 'russian').length).toBeGreaterThanOrEqual(10)
  })

  it('id уникальны, команда и описание заполнены', () => {
    const ids = new Set<string>()
    for (const e of MCP_CATALOG) {
      expect(ids.has(e.id), `дубль id "${e.id}"`).toBe(false)
      ids.add(e.id)
      expect(e.name.trim()).not.toBe('')
      expect(e.command.trim()).not.toBe('')
      expect(e.description.trim()).not.toBe('')
      expect(Array.isArray(e.args)).toBe(true)
    }
  })

  it('runtime согласован с командой; npx-записи неинтерактивны (-y)', () => {
    for (const e of MCP_CATALOG) {
      if (e.runtime === 'npx') {
        expect(e.command, `${e.id}: runtime npx → command npx`).toBe('npx')
        expect(e.args[0], `${e.id}: npx без -y задаст вопрос и сломает один шаг`).toBe('-y')
      }
      if (e.runtime === 'uvx') expect(e.command, `${e.id}: runtime uvx → command uvx`).toBe('uvx')
    }
  })

  it('env-поля описаны для человека; секреты не зашиты в args и не имеют значений', () => {
    for (const e of MCP_CATALOG) {
      for (const f of e.env) {
        expect(f.key.trim(), `${e.id}: пустой env key`).not.toBe('')
        expect(f.label.trim(), `${e.id}/${f.key}: пустой label`).not.toBe('')
        // Каталог — дескрипторы полей, НЕ значения: ключ вводит человек, значение
        // живёт только в mcp_servers (settings secret, safeStorage).
        expect('value' in (f as unknown as Record<string, unknown>), `${e.id}/${f.key}: в каталоге не место значениям`).toBe(false)
      }
      for (const a of e.args) {
        expect(/YOUR_|<|>/.test(a), `${e.id}: плейсхолдер секрета в args "${a}"`).toBe(false)
      }
    }
  })

  it('noKey ⇔ нет обязательных env-полей', () => {
    for (const e of MCP_CATALOG) {
      const hasRequired = e.env.some(f => f.required)
      expect(e.noKey, `${e.id}: noKey=${e.noKey} при required env=${hasRequired}`).toBe(!hasRequired)
    }
  })

  it('каталог типобезопасен: группа из известного множества', () => {
    for (const e of MCP_CATALOG) {
      expect(['russian', 'world']).toContain((e as McpCatalogEntry).group)
    }
  })
})
