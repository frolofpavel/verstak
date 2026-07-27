// Двойная отправка регламента в CLI (спринт 2.3, позиция 2).
//
// Дефект: `cliReadsLayerNatively` была захардкожена в `false`, поэтому Verstak
// ВСЕГДА вкладывал user_layer в payload — включая случай, когда дочерний CLI
// читает тот же файл сам. Механика пропуска в `buildCliPrompt` была построена
// давно (переменные skipUserLayer / nativeLayerHint), не работал только предикат.
//
// ВАЖНО про премису постановки. Заявлено было «CLAUDE.md уезжает дважды». В
// репозитории Verstak это НЕ так: там есть и `AGENTS.md`, и `CLAUDE.md`, а
// `loadUserLayer` берёт первый найденный — то есть инжектится `AGENTS.md`, а CLI
// подхватывает `CLAUDE.md`. Уходят два РАЗНЫХ файла, дубля нет. Настоящий дубль
// возникает в проекте, где `CLAUDE.md` — первый найденный. Поэтому предикат
// смотрит не только на провайдера, но и на путь слоя.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { buildCliPrompt, cliReadsLayerNatively } from '../../electron/ai/cli-prompt'
import type { CliProviderId } from '../../electron/ai/cli-prompt'

const ALL: CliProviderId[] = ['claude-cli', 'gemini-cli', 'grok-cli', 'codex-cli']

// ─────────────────────────────────────────────────────────────────────────────
// Предикат — матрица провайдер × путь слоя. Здесь и живёт риск: мутация
// «вернуть безусловный false» обязана краснеть.
// ─────────────────────────────────────────────────────────────────────────────
describe('cliReadsLayerNatively — матрица', () => {
  it('claude-cli + ровно CLAUDE.md — единственный случай пропуска', () => {
    expect(cliReadsLayerNatively('claude-cli', 'CLAUDE.md')).toBe(true)
  })

  it('остальные провайдеры с тем же CLAUDE.md слой всё равно получают', () => {
    for (const p of ALL.filter(p => p !== 'claude-cli')) {
      expect(cliReadsLayerNatively(p, 'CLAUDE.md'), p).toBe(false)
    }
  })

  it('claude-cli с другим файлом слоя — инжектим, CLI его не читает', () => {
    for (const path of ['AGENTS.md', 'GEMINI.md', '.verstak/RULES.md']) {
      expect(cliReadsLayerNatively('claude-cli', path), path).toBe(false)
    }
  })

  // Склейка с глобальным слоем: payload несёт ещё и ~/.verstak/RULES.md, которых
  // CLI не видит. Пропуск потерял бы их — поэтому сравнение строго точное.
  it('склейка с глобальными правилами пропуску не подлежит', () => {
    expect(cliReadsLayerNatively('claude-cli', '~/.verstak/RULES.md + CLAUDE.md')).toBe(false)
  })

  it('слоя нет вовсе — пропускать нечего', () => {
    for (const p of ALL) expect(cliReadsLayerNatively(p, null), p).toBe(false)
  })

  it('регистр и подпути не считаются совпадением', () => {
    for (const path of ['claude.md', 'CLAUDE.MD', 'docs/CLAUDE.md', 'CLAUDE.md ']) {
      expect(cliReadsLayerNatively('claude-cli', path), path).toBe(false)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Сквозь buildCliPrompt: что реально уезжает в payload.
// ─────────────────────────────────────────────────────────────────────────────
describe('payload: регламент уходит один раз', () => {
  let dir: string
  const MARK = 'МАРКЕР_РЕГЛАМЕНТА_a41f7c'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-layer-'))
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"vitest"}}')
    // Страж окружения: при живом ~/.verstak/RULES.md слой склеивается, путь
    // перестаёт быть ровно 'CLAUDE.md', и пины ниже упадут по чужой причине.
    // Падаем громко и понятно, а не «загадочным красным».
    if (existsSync(join(homedir(), '.verstak', 'RULES.md'))) {
      throw new Error(
        'на машине есть ~/.verstak/RULES.md — слой склеивается с глобальным, ' +
        'и эти пины проверяют не то, что задумано. Так и должно падать: ' +
        'предикат сравнивает путь ТОЧНО.'
      )
    }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const build = (providerId: CliProviderId) => buildCliPrompt({
    providerId, projectPath: dir, messages: [{ role: 'user', content: 'вопрос' }],
  })

  it('claude-cli + только CLAUDE.md: содержимое не дублируется, вместо него пометка', async () => {
    writeFileSync(join(dir, 'CLAUDE.md'), `# Правила\n${MARK}\n`)
    const out = await build('claude-cli')
    expect(out).not.toContain(MARK)
    expect(out).toContain('gg-runtime')
    expect(out).toContain('CLAUDE.md')
    expect(out).not.toContain('<user_layer')
  })

  it('grok-cli + тот же CLAUDE.md: слой по-прежнему инжектится целиком', async () => {
    writeFileSync(join(dir, 'CLAUDE.md'), `# Правила\n${MARK}\n`)
    const out = await build('grok-cli')
    expect(out).toContain(MARK)
    expect(out).toContain('<user_layer')
  })

  it('claude-cli + AGENTS.md: слой инжектится — этот файл CLI не читает', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), `# Правила\n${MARK}\n`)
    const out = await build('claude-cli')
    expect(out).toContain(MARK)
    expect(out).toContain('<user_layer')
  })

  // Ровно расклад репозитория Verstak: лежат оба файла, слой = AGENTS.md.
  it('оба файла в проекте: инжектится AGENTS.md, дубля с CLAUDE.md нет', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), `# Агенты\n${MARK}\n`)
    writeFileSync(join(dir, 'CLAUDE.md'), '# Клод\nМАРКЕР_КЛОД_b52e9d\n')
    const out = await build('claude-cli')
    expect(out).toContain(MARK)
    expect(out).not.toContain('МАРКЕР_КЛОД_b52e9d')
  })

  it('замер: пропуск слоя реально сокращает payload', async () => {
    const big = 'строка регламента, повторяется много раз. '.repeat(400)
    writeFileSync(join(dir, 'CLAUDE.md'), `# Правила\n${big}\n`)
    const withLayer = await build('grok-cli')
    const withoutLayer = await build('claude-cli')
    const saved = withLayer.length - withoutLayer.length
    // Экономия обязана быть соизмерима с размером файла, а не косметической.
    expect(saved).toBeGreaterThan(big.length * 0.9)
  })
})
