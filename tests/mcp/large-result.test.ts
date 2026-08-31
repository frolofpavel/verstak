import { describe, it, expect } from 'vitest'
import { splitLargeMcpResult, largeResultFileName, MCP_RESULT_INLINE_LIMIT } from '../../electron/mcp/large-result'

// 29.08 в каталог добавлен рекламный и торговый стек. Ответ такого сервера — выгрузка
// товаров Wildberries, отчёт Метрики, список кампаний Директа — это десятки и сотни
// килобайт, и до сих пор он уходил модели ЦЕЛИКОМ: JSON.stringify без ограничения.
// Один вызов способен съесть окно и деньги, а человек не поймёт, за что заплатил.
// Приём взят у Antigravity (август 2026): крупный ответ сохраняется файлом, в
// переписку идёт ссылка.
//
// ГЛАВНЫЙ ПИН: большой ответ режется, и модель ЗНАЕТ, что видела не всё.

const big = (n: number) => 'x'.repeat(n)

describe('MCP: крупный ответ не уезжает в контекст целиком', () => {
  it('ответ больше порога режется и говорит, где взять полный', () => {
    const { inline, overflow } = splitLargeMcpResult(big(MCP_RESULT_INLINE_LIMIT * 3), 'C:/p/.verstak/artifacts/2026-08-29/mcp-x.txt')
    expect(inline.length).toBeLessThan(MCP_RESULT_INLINE_LIMIT + 500)
    expect(inline).toContain('обрезан')
    expect(inline).toContain('mcp-x.txt')
    expect(overflow, 'полный текст не отдан для записи в файл').toBeTruthy()
  })

  it('если файл записать не удалось — модели сказано, что остатка у неё НЕТ', () => {
    // Молчаливая обрезка хуже отказа: модель уверена, что видела всё, и строит вывод
    // на половине данных. Это ровно тот «глушитель», о котором предупреждает §3.1.
    const { inline } = splitLargeMcpResult(big(MCP_RESULT_INLINE_LIMIT * 2), null)
    expect(inline).toContain('обрезан')
    expect(inline).toMatch(/НЕТ|не удалось/)
  })

  // КОНТРОЛЬНЫЙ КЕЙС: без него оба утверждения выше зелены и тогда, когда режется ВСЁ
  // подряд — «большое обрезано» неотличимо от «сломано и обрезает всегда».
  it('обычный ответ проходит нетронутым — резак не трогает мелочь', () => {
    const normal = '{"campaigns":[{"id":1,"name":"Бренд"}]}'
    const { inline, overflow } = splitLargeMcpResult(normal, 'C:/p/f.txt')
    expect(inline).toBe(normal)
    expect(overflow).toBeNull()
  })

  it('ответ ровно на пороге не режется — граница не съезжает на единицу', () => {
    const { overflow } = splitLargeMcpResult(big(MCP_RESULT_INLINE_LIMIT), 'C:/p/f.txt')
    expect(overflow).toBeNull()
  })
})

describe('MCP: имя файла для сохранённого ответа', () => {
  it('имя инструмента чистится — путь не вырвется из каталога артефактов', () => {
    const name = largeResultFileName('../../etc/passwd', 1756400000000)
    expect(name).not.toContain('/')
    expect(name).not.toContain('..\\')
    expect(name.startsWith('mcp-')).toBe(true)
  })

  it('пустое или полностью недопустимое имя не даёт пустого файла', () => {
    expect(largeResultFileName('///', 1)).toMatch(/^mcp-.+/)
  })

  // КОНТРОЛЬНЫЙ: обычное имя сохраняется узнаваемым, иначе файлы не различить.
  it('нормальное имя инструмента остаётся читаемым', () => {
    expect(largeResultFileName('wb_products_list', 1756400000000)).toContain('wb_products_list')
  })
})
