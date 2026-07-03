import { describe, it, expect } from 'vitest'
import { parseSkillDoc } from '../../electron/ai/skills/frontmatter'

describe('parseSkillDoc', () => {
  it('возвращает body как есть если frontmatter отсутствует', () => {
    const doc = parseSkillDoc('# Just markdown\n\nHello world.')
    expect(doc.frontmatter).toEqual({})
    expect(doc.body).toBe('# Just markdown\n\nHello world.')
  })

  it('парсит простые scalar поля', () => {
    const raw = `---
id: code-review
name: Code Review
icon: "🔍"
default_provider: claude
---

Body here.`
    const doc = parseSkillDoc(raw)
    expect(doc.frontmatter.id).toBe('code-review')
    expect(doc.frontmatter.name).toBe('Code Review')
    expect(doc.frontmatter.icon).toBe('🔍')
    expect(doc.frontmatter.default_provider).toBe('claude')
    expect(doc.body).toBe('Body here.')
  })

  it('парсит booleans и numbers', () => {
    const raw = `---
id: x
turns: 8
enabled: true
disabled: false
---
body`
    const doc = parseSkillDoc(raw)
    expect(doc.frontmatter.turns).toBe(8)
    expect(doc.frontmatter.enabled).toBe(true)
    expect(doc.frontmatter.disabled).toBe(false)
  })

  it('парсит inline массив строк', () => {
    const raw = `---
id: x
tools_allow: [gsheets.read, telegram.send]
---
body`
    const doc = parseSkillDoc(raw)
    expect(doc.frontmatter.tools_allow).toEqual(['gsheets.read', 'telegram.send'])
  })

  it('парсит block-style массив строк', () => {
    const raw = `---
id: x
suggested_prompts:
  - Что у меня overdue?
  - Дожми клиента X
  - Утренний пульс
---
body`
    const doc = parseSkillDoc(raw)
    expect(doc.frontmatter.suggested_prompts).toEqual([
      'Что у меня overdue?',
      'Дожми клиента X',
      'Утренний пульс'
    ])
  })

  it('парсит массив объектов (context_loaders)', () => {
    const raw = `---
id: x
context_loaders:
  - id: hh_pulse
    impl: load_hh_pulse
    runs_on: chat_open
  - id: client_card
    impl: load_client_card
    runs_on: slash_arg
---
body`
    const doc = parseSkillDoc(raw)
    const loaders = doc.frontmatter.context_loaders as Array<{ id: string; impl: string; runs_on: string }>
    expect(loaders).toHaveLength(2)
    expect(loaders[0].id).toBe('hh_pulse')
    expect(loaders[0].impl).toBe('load_hh_pulse')
    expect(loaders[0].runs_on).toBe('chat_open')
    expect(loaders[1].id).toBe('client_card')
    expect(loaders[1].runs_on).toBe('slash_arg')
  })

  it('игнорирует комментарии и пустые строки', () => {
    const raw = `---
# Это комментарий
id: x

# ещё один комментарий
name: Test
---
body`
    const doc = parseSkillDoc(raw)
    expect(doc.frontmatter.id).toBe('x')
    expect(doc.frontmatter.name).toBe('Test')
  })

  it('обрабатывает CRLF переводы строк', () => {
    const raw = '---\r\nid: x\r\nname: Test\r\n---\r\nbody'
    const doc = parseSkillDoc(raw)
    expect(doc.frontmatter.id).toBe('x')
    expect(doc.body).toBe('body')
  })

  it('quoted строки сохраняют пробелы и спецсимволы', () => {
    const raw = `---
id: x
description: "Скилл: продажи и реактивация, через @BotFather"
---
body`
    const doc = parseSkillDoc(raw)
    expect(doc.frontmatter.description).toBe('Скилл: продажи и реактивация, через @BotFather')
  })

  // Битый серверный скилл без raw / ошибка чтения файла раньше роняла .match.
  it('не падает на пустом/undefined raw', () => {
    expect(parseSkillDoc('')).toEqual({ frontmatter: {}, body: '' })
    expect(parseSkillDoc(undefined as unknown as string)).toEqual({ frontmatter: {}, body: '' })
  })

  // Этап 4: recipe-блок — вложенный объект с массивами и 2-уровневым verify.commands.
  // Проверяем, что минимальный YAML-парсер тянет нужную глубину.
  it('парсит recipe-блок (вложенный объект + verify.commands)', () => {
    const raw = `---
id: typescript-error
recipe:
  id: typescript-error
  kind: coding
  trigger:
    - typescript error
    - npm run type failed
  read_set:
    - package.json
    - "**/*.ts"
  steps:
    - inspect_error
    - apply_patch
    - run_verify
  verify:
    commands:
      - npm run type
  reviewer:
    required: false
  stop:
    - typecheck_green
---
body`
    const doc = parseSkillDoc(raw)
    const recipe = doc.frontmatter.recipe as {
      id: string; kind: string; trigger: string[]; read_set: string[]
      steps: string[]; verify: { commands: string[] }; reviewer: { required: boolean }; stop: string[]
    }
    expect(recipe.id).toBe('typescript-error')
    expect(recipe.kind).toBe('coding')
    expect(recipe.trigger).toEqual(['typescript error', 'npm run type failed'])
    expect(recipe.read_set).toEqual(['package.json', '**/*.ts'])
    expect(recipe.steps).toEqual(['inspect_error', 'apply_patch', 'run_verify'])
    expect(recipe.verify.commands).toEqual(['npm run type'])
    expect(recipe.reviewer.required).toBe(false)
    expect(recipe.stop).toEqual(['typecheck_green'])
  })
})
