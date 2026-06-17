import type { ReleaseNote } from './update-remote'
import { normalizeVersion, semverGt } from './update-remote'

/**
 * Встроенные заметки к сборкам Rayner (форк xRAYNERx).
 * Официальный тон: только факты изменений, без описания причин/багов пользователя.
 */
const RAYNER_NOTES: ReleaseNote[] = [
  {
    version: '1.5.5',
    name: 'Verstak 1.5.5',
    publishedAt: '2026-06-16T18:00:00Z',
    body: [
      '### Обновления',
      '- Устранена повторная установка той же версии: очистка устаревшего кэша electron-updater при запуске.',
      '- Кнопка «Установить» недоступна, если целевая версия уже установлена.',
      '- Реализован single-instance: повторный запуск активирует существующее окно.',
      '',
      '### Установщик',
      '- Брендированный NSIS-установщик: Nord-тема, логотип, русские тексты welcome/finish.',
    ].join('\n'),
    htmlUrl: 'https://github.com/xRAYNERx/verstak_rayner/releases',
  },
  {
    version: '1.5.4',
    name: 'Verstak 1.5.4',
    publishedAt: '2026-06-16T14:00:00Z',
    body: [
      '### Настройки',
      '- Ускорена загрузка вкладки «Настройки»: параллельное чтение ключей коннекторов.',
      '- Добавлена прокрутка к карточке коннектора при выборе из списка.',
      '',
      '### Задачи',
      '- Отключён фоновый опрос панелей «Задачи» при свёрнутом окне или неактивной вкладке.',
      '',
      '### Верификация и ревью',
      '- Статусы DoD: визуальное различие «не запущено» и «частично»; повторная проверка не перезаписывает артефакт.',
      '- Замечания ревью сортируются по уровню важности (критичные первыми).',
    ].join('\n'),
    htmlUrl: 'https://github.com/xRAYNERx/verstak_rayner/releases',
  },
  {
    version: '1.5.3',
    name: 'Verstak 1.5.3',
    publishedAt: '2026-06-16T12:30:00Z',
    body: [
      '### Окно и брендинг',
      '- Кастомная шапка окна без системной рамки.',
      '- Обновлён логотип Verstak: экран входа, шапка, иконка приложения, ярлыки Windows.',
      '',
      '### Уведомления',
      '- Собственные тосты Verstak поверх всех окон; системные уведомления Windows отключены.',
      '- В тексте уведомления отображается название проекта.',
      '',
      '### Чат',
      '- Скиллы, ревью, чекпоинт и мультиагент перенесены в меню «Инструменты».',
      '- Унифицирован размер чипов: Инструменты, режим агента, выбор модели.',
      '',
      '### Rail проектов',
      '- При свёрнутой панели вложенные проекты групп скрываются; состояние групп сохраняется.',
      '',
      '### Обновления',
      '- История версий в настройках: список релизов с датами и changelog.',
      '- При пропуске нескольких версий — сводное окно изменений.',
    ].join('\n'),
    htmlUrl: 'https://github.com/xRAYNERx/verstak_rayner/releases',
  },
  {
    version: '1.5.2',
    name: 'Verstak 1.5.2',
    publishedAt: '2026-06-16T11:00:00Z',
    body: [
      '### Агент и безопасность',
      '- Отключено автоматическое возобновление CLI-агента после аварийного завершения.',
      '- Возобновление задачи переключает на соответствующий чат.',
      '',
      '### Задачи',
      '- Вкладка «Задачи»: отображение живого прогресса (номер хода, инструмент, счётчики).',
      '- В ленте доступны исходный запрос и итог выполнения.',
      '',
      '### Ревью',
      '- Сохранение текста и замечаний ревью между перезапусками.',
      '- Ревьюер получает актуальный git-diff с корректными номерами строк.',
      '',
      '### Dev-задачи',
      '- Привязка git-ветки к задаче; отображение полного пакета изменений.',
      '- Предупреждение при коммите при неуспешных проверках.',
      '',
      '### Верификация',
      '- В Timeline фиксируется отсутствие запуска проверок после изменения файлов.',
      '',
      '### Интерфейс',
      '- Индикатор CLI в композере: обозначение провайдеров без контроля Verstak (undo, checkpoint, подтверждение write).',
    ].join('\n'),
    htmlUrl: 'https://github.com/xRAYNERx/verstak_rayner/releases',
  },
  {
    version: '1.5.1',
    name: 'Verstak 1.5.1',
    publishedAt: '2026-06-16T12:00:00Z',
    body: [
      '### Окно и брендинг',
      '- Кастомная шапка окна без системной рамки и меню File/Edit.',
      '- Логотип Verstak: экран входа, шапка, иконка exe, ярлыки Windows и панель задач.',
      '',
      '### Уведомления',
      '- Тосты Verstak поверх всех окон; системные уведомления Windows отключены.',
      '- В уведомлении отображается название проекта; звук — по настройке Windows.',
      '',
      '### Чат и composer',
      '- Скиллы, ревью, чекпоинт и мультиагент — в меню «Инструменты».',
      '- Единый размер чипов: Инструменты, режим агента, выбор модели.',
      '',
      '### Rail проектов',
      '- При свёрнутой панели группы скрывают вложенные проекты; состояние групп восстанавливается при разворачивании.',
      '',
      '### Обновления',
      '- Сводный список изменений при пропуске нескольких версий с номером и датой каждого релиза.',
    ].join('\n'),
    htmlUrl: 'https://github.com/xRAYNERx/verstak_rayner/releases',
  },
]

function inVersionRange(note: ReleaseNote, since: string, upTo: string): boolean {
  const v = normalizeVersion(note.version)
  return semverGt(v, since) && !semverGt(v, upTo)
}

export function getAllBundledReleaseNotes(): ReleaseNote[] {
  return RAYNER_NOTES.map(note => ({ ...note }))
}

export function getBundledReleaseNote(version: string): ReleaseNote | undefined {
  const key = normalizeVersion(version)
  return RAYNER_NOTES.find(note => normalizeVersion(note.version) === key)
}

export function getBundledReleaseNotesInRange(sinceVersion: string, upToVersion: string): ReleaseNote[] {
  const since = normalizeVersion(sinceVersion)
  const upTo = normalizeVersion(upToVersion)
  return RAYNER_NOTES.filter(note => inVersionRange(note, since, upTo))
}

export function mergeReleaseNotes(github: ReleaseNote[], bundled: ReleaseNote[]): ReleaseNote[] {
  const byVersion = new Map<string, ReleaseNote>()

  for (const note of bundled) {
    byVersion.set(normalizeVersion(note.version), { ...note })
  }

  for (const note of github) {
    const key = normalizeVersion(note.version)
    const prev = byVersion.get(key)
    if (!prev) {
      byVersion.set(key, { ...note })
      continue
    }
    const raynerExtra = prev.body && note.body && !note.body.includes(prev.body.slice(0, 40))
      ? prev.body
      : prev.body && !note.body
        ? prev.body
        : ''
    byVersion.set(key, {
      ...note,
      publishedAt: note.publishedAt ?? prev.publishedAt,
      name: note.name || prev.name,
      body: raynerExtra && note.body
        ? `${note.body}\n\n---\n\n${raynerExtra}`
        : note.body || prev.body,
      htmlUrl: note.htmlUrl || prev.htmlUrl,
    })
  }

  return Array.from(byVersion.values()).sort((a, b) => {
    if (semverGt(a.version, b.version)) return 1
    if (semverGt(b.version, a.version)) return -1
    return 0
  })
}