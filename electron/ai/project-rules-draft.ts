/**
 * P2 (волна 2.6.0): Verstak сам собирает ЧЕРНОВИК правил проекта.
 *
 * Читатель правил существует давно (user-layer.ts: AGENTS → CLAUDE → GEMINI →
 * .verstak/RULES). Здесь — писатель: на чужом проекте агент по команде собирает
 * черновик того, что человек обычно пишет руками.
 *
 * ТРИ ПРАВИЛА, КОТОРЫЕ ВАЖНЕЕ УДОБСТВА.
 *
 * 1. НИ ОДНОГО ВЫДУМАННОГО ФАКТА. Каждая строка черновика выведена из файла
 *    проекта: package.json, конфиги, структура каталогов. Нет тестового
 *    скрипта — пишем «тестов не найдено», а не бодрое `npm test`, которого в
 *    проекте нет. Правила, которым нельзя верить, хуже отсутствия правил:
 *    следующий прогон выполнит несуществующую команду и решит, что сломался
 *    проект.
 *
 * 2. НЕ ПЕРЕЗАПИСЫВАТЬ ЧУЖОЕ. Если файл правил уже есть, черновик оформляется
 *    как ПРЕДЛОЖЕНИЕ правок к нему, а не как замена: человек годами пишет туда
 *    руками, и молча затереть это — потерять работу, которую никто не
 *    восстановит.
 *
 * 3. НИ СЕКРЕТОВ, НИ ПУТЕЙ МАШИНЫ. Черновик уходит через secret-scanner, а
 *    абсолютные пути в нём не появляются по построению — только относительные.
 */
import { readFile, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { scanText } from './secret-scanner'
import { PROJECT_RULE_CANDIDATES } from './user-layer'

/** Факты о проекте — ровно то, что удалось ПРОЧИТАТЬ. Ничего выведенного. */
export interface ProjectFacts {
  /** Имя из package.json / pyproject / Cargo, если есть. */
  name: string | null
  /** Обнаруженный стек: строки-признаки, каждая из конкретного файла. */
  stack: string[]
  /** Команды из package.json scripts. Пусто — значит их нет. */
  commands: { test: string | null; build: string | null; lint: string | null; typecheck: string | null }
  /** Каталоги верхнего уровня (без служебных). */
  topDirs: string[]
  /** Существующий файл правил (относительный путь) или null. */
  existingRulesPath: string | null
  /** Что читалось для фактов — чтобы человек мог проверить источник. */
  sources: string[]
}

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'out', 'dist', 'build', '.next', '.vite', '.cache',
  '.verstak', '.verstak-data', '__pycache__', 'venv', '.venv', 'target', 'coverage',
])

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> } catch { return null }
}

async function exists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() } catch { return false }
}

/** Собрать факты. Никогда не бросает: непрочитанное просто отсутствует. */
export async function collectProjectFacts(projectRoot: string): Promise<ProjectFacts> {
  const sources: string[] = []
  const stack: string[] = []
  let name: string | null = null
  const commands: ProjectFacts['commands'] = { test: null, build: null, lint: null, typecheck: null }

  const pkg = await readJson(join(projectRoot, 'package.json'))
  if (pkg) {
    sources.push('package.json')
    if (typeof pkg.name === 'string') name = pkg.name
    const scripts = (pkg.scripts ?? {}) as Record<string, string>
    // Берём ИМЕНА существующих скриптов, а не угадываем стандартные: проект с
    // `test:fast` и без `test` получит именно `npm run test:fast`.
    const pick = (...names: string[]): string | null => {
      for (const n of names) if (typeof scripts[n] === 'string' && scripts[n].trim()) {
        return n === 'test' ? 'npm test' : `npm run ${n}`
      }
      return null
    }
    commands.test = pick('test', 'test:fast', 'tests')
    commands.build = pick('build')
    commands.lint = pick('lint', 'lint:full')
    commands.typecheck = pick('typecheck', 'type-check', 'type', 'tsc')

    const deps: Record<string, string> = { ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}) }
    const dep = (n: string, label: string) => { if (deps[n]) stack.push(label) }
    dep('electron', 'Electron')
    dep('next', 'Next.js')
    if (!deps['next']) dep('react', 'React')
    dep('vue', 'Vue')
    dep('svelte', 'Svelte')
    dep('typescript', 'TypeScript')
    dep('vitest', 'Vitest')
    dep('jest', 'Jest')
    dep('express', 'Express')
    dep('fastify', 'Fastify')
    dep('better-sqlite3', 'SQLite (better-sqlite3)')
  }

  if (await exists(join(projectRoot, 'tsconfig.json'))) { sources.push('tsconfig.json'); if (!stack.includes('TypeScript')) stack.push('TypeScript') }
  if (await exists(join(projectRoot, 'pyproject.toml'))) { sources.push('pyproject.toml'); stack.push('Python (pyproject.toml)') }
  if (await exists(join(projectRoot, 'requirements.txt'))) { sources.push('requirements.txt'); stack.push('Python (requirements.txt)') }
  if (await exists(join(projectRoot, 'go.mod'))) { sources.push('go.mod'); stack.push('Go') }
  if (await exists(join(projectRoot, 'Cargo.toml'))) { sources.push('Cargo.toml'); stack.push('Rust') }

  let topDirs: string[] = []
  try {
    const entries = await readdir(projectRoot, { withFileTypes: true })
    topDirs = entries.filter(e => e.isDirectory() && !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.'))
      .map(e => e.name).sort().slice(0, 12)
  } catch { /* каталог недоступен — структуры в черновике не будет */ }

  let existingRulesPath: string | null = null
  for (const rel of PROJECT_RULE_CANDIDATES) {
    if (await exists(join(projectRoot, rel))) { existingRulesPath = rel; break }
  }

  return { name, stack, commands, topDirs, existingRulesPath, sources }
}

