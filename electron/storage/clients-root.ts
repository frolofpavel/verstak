import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const RESERVED_SLUGS = new Set(['_template'])

const DEFAULT_AGENTS = `# Клиент: {НАЗВАНИЕ}

Рабочая папка клиента. Задачи без уточнения клиента — для **{slug}**.

| Поле | Значение |
|------|----------|
| slug | \`{slug}\` |
| Директ Client-Login | — |
| Скилл | \`/client-mkt {slug}\` |

## Куда сохранять

- **Логи API, JSON** → \`logs/\`
- **Отчёты для клиента** → \`reports/\`
`

/** Стандартная папка всех клиентов: ~/clients */
export function getClientsRoot(): string {
  return join(homedir(), 'clients')
}

export function normalizeClientFolderSlug(raw: string): string {
  return raw.trim().toLowerCase()
}

export function validateClientFolderSlug(slug: string): string | null {
  if (!slug) return 'Укажите название папки латиницей'
  if (!/^[a-z][a-z0-9_-]*$/.test(slug)) {
    return 'Только латиница: a–z, цифры, дефис и подчёркивание; первый символ — буква'
  }
  if (RESERVED_SLUGS.has(slug)) return 'Это служебное имя папки'
  return null
}

export function scaffoldClientFolder(clientsRoot: string, projectPath: string, displayName: string, slug: string): void {
  mkdirSync(join(projectPath, 'logs'), { recursive: true })
  mkdirSync(join(projectPath, 'reports'), { recursive: true })

  const templatePath = join(clientsRoot, '_template', 'AGENTS.md')
  let content = DEFAULT_AGENTS
  try {
    content = readFileSync(templatePath, 'utf8')
  } catch { /* template optional */ }

  content = content
    .replace(/\{НАЗВАНИЕ\}/g, displayName)
    .replace(/\{slug\}/g, slug)
    .replace(/\{direct_login или —\}/g, '—')

  writeFileSync(join(projectPath, 'AGENTS.md'), content, 'utf8')
}

export function clientFolderExists(clientsRoot: string, slug: string): boolean {
  return existsSync(join(clientsRoot, slug))
}