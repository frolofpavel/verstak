// P2 (волна 2.6.0): Verstak собирает черновик правил проекта.
//
// Три пина постановки: черновик на проекте с известным стеком содержит ЕГО
// команды; проект с секретом в .env → секрета в черновике нет; существующий
// файл правил не перезаписывается.
//
// Все кейсы — на НАСТОЯЩЕМ каталоге во временной папке: сборщик читает файлы, и
// мок стерёг бы собственную выдумку вместо чтения.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { collectProjectFacts, buildRulesDraft, draftProjectRules } from '../../electron/ai/project-rules-draft'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'verstak-rules-draft-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const writePkg = (pkg: Record<string, unknown>) =>
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')

describe('P2: факты собираются из файлов, а не выдумываются', () => {
  it('ПИН 1: проект с известным стеком → в черновике ЕГО команды', async () => {
    writePkg({
      name: 'acme-app',
      scripts: { test: 'vitest run', build: 'vite build', lint: 'eslint .', type: 'tsc --noEmit' },
      devDependencies: { typescript: '5', vitest: '2', react: '18' },
    })
    writeFileSync(join(dir, 'tsconfig.json'), '{}', 'utf8')
    mkdirSync(join(dir, 'src'), { recursive: true })

    const draft = await draftProjectRules(dir)

    expect(draft.content).toContain('acme-app')
    expect(draft.content).toContain('npm test')
    expect(draft.content).toContain('npm run build')
    expect(draft.content).toContain('npm run lint')
    expect(draft.content).toContain('npm run type')
    expect(draft.content).toContain('TypeScript')
    expect(draft.content).toContain('Vitest')
    expect(draft.content, 'источники не названы — человек не сможет проверить факты').toContain('package.json')
  })

  it('нестандартное имя скрипта берётся КАК ЕСТЬ, а не подменяется на npm test', async () => {
    writePkg({ name: 'x', scripts: { 'test:fast': 'vitest run' } })

    const facts = await collectProjectFacts(dir)

    expect(facts.commands.test).toBe('npm run test:fast')
  })

  it('ЗЕРКАЛО: тестов нет → так и написано, команда НЕ выдумана', async () => {
    writePkg({ name: 'no-tests', scripts: { build: 'tsc' } })

    const draft = await draftProjectRules(dir)

    expect(draft.content).toContain('тестов не найдено')
    expect(draft.content, 'выдумали npm test, которого в проекте нет').not.toContain('`npm test`')
  })

  it('пустой каталог → честное «определить не удалось», а не пустой шаблон', async () => {
    const draft = await draftProjectRules(dir)

    expect(draft.content).toContain('Определить не удалось')
    expect(draft.content).toContain('Источников не нашлось')
  })
})

describe('P2: секреты и чужие правила', () => {
  it('ПИН 2: секрет из проекта в черновик НЕ попадает', async () => {
    // Секрет кладём туда, откуда сборщик реально читает, — в package.json:
    // .env он не читает вовсе, и пин на .env был бы ложно-зелёным (проверял бы,
    // что мы не печатаем то, что и не собирали).
    writePkg({
      name: 'leaky',
      scripts: { test: 'vitest run' },
      config: { apiKey: 'sk-abcdefghijklmnopqrstuvwxyz012345' },
    })
    writeFileSync(join(dir, '.env'), 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345\n', 'utf8')

    const draft = await draftProjectRules(dir)

    expect(draft.content, 'секрет уехал в черновик правил').not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
  })

  it('КОНТРОЛЬ: сканер не съедает обычный текст черновика', async () => {
    writePkg({ name: 'clean', scripts: { test: 'vitest run' } })
    const draft = await draftProjectRules(dir)
    expect(draft.content).toContain('npm test')
    expect(draft.content).not.toContain('[REDACTED')
  })

  it('ПИН 3: существующий CLAUDE.md распознан, черновик — ПРЕДЛОЖЕНИЕ, не замена', async () => {
    writePkg({ name: 'has-rules', scripts: { test: 'vitest run' } })
    writeFileSync(join(dir, 'CLAUDE.md'), '# Правила, написанные человеком\n', 'utf8')

    const draft = await draftProjectRules(dir)

    expect(draft.facts.existingRulesPath).toBe('CLAUDE.md')
    expect(draft.isProposalToExisting, 'существующие правила приняли за отсутствующие').toBe(true)
    expect(draft.content).toContain('ПРЕДЛОЖЕНИЕ правок')
  })

  it('правил нет → цель по умолчанию .verstak/RULES.md (тот же путь, что читает user-layer)', async () => {
    writePkg({ name: 'fresh', scripts: { test: 'vitest run' } })

    const draft = await draftProjectRules(dir)

    expect(draft.isProposalToExisting).toBe(false)
    expect(draft.targetPath).toBe('.verstak/RULES.md')
  })

  it('приоритет файлов правил тот же, что у читателя (AGENTS выигрывает у CLAUDE)', async () => {
    writePkg({ name: 'both' })
    writeFileSync(join(dir, 'AGENTS.md'), '# A\n', 'utf8')
    writeFileSync(join(dir, 'CLAUDE.md'), '# C\n', 'utf8')

    const facts = await collectProjectFacts(dir)

    expect(facts.existingRulesPath).toBe('AGENTS.md')
  })
})

describe('P2: формат черновика', () => {
  it('разделы на месте и текст читаемый (это файл для человека)', () => {
    const draft = buildRulesDraft({
      name: 'demo', stack: ['TypeScript'],
      commands: { test: 'npm test', build: null, lint: null, typecheck: null },
      topDirs: ['src', 'tests'], existingRulesPath: null, sources: ['package.json'],
    })

    for (const section of ['## Стек', '## Команды', '## Структура', '## Стиль', '## Запреты']) {
      expect(draft).toContain(section)
    }
    expect(draft).toContain('src, tests')
  })
})
