import type { ReleaseNote } from './update-remote'
import { normalizeVersion, semverGt } from './update-remote'

/**
 * Встроенные заметки к сборкам Rayner (форк xRAYNERx).
 * Подмешиваются к GitHub Releases, если релиз не опубликован или дополняют upstream.
 */
const RAYNER_NOTES: ReleaseNote[] = [
  {
    version: '1.5.1',
    name: 'Verstak 1.5.1 — сборка Rayner',
    publishedAt: '2026-06-16T12:00:00Z',
    body: [
      '### Окно и брендинг',
      '- Кастомная шапка окна без системной рамки и меню File/Edit',
      '- Логотип Verstak (бело-оранжевая V): экран входа, шапка, иконка exe, ярлыки Windows и панель задач',
      '',
      '### Уведомления',
      '- Свои тосты Verstak поверх всех окон (системные Windows отключены)',
      '- В уведомлении — название проекта крупно; звук Windows по настройке',
      '',
      '### Чат и composer',
      '- Скиллы, ревью, чекпоинт и мультиагент — в меню «Инструменты»',
      '- Единый размер чипов: Инструменты, режим агента, выбор модели',
      '',
      '### Rail проектов',
      '- При свёрнутой панели группы скрывают вложенные проекты; при разворачивании состояние групп восстанавливается',
      '',
      '### Обновления',
      '- После пропуска нескольких версий — один список изменений с номером и датой каждого релиза',
    ].join('\n'),
    htmlUrl: 'https://github.com/xRAYNERx/verstak_rayner/releases',
  },
]

function inVersionRange(note: ReleaseNote, since: string, upTo: string): boolean {
  const v = normalizeVersion(note.version)
  return semverGt(v, since) && !semverGt(upTo, v)
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