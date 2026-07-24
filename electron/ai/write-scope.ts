import { isAbsolute } from 'node:path'

export interface WriteScopeDecision {
  allowed: boolean
  normalizedPath: string | null
  matchedScope: string | null
  reason?: string
}

function normalizeRelative(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/')
  if (!normalized || isAbsolute(normalized) || normalized.startsWith('/')) return null
  const parts = normalized.split('/')
  if (parts.some(part => part === '..' || part === '')) return null
  return parts.filter(part => part !== '.').join('/')
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}

function globRegex(scope: string): RegExp {
  let source = ''
  for (let index = 0; index < scope.length; index++) {
    const char = scope[index]
    if (char === '*' && scope[index + 1] === '*') {
      if (scope[index + 2] === '/') {
        source += '(?:.*/)?'
        index += 2
      } else {
        source += '.*'
        index++
      }
    } else if (char === '*') {
      source += '[^/]*'
    } else {
      source += escapeRegex(char)
    }
  }
  return new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : '')
}

export function decideWriteScope(path: string, writeScope: string[]): WriteScopeDecision {
  const normalizedPath = normalizeRelative(path)
  if (!normalizedPath) {
    return { allowed: false, normalizedPath: null, matchedScope: null, reason: 'Путь записи должен быть относительным и не содержать traversal.' }
  }
  for (const rawScope of writeScope) {
    const scope = normalizeRelative(rawScope)
    if (!scope) continue
    if (scope === '**' || globRegex(scope).test(normalizedPath)) {
      return { allowed: true, normalizedPath, matchedScope: rawScope }
    }
    if (!scope.includes('*') && (normalizedPath === scope || normalizedPath.startsWith(`${scope}/`))) {
      return { allowed: true, normalizedPath, matchedScope: rawScope }
    }
  }
  return {
    allowed: false,
    normalizedPath,
    matchedScope: null,
    reason: writeScope.length === 0
      ? 'Agent Job объявлена read-only: область записи пуста.'
      : `Запись «${normalizedPath}» вне разрешённой области Agent Job.`,
  }
}

export function assertWriteScope(path: string, writeScope: string[]): string {
  const decision = decideWriteScope(path, writeScope)
  if (!decision.allowed || !decision.normalizedPath) throw new Error(decision.reason ?? 'Запись вне write scope.')
  return decision.normalizedPath
}
