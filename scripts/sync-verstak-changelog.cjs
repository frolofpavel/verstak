/**
 * Генерирует журнал изменений Verstak в D:\PROGRAMMS\VERSTAK
 * Запуск: node scripts/sync-verstak-changelog.cjs
 */
const fs = require('fs')
const path = require('path')
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('docx')

const OUT_DIR = 'D:\\PROGRAMMS\\VERSTAK'
const BASE_NAME = 'Verstak - Журнал изменений'

const ENTRIES = [
  {
    version: '1.3.0',
    build: '15.06.2026',
    deployed: '15.06.2026',
    title: 'Установка Verstak (fork frolofpavel/verstak)',
    changes: [
      'Клонирован репозиторий https://github.com/frolofpavel/verstak в C:\\Users\\RAYNER\\verstak.',
      'npm install --legacy-peer-deps, npm run dist:win.',
      'Копия сборки в %LOCALAPPDATA%\\Programs\\Verstak.',
      'Verstak-only блоки (коннекторы, AuthScreen, cross-verify) не трогались.'
    ]
  },
  {
    version: '1.3.0',
    build: '15.06.2026',
    deployed: '15.06.2026',
    title: 'Экран входа: читаемость «10+ провайдеров»',
    changes: [
      'Подложка на .gg-auth-left-content в layout.css.',
      'Крупнее текст фич на экране авторизации.'
    ]
  },
  {
    version: '1.3.0',
    build: '15.06.2026',
    deployed: '15.06.2026',
    title: 'Интеграция доработок из Grok Desktop (без дублирования)',
    changes: [
      'Rail: expand/search, шестерёнка в footer rail, иконки проектов, алфавитный порядок.',
      'SettingsGearIcon.tsx, ProjectRail.tsx, modal portal (настройки проекта).',
      'Уведомления (звук + toast), вкладка Обновления, UI scale.',
      'CLI prompt fix, ensureProjectForChat, notify, UpdatesSettings.',
      'Список моделей PROVIDERS не расширялся — те же id, что были в Verstak.'
    ]
  },
  {
    version: '1.3.0',
    build: '15.06.2026',
    deployed: '15.06.2026',
    title: 'Настройки → Модели: карточки провайдеров',
    changes: [
      'Карточки: «Включить все» / «Выбрать отдельные».',
      'По умолчанию в enabled_models — только модель входа (активный провайдер).',
      'Модалка авторизации + кнопка «Открыть сайт» (app.openExternal).',
      'ModelPicker фильтрует по enabled_models.',
      'Файлы: Settings.tsx (ModelsPage), model-catalog.ts, layout.css, electron/ipc/projects.ts, preload.'
    ]
  },
  {
    version: '1.3.0',
    build: '15.06.2026',
    deployed: '15.06.2026',
    title: 'Запоминание размера и позиции окна',
    changes: [
      'electron/window-state-core.ts, window-state.ts, main.ts.',
      'Ключ main_window_bounds в settings.',
      'Тест: tests/window-state.test.ts.'
    ]
  },
  {
    version: '1.3.0',
    build: '15.06.2026',
    deployed: '15.06.2026',
    title: 'Rail: иконки проектов не обрезаются в свёрнутом режиме',
    changes: [
      'padding-top у .gg-rail-list — outline и badge не клипятся скроллом.',
      'Свёрнутый chip: outline-offset 0, отступы 2px.',
      'Индикатор unread: top 0 вместо -3px.',
      'gg-project-avatar-img: object-fit cover.'
    ]
  },
  {
    version: '1.3.0',
    build: '15.06.2026 18:07',
    deployed: '15.06.2026 18:07',
    title: 'Переключатель моделей в левом нижнем углу сайдбара',
    changes: [
      'Статичная плашка Gemini заменена на кликабельный ModelPicker (variant=footer).',
      'Меню вверх: сначала «Подключённые» (авторизованные + включённые в Модели), текущая — с ✓.',
      'Секция «Нужна авторизация» — клик открывает Настройки.',
      'Жёлтый индикатор «не подключён», если активный провайдер без ключа/CLI.',
      'Тот же улучшенный пикер в composer чата.',
      'Файлы: ModelPicker.tsx, Sidebar.tsx, App.tsx, layout.css, i18n ru/en.'
    ]
  },
  {
    version: '1.3.0',
    build: '15.06.2026',
    deployed: '15.06.2026',
    title: 'Журнал изменений Verstak',
    changes: [
      'Создан документ Verstak - Журнал изменений.docx в D:\\PROGRAMMS\\VERSTAK.',
      'После каждого изменения Verstak агент дописывает запись и перегенерирует файл.',
      'Пересборка: node scripts/sync-verstak-changelog.cjs (или npm run sync:changelog).'
    ]
  }
]

function heading(text) {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 120 } })
}

function body(text) {
  return new Paragraph({
    children: [new TextRun({ text, size: 22 })],
    spacing: { after: 80 }
  })
}

function bullet(text) {
  return new Paragraph({
    children: [new TextRun({ text: `• ${text}`, size: 22 })],
    indent: { left: 360 },
    spacing: { after: 60 }
  })
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const children = [
    new Paragraph({
      children: [new TextRun({ text: 'Verstak — Журнал изменений', bold: true, size: 36 })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 }
    }),
    body(`Обновлено: ${new Date().toLocaleString('ru-RU')}`),
    body('Версия в package.json: 1.3.1'),
    body('Исходники: C:\\Users\\RAYNER\\verstak'),
    body('Установка: %LOCALAPPDATA%\\Programs\\Verstak'),
    body('Правило: после каждого изменения/деплоя агент дописывает запись и перегенерирует этот файл (node scripts/sync-verstak-changelog.cjs).'),
    new Paragraph({ text: '', spacing: { after: 200 } })
  ]

  for (const e of ENTRIES) {
    children.push(heading(e.title))
    children.push(body(`Версия: ${e.version}  |  Сборка: ${e.build}  |  Деплой: ${e.deployed}`))
    for (const c of e.changes) children.push(bullet(c))
  }

  const doc = new Document({ sections: [{ children }] })
  const buf = await Packer.toBuffer(doc)
  const docxPath = path.join(OUT_DIR, `${BASE_NAME}.docx`)
  fs.writeFileSync(docxPath, buf)
  console.log('OK:', docxPath)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
