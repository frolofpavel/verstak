import { describe, expect, it } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { INTERMEDIATE } = require('../../scripts/build-setup.cjs')

// Класс дефекта: сборщик установщика создаёт четыре промежуточные стадии в
// release/ и до 2.5.0 не убирал их после успешной сборки — ~2.1 ГБ лежали до
// следующего релиза, а глубокие пути внутри staging давали «Filename too long»
// при удалении временной копии дерева.
//
// Опасность починки ЗЕРКАЛЬНАЯ и дороже самой проблемы: release/win-unpacked
// выглядит таким же промежуточным каталогом, но это ВХОД РЕЛИЗНОГО ГЕЙТА — шаг
// 3.55 сверяет с ним пейлоад установщика пофайлово, шаг 3.6 запускает оттуда
// Verstak.exe для install smoke. Убрав его «заодно», мы отключили бы обе
// проверки молча: гейт не упал бы, он просто перестал бы проверять (в коде
// гейта на этот случай стоит notes.push, а не failure). Ровно так три версии
// подряд уезжали с битым установщиком.

describe('уборка промежуточных стадий сборки', () => {
  it('под уборку попадают ровно промежуточные стадии', () => {
    expect(INTERMEDIATE).toEqual([
      'app-payload-staging',
      'installer-app-staging',
      'installer-build',
      'app-payload.7z',
    ])
  })

  it('КОНТРОЛЬ: win-unpacked НЕ под уборкой — на нём стоят шаги 3.55 и 3.6 гейта', () => {
    expect(INTERMEDIATE).not.toContain('win-unpacked')
  })

  it('КОНТРОЛЬ: артефакты релиза и провенанс не под уборкой', () => {
    // Setup/Portable/latest.yml — то, что уезжает людям; BUILD_PROVENANCE.json
    // гейт сверяет с HEAD. Любое из них в списке = релиз нечего публиковать.
    for (const keep of ['latest.yml', 'BUILD_PROVENANCE.json', 'app-payload-manifest.json']) {
      expect(INTERMEDIATE).not.toContain(keep)
    }
    expect(INTERMEDIATE.some((n: string) => n.startsWith('Verstak-'))).toBe(false)
  })

  it('список — массив имён внутри release/, без путей наружу', () => {
    // Защита от «убрали пол-диска»: имена относительные и односегментные, никаких
    // '..', абсолютных путей и разделителей — уборка не может выйти из release/.
    for (const name of INTERMEDIATE) {
      expect(name).not.toContain('..')
      expect(name).not.toContain('/')
      expect(name).not.toContain('\\')
      expect(name).not.toContain(':')
    }
  })
})