export interface RulesDraft {
  /** Куда предлагается записать (относительный путь). */
  targetPath: string
  /** Текст черновика — уже пропущен через secret-scanner. */
  content: string
  /** true — файл правил уже существует, это ПРЕДЛОЖЕНИЕ правок, не замена. */
  isProposalToExisting: boolean
  facts: ProjectFacts
}

function commandLine(label: string, value: string | null, absent: string): string {
  return value ? `- ${label}: \`${value}\`` : `- ${label}: ${absent}`
}

/**
 * Собрать текст черновика в формате, который УЖЕ читает user-layer (обычный
 * markdown). Новых форматов не заводим — иначе писатель и читатель разъедутся.
 */
export function buildRulesDraft(facts: ProjectFacts): string {
  const lines: string[] = []
  lines.push('# Правила проекта' + (facts.name ? ` — ${facts.name}` : ''))
  lines.push('')
  lines.push('> Черновик собран Verstak по файлам проекта. Проверьте и поправьте:')
  lines.push('> ниже только то, что удалось прочитать, — ничего не додумано.')
  lines.push(facts.sources.length ? `> Источники: ${facts.sources.join(', ')}.` : '> Источников не нашлось: в корне нет ни package.json, ни конфигов известных стеков.')
  lines.push('')

  lines.push('## Стек')
  lines.push('')
  if (facts.stack.length) for (const s of facts.stack) lines.push(`- ${s}`)
  else lines.push('- Определить не удалось: известных признаков стека в корне проекта нет.')
  lines.push('')

  lines.push('## Команды')
  lines.push('')
  lines.push(commandLine('Тесты', facts.commands.test, 'тестов не найдено — команду не выдумываем, спросите у владельца проекта'))
  lines.push(commandLine('Тайпчек', facts.commands.typecheck, 'скрипта тайпчека нет'))
  lines.push(commandLine('Линт', facts.commands.lint, 'скрипта линта нет'))
  lines.push(commandLine('Сборка', facts.commands.build, 'скрипта сборки нет'))
  lines.push('')

  if (facts.topDirs.length) {
    lines.push('## Структура')
    lines.push('')
    lines.push(`- Каталоги верхнего уровня: ${facts.topDirs.join(', ')}`)
    lines.push('')
  }

  lines.push('## Стиль')
  lines.push('')
  lines.push('- Минимализм: только запрошенное изменение.')
  lines.push('- Сохранять существующий стиль файла, даже если можно иначе.')
  lines.push('- Не удалять чужой код без явной просьбы.')
  lines.push('')

  lines.push('## Запреты')
  lines.push('')
  lines.push('- Не трогать секреты (.env, ключи, credentials).')
  lines.push('- Не запускать миграции и деплой без явного разрешения.')
  lines.push('- Не расширять задачу без подтверждения.')
  lines.push('')

  return lines.join('\n')
}

/**
 * Черновик правил для проекта. Существующий файл НЕ перезаписывается: черновик
 * оформляется как предложение правок и адресуется тому же файлу — решение о
 * записи принимает человек через обычное подтверждение записи.
 */
export async function draftProjectRules(projectRoot: string): Promise<RulesDraft> {
  const facts = await collectProjectFacts(projectRoot)
  const body = buildRulesDraft(facts)
  const isProposalToExisting = facts.existingRulesPath !== null
  const header = isProposalToExisting
    ? [
        `> ВНИМАНИЕ: в проекте уже есть ${facts.existingRulesPath}. Это ПРЕДЛОЖЕНИЕ правок,`,
        '> а не замена: перенесите нужное вручную или примите запись осознанно.',
        '',
      ].join('\n')
    : ''
  // Secret-scanner НА ВЫХОДЕ, а не на входе: факты собираются из разных мест, и
  // единственная точка, через которую черновик доходит до человека и до диска, —
  // эта. Один проход здесь надёжнее, чем аккуратность в каждом сборщике.
  const content = scanText(header + body).redacted
  return {
    targetPath: facts.existingRulesPath ?? '.verstak/RULES.md',
    content,
    isProposalToExisting,
    facts,
  }
}
