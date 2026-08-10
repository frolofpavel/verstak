import { describe, expect, it } from 'vitest'
import { createRequire } from 'module'
import { join } from 'path'

const require = createRequire(import.meta.url)
const { extractReleaseNotes, buildReleaseBody } = require('../../scripts/changelog-notes.cjs')

// Класс дефекта: страницы релизов на GitHub стояли ПУСТЫМИ с 2.4.3 по 2.4.9.
// Публикация читала docs/RELEASE-v{version}.md, эти файлы перестали делать после
// v2.4.2, и вместо нот выкладывалась заглушка «Verstak {version}». CHANGELOG при
// этом вёлся исправно — источников было два, и они разъехались.
//
// Дефект прожил семь релизов не потому, что его трудно заметить, а потому что
// заглушка МОЛЧА закрывала дыру (§3.1: у запасного пути обязан быть след).
// Отсюда главное утверждение этой сетки: отсутствие нот обязано быть отличимо
// от нот, а не подменяться правдоподобным текстом.

const CHANGELOG = `# Changelog

## Unreleased

## 2.5.0 - 2026-08-10 (Агент довёл работу до конца)

- **Прогон останавливается, когда работа сделана.** Раньше агент мог продолжить
  работать после выданного ответа.
- **Агент умеет отправить форму.** Enter, Tab, Escape.

## 2.4.9 - 2026-08-10 (Проверка перед словом «готово»)

- **«Написал» перестало значить «сделал».**

## 2.4.8 - 2026-08-09 (Установщик)

- Починен установщик.
`

describe('ноты релиза берутся из CHANGELOG — одного источника', () => {
  it('секция версии извлекается целиком и без соседей', () => {
    const notes = extractReleaseNotes(CHANGELOG, '2.5.0')

    expect(notes).not.toBeNull()
    expect(notes.title).toBe('2.5.0 - 2026-08-10 (Агент довёл работу до конца)')
    expect(notes.body).toContain('Прогон останавливается')
    expect(notes.body).toContain('Enter, Tab, Escape')
    // Соседние версии не должны затекать в тело — иначе на странице релиза
    // окажется история всех прошлых выпусков.
    expect(notes.body).not.toContain('Написал')
    expect(notes.body).not.toContain('Починен установщик')
  })

  it('последняя секция файла не съедает конец, а берётся до конца файла', () => {
    const notes = extractReleaseNotes(CHANGELOG, '2.4.8')

    expect(notes).not.toBeNull()
    expect(notes.body).toBe('- Починен установщик.')
  })

  it('КОНТРОЛЬ: версии нет в CHANGELOG → null, а не выдуманный текст', () => {
    // Именно здесь жил дефект: вместо null публиковалась заглушка «Verstak X».
    expect(extractReleaseNotes(CHANGELOG, '2.6.0')).toBeNull()
  })

  it('КОНТРОЛЬ: секция есть, но пустая → тоже null', () => {
    // «## 2.5.1» без единой строки под ним опубликовал бы пустую страницу —
    // тот же дефект, только в профиль. Пустая секция = нот нет.
    const withEmpty = `# Changelog\n\n## 2.5.1 - 2026-08-12\n\n## 2.5.0 - 2026-08-10\n\n- что-то\n`
    expect(extractReleaseNotes(withEmpty, '2.5.1')).toBeNull()
    expect(extractReleaseNotes(withEmpty, '2.5.0')).not.toBeNull()
  })

  it('КОНТРОЛЬ: «Unreleased» не путается с номером версии', () => {
    expect(extractReleaseNotes(CHANGELOG, 'Unreleased')).toBeNull()
  })

  it('частичное совпадение номера не считается попаданием', () => {
    // «2.5» не должно находить «2.5.0», иначе релиз получит чужие ноты.
    expect(extractReleaseNotes(CHANGELOG, '2.5')).toBeNull()
    expect(extractReleaseNotes(CHANGELOG, '.5.0')).toBeNull()
  })

  it('buildReleaseBody отдаёт готовое тело с заголовком версии', () => {
    const body = buildReleaseBody(join(process.cwd(), 'CHANGELOG.md'), '2.5.0')

    // Проверяем на ЖИВОМ CHANGELOG репозитория, а не только на фикстуре: тест
    // обязан краснеть, если ноты текущей версии забыли написать вовсе.
    expect(body, 'в CHANGELOG нет секции 2.5.0 — публикация выложит пустую страницу').not.toBeNull()
    expect(body.startsWith('## 2.5.0')).toBe(true)
    expect(body.length).toBeGreaterThan(200)
  })

  it('КОНТРОЛЬ: нечитаемый файл → null, а не бросок', () => {
    expect(buildReleaseBody(join(process.cwd(), 'НЕТ-ТАКОГО-ФАЙЛА.md'), '2.5.0')).toBeNull()
  })
})
