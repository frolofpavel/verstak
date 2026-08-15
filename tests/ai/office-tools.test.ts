import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ExcelJS from 'exceljs'
import { readSpreadsheet, editSpreadsheet } from '../../electron/ai/office'

let projectPath: string

// Создаёт крошечный .xlsx с одним листом для round-trip теста.
async function writeFixture(rel: string, sheetName: string): Promise<void> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(sheetName)
  ws.addRow(['Клиент', 'Сумма'])
  ws.addRow(['Альфа', 1000])
  ws.addRow(['Бета', 2000])
  await wb.xlsx.writeFile(join(projectPath, rel))
}

beforeEach(async () => {
  projectPath = await mkdtemp(join(tmpdir(), 'gg-office-'))
})

afterEach(async () => {
  if (projectPath) await rm(projectPath, { recursive: true, force: true })
})

describe('readSpreadsheet', () => {
  it('возвращает имя листа и строки таблицей', async () => {
    await writeFixture('data.xlsx', 'Отчёт')
    const text = await readSpreadsheet(projectPath, 'data.xlsx')
    expect(text).toContain('Лист: Отчёт')
    expect(text).toContain('| Клиент | Сумма |')
    expect(text).toContain('Альфа')
    expect(text).toContain('1000')
  })

  it('блокирует выход за пределы проекта', async () => {
    await expect(readSpreadsheet(projectPath, '../secret.xlsx')).rejects.toThrow()
  })

  it('редактирует секрет в ячейке через secret-scanner', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Ключи')
    ws.addRow(['Сервис', 'Токен'])
    ws.addRow(['GitHub', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'])
    await wb.xlsx.writeFile(join(projectPath, 'keys.xlsx'))
    const text = await readSpreadsheet(projectPath, 'keys.xlsx')
    expect(text).toContain('[REDACTED:github-token]')
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(text).toContain('secret-scanner: redacted')
  })
})

describe('editSpreadsheet', () => {
  it('меняет ячейку и сохраняет — round trip', async () => {
    await writeFixture('data.xlsx', 'Sheet1')
    const res = await editSpreadsheet(projectPath, 'data.xlsx', 'Sheet1', [
      { cell: 'B2', value: '5555' },
      { cell: 'A2', value: 'Гамма' }
    ])
    expect(res.applied).toBe(2)
    expect(res.sheet).toBe('Sheet1')
    const text = await readSpreadsheet(projectPath, 'data.xlsx')
    expect(text).toContain('Гамма')
    expect(text).toContain('5555')
    expect(text).not.toContain('Альфа')
  })

  it('использует первый лист если sheet не задан', async () => {
    await writeFixture('data.xlsx', 'Первый')
    const res = await editSpreadsheet(projectPath, 'data.xlsx', undefined, [{ cell: 'A1', value: 'X' }])
    expect(res.sheet).toBe('Первый')
  })

  it('бросает на некорректной ссылке на ячейку', async () => {
    await writeFixture('data.xlsx', 'Sheet1')
    await expect(
      editSpreadsheet(projectPath, 'data.xlsx', 'Sheet1', [{ cell: 'not-a-cell', value: '1' }])
    ).rejects.toThrow()
  })

  it('бросает на несуществующем листе', async () => {
    await writeFixture('data.xlsx', 'Sheet1')
    await expect(
      editSpreadsheet(projectPath, 'data.xlsx', 'НетТакого', [{ cell: 'A1', value: '1' }])
    ).rejects.toThrow()
  })

  // Ревизия 15.08 §2.8: мутация `office.ts:228` (проверка `isForbiddenPath` обесточена)
  // давала 5463 зелёных. Комментарий в самом файле утверждает: «Правка таблиц проходит
  // через isForbiddenPath + mode-policy (как write_file)» — проходит, но никем не было
  // проверено. Ровно тот класс, что §3.1 называет ложным ОБОСНОВАНИЕМ: оно объясняет,
  // почему проверять не надо.
  //
  // Наблюдаемая величина — БАЙТЫ ФАЙЛА НА ДИСКЕ, а не текст исключения: «бросил» зелено
  // и тогда, когда правка уже применилась, а упало что-то следом.
  describe('запрет секрето-путей (§2.8 ревизии 15.08)', () => {
    it('имя `.env` → правка отклонена, файл на диске не изменён', async () => {
      await writeFixture('.env', 'Sheet1')
      const before = await readFile(join(projectPath, '.env'))
      await expect(
        editSpreadsheet(projectPath, '.env', 'Sheet1', [{ cell: 'A2', value: 'взломано' }])
      ).rejects.toThrow(/политикой безопасности/)
      expect((await readFile(join(projectPath, '.env'))).equals(before)).toBe(true)
    })

    it('расширение `.key` → правка отклонена, файл на диске не изменён', async () => {
      await writeFixture('private.key', 'Sheet1')
      const before = await readFile(join(projectPath, 'private.key'))
      await expect(
        editSpreadsheet(projectPath, 'private.key', 'Sheet1', [{ cell: 'A2', value: 'взломано' }])
      ).rejects.toThrow(/политикой безопасности/)
      expect((await readFile(join(projectPath, 'private.key'))).equals(before)).toBe(true)
    })

    // КОНТРОЛЬ: та же правка по обычному имени ОБЯЗАНА пройти и изменить файл — иначе
    // «файл не изменён» измеряло бы просто неработающий editSpreadsheet.
    it('КОНТРОЛЬ: обычное имя → та же правка проходит и меняет файл', async () => {
      await writeFixture('data.xlsx', 'Sheet1')
      const before = await readFile(join(projectPath, 'data.xlsx'))
      await editSpreadsheet(projectPath, 'data.xlsx', 'Sheet1', [{ cell: 'A2', value: 'взломано' }])
      expect((await readFile(join(projectPath, 'data.xlsx'))).equals(before)).toBe(false)
    })
  })
})
