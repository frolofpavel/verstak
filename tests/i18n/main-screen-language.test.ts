import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ru } from '../../src/i18n/ru'
import { en } from '../../src/i18n/en'

const srcRoot = join(__dirname, '..', '..', 'src')
const read = (rel: string) => readFileSync(join(srcRoot, rel), 'utf8')

/**
 * Враждебное ревью 2.6.4 §5. Английский главный экран одновременно показывал
 * `Terminal`, `Parallel chat`, **`Агенты`**, `Pavel · `**`Основной чат`**,
 * «What needs to be done?», **`Стандарт`**, **`Инструменты чата`**, секцию
 * **`МАТЕРИАЛЫ`**, фильтры **«Все / Активные / Пауза / Завершённые / Архив»** и
 * **`История работы`**. Кнопка «English» на первом экране обещала то, чего нет.
 *
 * Полная локализация — вторая волна (1137 литералов в 62 файлах). Здесь
 * стерегутся ровно те строки, что человек видит в первые пять минут: главный
 * экран и онбординг.
 */
describe('главный экран и онбординг — один язык (§5)', () => {
  /** Что именно ревью увидело на экране → где это было зашито литералом. */
  const MEASURED: Array<{ file: string; literal: string }> = [
    { file: 'components/Sidebar.tsx', literal: '"Материалы"' },
    { file: 'components/Chat.tsx', literal: '<span>Агенты</span>' },
    { file: 'components/AgentsPanel.tsx', literal: '>Агенты<' },
    { file: 'components/AgentRunsPanel.tsx', literal: '>История работы<' },
    { file: 'components/chat/ComposerMetaRow.tsx', literal: '<span>Инструменты чата</span>' },
    { file: 'components/chat/ComposerMetaRow.tsx', literal: 'title="Инструменты чата"' },
    { file: 'components/EffortPicker.tsx', literal: "label: 'Стандарт'" },
    { file: 'components/ProjectRail.tsx', literal: "'Активные'" },
    { file: 'components/AuthScreen.tsx', literal: "label: 'Developer'" },
    { file: 'store/projectStore.ts', literal: "title: 'Основной чат'" },
    // Поймано ЖИВОЙ приёмкой 16.08, а не чтением кода: на английском главном
    // экране это была единственная оставшаяся кириллица.
    { file: 'components/ModelPicker.tsx', literal: '>не подключён</span>' },
  ]

  it('измеренные строки больше не зашиты литералом в свои файлы', () => {
    const left = MEASURED.filter(({ file, literal }) => read(file).includes(literal))
    expect(left).toEqual([])
  })

  /**
   * Контроль против ложной починки: литерал можно «убрать», положив ту же
   * русскую строку в ОБА словаря — экран останется двуязычным, а пин выше
   * позеленеет. Поэтому проверяем, что перевод существует и РАЗНЫЙ.
   */
  it('контроль: у каждой подписи есть перевод, и он отличается от русского', () => {
    const pairs: Array<[string, string, string]> = [
      ['sidebar.materialsSection', ru.sidebar.materialsSection, en.sidebar.materialsSection],
      ['sidebar.chatTools', ru.sidebar.chatTools, en.sidebar.chatTools],
      ['sidebar.workHistory', ru.sidebar.workHistory, en.sidebar.workHistory],
      ['sidebar.agents', ru.sidebar.agents, en.sidebar.agents],
      ['sidebar.mainChat', ru.sidebar.mainChat, en.sidebar.mainChat],
      ['rail.filterAll', ru.rail.filterAll, en.rail.filterAll],
      ['rail.filterActive', ru.rail.filterActive, en.rail.filterActive],
      ['rail.filterPaused', ru.rail.filterPaused, en.rail.filterPaused],
      ['rail.filterDone', ru.rail.filterDone, en.rail.filterDone],
      ['rail.filterArchive', ru.rail.filterArchive, en.rail.filterArchive],
      ['effort.standard', ru.effort.standard, en.effort.standard],
      ['effort.title', ru.effort.title, en.effort.title],
      ['modelPicker.notConnected', ru.modelPicker.notConnected, en.modelPicker.notConnected],
      ['modelPicker.envKey', ru.modelPicker.envKey, en.modelPicker.envKey],
      ['auth.roles.developer', ru.auth.roles.developer, en.auth.roles.developer],
      ['auth.roles.student', ru.auth.roles.student, en.auth.roles.student],
    ]
    const broken = pairs.filter(([, r, e]) => !r || !e || r === e).map(([key]) => key)
    expect(broken).toEqual([])
    // Русская сторона — кириллицей, английская — без неё.
    for (const [key, r, e] of pairs) {
      expect(/[а-яА-ЯёЁ]/.test(r), `${key} (ru)`).toBe(true)
      expect(/[а-яА-ЯёЁ]/.test(e), `${key} (en)`).toBe(false)
    }
  })
})
