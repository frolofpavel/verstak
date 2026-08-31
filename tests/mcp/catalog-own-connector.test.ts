import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { MCP_CATALOG } from '../../electron/mcp/catalog'

// 29.08 в каталог добавлен рекламный и торговый стек, и пять записей повторили сервисы,
// к которым у Verstak УЖЕ есть собственный коннектор. Человек стал видеть один сервис
// в двух местах — а выбор между ними не косметический:
//   своё  — только чтение по построению, ключи в safeStorage, вызов исполняет Verstak;
//   сервер — чужой код, может уметь запись, исполняет себя сам.
// Молчать об этом хуже, чем не добавлять сервер вовсе: человек выбирает вслепую.
//
// ГЛАВНЫЙ ПИН: запись, дублирующая свой коннектор, помечена — и пометка доезжает до
// renderer'а. Тип каталога зеркалится в src/types/api.d.ts (штатный способ типизации
// моста: handler → preload → api.d.ts). Зеркало, разошедшееся с источником, ломает
// мост молча: поле есть в main, а renderer о нём не знает и просто не рисует.

const ROOT = join(__dirname, '..', '..')
const API_DTS = readFileSync(join(ROOT, 'src/types/api.d.ts'), 'utf8')

/** Сервисы, у которых есть и свой коннектор, и запись в каталоге. */
const DUPLICATED = ['yandex-metrika', 'yandex-direct', 'bitrix24', 'wildberries', 'dadata']

describe('каталог MCP: дубли собственных коннекторов помечены', () => {
  it('каждая запись, повторяющая свой коннектор, названа', () => {
    for (const id of DUPLICATED) {
      const e = MCP_CATALOG.find(x => x.id === id)
      expect(e, `нет записи ${id}`).toBeTruthy()
      expect(e!.ownConnector, `${id} не помечен как дубль собственного коннектора`).toBeTruthy()
    }
  })

  it('зеркало типа в api.d.ts знает про поле — иначе renderer его не нарисует', () => {
    expect(API_DTS, 'ownConnector отсутствует в зеркале типа для renderer').toMatch(/ownConnector\?: string/)
  })

  // КОНТРОЛЬНЫЙ КЕЙС: без него первый пин зелен и тогда, когда помечено ВСЁ подряд —
  // пометка перестала бы отличать дубль от уникального сервера, а именно различение
  // и есть её смысл.
  it('уникальные серверы НЕ помечены — пометка различает, а не украшает', () => {
    // MOEX и Центробанк своих коннекторов у Verstak не имеют.
    for (const id of ['moex', 'cbr']) {
      const e = MCP_CATALOG.find(x => x.id === id)
      expect(e, `нет записи ${id}`).toBeTruthy()
      expect(e!.ownConnector, `${id} помечен дублем, хотя своего коннектора нет`).toBeUndefined()
    }
  })
})
