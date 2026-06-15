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
    version: '1.3.1',
    build: '16.06.2026',
    deployed: '16.06.2026',
    title: 'UI fix: rail 76px, плюсик, accent у активной модели',
    changes: [
      'Свёрнутый rail шире (76px) — углубление активного проекта не обрезается.',
      'Плюсик «+» по центру кнопки без сдвига transform.',
      'Модели: жирная accent-полоса слева у выбранной модели провайдера (border + inset).'
    ]
  },
  {
    version: '1.3.1',
    build: '16.06.2026',
    deployed: '16.06.2026',
    title: 'UI polish: rail, темы, модели, шрифты',
    changes: [
      'Темы: подписи «Тёмная» и «Светлая».',
      'Rail: плюсик выровнен по вертикали; углубление активного проекта не обрезается справа.',
      'Rail: подписи проектов плавно появляются при раскрытии (как исчезают при сворачивании).',
      'Модели: все карточки одного цвета; яркий accent слева только у текущей модели.',
      'Шрифты: Inter + JetBrains Mono с кириллицей (единая толщина RU/EN).'
    ]
  },
  {
    version: '1.4.0',
    build: '16.06.2026',
    deployed: '16.06.2026',
    title: 'Shell Atelier: плоский editorial-редизайн главного экрана',
    changes: [
      'Замена Shell Luxe → Shell Atelier: единая плоскость без glass/blur/orbs.',
      'Палитра warm graphite + champagne gold; тонкие разделители, inset-акцент слева.',
      'Узкий rail 56px, composer как anchored bar, анимации 240–280ms без spring-bounce.',
      'Миграция путей БД: скрипты migrate-project-paths.cjs / inspect-db-temp.cjs.'
    ]
  },
  {
    version: '1.3.2',
    build: '16.06.2026',
    deployed: '16.06.2026',
    title: 'Откат UI: до глобального редизайна (rail v1 + layout)',
    changes: [
      'Восстановлен дизайн до Rail v2 и Shell v2 (коммит 11d2260).',
      'Удалены rail.css и shell.css; стили rail снова в layout.css.',
      'Резерв v2: legacy/rail-v1/, ветка backup/rail-v1.'
    ]
  },
  {
    version: '1.3.2',
    build: '16.06.2026',
    deployed: '16.06.2026',
    title: 'Rail dock: только иконки без подписей',
    changes: [
      'Убраны текстовые подписи у кнопок сворачивания rail, панели и поиска — остались иконки и tooltip.'
    ]
  },
  {
    version: '1.3.2',
    build: '16.06.2026',
    deployed: '16.06.2026',
    title: 'Shell v2: единый стиль интерфейса + без цветных плашек в rail',
    changes: [
      'Убраны цветные полоски у карточек проектов в rail.',
      'Новый shell.css: sidebar, чат, composer, панели, модалки, настройки — в стиле rail v2.',
      'Обновлены кнопки и поля ввода (градиенты, скругления, inset-подсветка).'
    ]
  },
  {
    version: '1.3.1',
    build: '16.06.2026',
    deployed: '16.06.2026',
    title: 'Rail v2: полный редизайн бокового меню проектов',
    changes: [
      'Новый дизайн с нуля: шапка, dock-кнопки, карточки проектов с цветной полосой, поиск, футер.',
      'Плавные анимации раскрытия на едином --shell-dur 360ms.',
      'Резерв v1: legacy/rail-v1/ + ветка git backup/rail-v1 для отката.'
    ]
  },
  {
    version: '1.3.1',
    build: '16.06.2026',
    deployed: '16.06.2026',
    title: 'Анимации панелей: единый темп и плавный rail',
    changes: [
      'Rail и sidebar закрываются с одной скоростью (--shell-dur 360ms).',
      'Переписана анимация rail: без рывков max-width/opacity, тулбар column→row после раскрытия.',
      'Подписи проектов и шапка rail исчезают синхронно со сжатием ширины.'
    ]
  },
  {
    version: '1.3.1',
    build: '16.06.2026',
    deployed: '16.06.2026',
    title: 'Боковая панель: плавное скрытие',
    changes: [
      'Sidebar и ручка ресайза сжимаются плавно (~360ms), контент не исчезает мгновенно.',
      'При сворачивании — fade + схлопывание ширины; главная область расширяется синхронно.',
      'Учтён prefers-reduced-motion.'
    ]
  },
  {
    version: '1.3.1',
    build: '16.06.2026',
    deployed: '16.06.2026',
    title: 'Настройки проекта: рамки у названия и выбора изображения',
    changes: [
      'Поле названия проекта — видимая рамка, hover и акцент при фокусе.',
      'Кнопка «Выбрать изображение» — контур и тень, понятно что это кнопка.'
    ]
  },
  {
    version: '1.3.1',
    build: '16.06.2026',
    deployed: '16.06.2026',
    title: 'Rail: тулбар, список проектов, сортировка',
    changes: [
      'Кнопки сворачивания, sidebar и поиск плавно переходят столбик ↔ ряд без скачков.',
      'Плюс «Создать проект» по центру в свёрнутом rail.',
      'Буквы на аватарках в списке крупнее (15px / 14px).',
      'Сортировка: сначала кириллица по русскому алфавиту, затем латиница.'
    ]
  },
  {
    version: '1.3.1',
    build: '16.06.2026',
    deployed: '16.06.2026',
    title: 'Rail проектов: плавное сворачивание',
    changes: [
      'Анимация ширины панели и grid без рывков (~360ms).',
      'Подписи и поиск не исчезают мгновенно — fade + плавное сжатие.',
      'Учтён prefers-reduced-motion.'
    ]
  },
  {
    version: '1.3.1',
    build: '16.06.2026',
    deployed: '16.06.2026',
    title: 'Настройки проекта: шапка и поля',
    changes: [
      'Шапка: аватарка как в rail, название редактируется на месте.',
      'Кнопки «Выбрать изображение» и «Сохранить название» в шапке.',
      'Убраны секции «Отображение в списке» и «Быстрые действия».',
      'Системный промпт — рамка и затемнённый фон, понятно что поле редактируемое.'
    ]
  },
  {
    version: '1.3.1',
    build: '15.06.2026',
    deployed: '15.06.2026',
    title: 'Терминология: клиент → проект',
    changes: [
      'Во всём интерфейсе Verstak «клиент» заменён на «проект» (rail, модалки, удаление, ошибки).',
      'Шаблон AGENTS.md для новых папок — тоже «проект».'
    ]
  },
  {
    version: '1.3.1',
    build: '15.06.2026',
    deployed: '15.06.2026',
    title: 'Удаление проекта: кнопка «Убрать из списка»',
    changes: [
      'Кнопка с рамкой, фоном и тенью — не выглядит как голый текст.'
    ]
  },
  {
    version: '1.3.1',
    build: '15.06.2026',
    deployed: '15.06.2026',
    title: 'Создание проекта: превью-аватарка',
    changes: [
      'Буква в круге при создании — крупнее и по центру, как у существующих проектов.',
      'Подпись «Открыть существующий» без отсылок к прошлому UI.'
    ]
  },
  {
    version: '1.3.1',
    build: '15.06.2026',
    deployed: '15.06.2026',
    title: 'Rail свёрнутый: свечение аватарки без обрезки',
    changes: [
      'Свечение активного клиента больше не обрезается слева и справа.',
      'Ярче кольцо при тех же размерах размытия; свечение на отдельном слое.'
    ]
  },
  {
    version: '1.3.1',
    build: '15.06.2026',
    deployed: '15.06.2026',
    title: 'Rail: порядок кнопок в тулбаре',
    changes: [
      'Сначала стрелка «Панель клиентов», затем иконка sidebar, потом поиск.'
    ]
  },
  {
    version: '1.3.1',
    build: '15.06.2026',
    deployed: '15.06.2026',
    title: 'Rail свёрнутый: кольцо вокруг аватарки',
    changes: [
      'Равномерное свечение по кругу на аватаре активного клиента.',
      'Убрана боковая полоса в collapsed; развёрнутый режим — карточка с полосой слева.'
    ]
  },
  {
    version: '1.3.1',
    build: '15.06.2026',
    deployed: '15.06.2026',
    title: 'Rail свёрнутый: без обрезки, ярче активный клиент',
    changes: [
      'Исправлена обрезка аватаров в узком rail.',
      'Активный клиент: фон, полоса и свечение как в развёрнутом меню.'
    ]
  },
  {
    version: '1.3.1',
    build: '15.06.2026',
    deployed: '15.06.2026',
    title: 'Удаление клиента: с данными или без',
    changes: [
      'Два варианта: убрать из списка (файлы остаются) или удалить с данными.',
      '«Удалить с данными»: 5 с отсчёта при наведении, затем подтверждение.',
      'Полное удаление: папка на диске + чаты, задачи, журнал, память в БД.'
    ]
  },
  {
    version: '1.3.1',
    build: '15.06.2026',
    deployed: '15.06.2026',
    title: 'Создание клиента нативно в Verstak',
    changes: [
      'Кнопка «Создать клиента» → модалка: новый или открыть существующего.',
      'Новый клиент: название, папка латиницей, опционально иконка.',
      'Папка создаётся в ~/clients/{slug} с AGENTS.md, logs/ и reports/.'
    ]
  },
  {
    version: '1.3.1',
    build: '15.06.2026',
    deployed: '15.06.2026',
    title: 'Rail клиентов: новый визуал',
    changes: [
      'Переработана левая колонка клиентов: карточки, круглые аватары, капсула инструментов.',
      'Заголовок «Клиенты» со счётчиком, поиск с иконкой, акцентная полоса у активного.',
      'Статус (ответ / стрим) — точка на аватаре; настройки проекта — иконка шестерёнки.'
    ]
  },
  {
    version: '1.3.1',
    build: '15.06.2026',
    deployed: '15.06.2026',
    title: 'Чат: автопрокрутка при отправке + подпись на кнопке',
    changes: [
      'Исправлена автопрокрутка при отправке своего сообщения (гонка scroll vs pin).',
      'Кнопка автопрокрутки с текстом «Автопрокрутка: вкл/выкл» вместо иконки.'
    ]
  },
  {
    version: '1.3.1',
    build: '15.06.2026',
    deployed: '15.06.2026',
    title: 'Чат: прокрутка вниз и выкл автопрокрутки',
    changes: [
      'Кнопка ↓ в ленте — быстрый переход к последним сообщениям, если отмотал вверх.',
      'Переключатель автопрокрутки в composer (запоминается в localStorage).',
      'Индикатор обновления в rail над «Настройки» вместо полосы на весь экран.'
    ]
  },
  {
    version: '1.3.1',
    build: '15.06.2026',
    deployed: '15.06.2026',
    title: 'Старт чата, обновления, скиллы Grok',
    changes: [
      'Двухфазная загрузка истории чата — composer доступен сразу после открытия проекта.',
      'Автофокус textarea, отложенные модалки при старте (модели / обновления).',
      'Исправлен updater: без красной ошибки при отсутствии GitHub Release; модалка при новой версии.',
      'loadFromGrokTree в electron/ai/skills/loader.ts — скиллы из ~/.grok/skills/{id}/SKILL.md.',
      'Сборка: Verstak-Setup-1.3.1-x64.exe + latest.yml для публикации на frolofpavel/verstak Releases.'
    ]
  },
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
    build: '15.06.2026 18:30',
    deployed: '15.06.2026 18:30',
    title: 'Модели: ползунок «Все», дефолты входа, модалка без модели',
    changes: [
      'Ползунок вместо «Включить все» — вкл/выкл все модели провайдера.',
      'enabled_models: пусто при регистрации без CLI; только модель входа при подключении.',
      'ModelRequiredPrompt при входе без авторизованных провайдеров → вкладка «Модели».',
      'Файлы: enabled-models.ts, ModelRequiredPrompt.tsx, AuthScreen.tsx, OnboardingWizard.tsx.'
    ]
  },
  {
    version: '1.3.0',
    build: '15.06.2026 19:00',
    deployed: '15.06.2026 19:00',
    title: 'Модели: UI карточек провайдеров',
    changes: [
      'Разделители между карточками провайдеров (Gemini / Claude / …) в одном блоке.',
      'Кнопка «Выбрать отдельные» — обводка видна всегда.',
      'Разделители между строками внутри раскрытого списка моделей.',
      'layout.css.'
    ]
  },
  {
    version: '1.3.0',
    build: '15.06.2026 19:05',
    deployed: '15.06.2026 19:05',
    title: 'Git: форк xRAYNERx/verstak_rayner',
    changes: [
      'Remote rayner → https://github.com/xRAYNERx/verstak_rayner.git',
      'Коммит c413519 на main (52 файла).',
      'Обновления приложения — только frolofpavel/verstak (не форк).'
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
    body('Версия в package.json: 1.3.0'),
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