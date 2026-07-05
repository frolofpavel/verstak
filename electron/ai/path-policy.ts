/**
 * Shared path-boundary enforcement for all places that resolve filesystem
 * paths relative to a project root.
 *
 * Two layers:
 *   1. safeJoin — textual normalization (resolve + relative). Catches `..`
 *      traversal but NOT symlinks pointing outside the root.
 *   2. safeRealJoin — additionally dereferences symlinks via fs.realpath and
 *      verifies the resolved real path is still inside the resolved real root.
 *
 * The IPC layer (electron/ipc/files.ts) AND the AI tools layer
 * (electron/ai/tools.ts) MUST both use safeRealJoin for any path the
 * renderer or model supplies. Mixing the two is how layered defence leaks.
 */

import { resolve, relative, sep, isAbsolute, dirname, join } from 'path'
import { realpath } from 'fs/promises'
import { realpathSync } from 'fs'
import { homedir } from 'os'

/**
 * True, если target лежит внутри (или совпадает с) одним из knownRoots.
 * Текстовая проверка по образцу resolveSafeTerminalCwd (электрон/ipc/terminal):
 * resolve target, для каждого root считаем relative — «внутри» если путь не
 * выходит наверх (`..`) и не абсолютный (anti drive-bypass на Windows).
 * Используется IPC-хендлерами (files:tree/reveal/docx, project-map), чтобы
 * renderer не дотянулся до файлов вне зарегистрированных проектов.
 */
export function isWithinKnownRoots(target: string, knownRoots: string[]): boolean {
  let abs: string
  try {
    abs = realpathSync(resolve(target))
  } catch {
    try { abs = resolve(target) } catch { return false }
  }
  for (const root of knownRoots) {
    if (!root) continue
    let realRoot: string
    try {
      realRoot = realpathSync(resolve(root))
    } catch {
      try { realRoot = resolve(root) } catch { continue }
    }
    const r = relative(realRoot, abs)
    if (r === '' || (!r.startsWith('..') && !r.includes('..' + sep) && !isAbsolute(r))) return true
  }
  return false
}

/** Textual safety only: blocks `..` traversal. Does NOT catch symlinks. */
export function safeJoin(root: string, rel: string): string {
  const abs = resolve(root, rel)
  const r = relative(root, abs)
  // isAbsolute(r) — Windows drive bypass: relative() между разными дисками
  // (проект на C:\, цель на D:\) возвращает АБСОЛЮТНЫЙ путь, который не
  // начинается с '..'. Без этой проверки агент выходит на любой диск.
  if (r.startsWith('..') || r.includes('..' + sep) || r === '..' || isAbsolute(r)) {
    throw new Error(`Запрещён выход за пределы проекта: ${rel}`)
  }
  return abs
}

/**
 * Symlink-aware: dereferences both the resolved target AND the project root,
 * then verifies the real target is still inside the real root.
 *
 * Falls back to safeJoin (textual) if the path doesn't exist yet (ENOENT) —
 * that's expected when the caller is about to create a new file via
 * write_file. Any other realpath error is rethrown.
 */
export async function safeRealJoin(root: string, rel: string): Promise<string> {
  const abs = safeJoin(root, rel)
  try {
    const realAbs = await realpath(abs)
    let realRoot: string
    try { realRoot = await realpath(root) } catch { realRoot = root }
    const r = relative(realRoot, realAbs)
    if (r.startsWith('..') || r.includes('..' + sep) || r === '..' || isAbsolute(r)) {
      throw new Error(`Запрещён выход за пределы проекта через symlink: ${rel}`)
    }
    return abs
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return abs  // creating a new file is fine
    throw err
  }
}

/**
 * Read-only resolver for explicit external context.
 *
 * Relative paths keep the normal project sandbox. Absolute paths are allowed
 * only for read-only tools; callers must still apply isForbiddenPath/scanText.
 * This lets the user point the agent at an exact outside file/folder without
 * weakening write tools, git, terminal cwd, undo, or project mutation paths.
 */
export async function resolveReadOnlyPath(root: string, userPath: string): Promise<string> {
  if (!isAbsolute(userPath)) return safeRealJoin(root, userPath)

  const abs = resolve(userPath)
  try {
    return await realpath(abs)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return abs
    throw err
  }
}

function isInside(root: string, target: string): boolean {
  const r = relative(root, target)
  return r === '' || (!r.startsWith('..') && !r.includes('..' + sep) && !isAbsolute(r))
}

export function defaultDownloadsDir(): string {
  return join(homedir(), 'Downloads')
}

/**
 * Writable resolver for explicit user exports.
 *
 * Relative paths stay inside the project sandbox. Absolute paths are allowed
 * only inside the user's Downloads directory, so prompts like "положи файл в
 * Downloads" work without opening arbitrary filesystem writes.
 */
export async function resolveWritablePath(
  root: string,
  userPath: string,
  opts?: { downloadsDir?: string }
): Promise<string> {
  if (!isAbsolute(userPath)) return safeRealJoin(root, userPath)

  const target = resolve(userPath)
  const downloads = resolve(opts?.downloadsDir ?? defaultDownloadsDir())
  if (!isInside(downloads, target)) {
    throw new Error(`Абсолютная запись разрешена только в Downloads: ${userPath}`)
  }

  let realDownloads: string
  try { realDownloads = await realpath(downloads) } catch { realDownloads = downloads }

  let probe = target
  while (probe !== dirname(probe)) {
    try {
      const realProbe = await realpath(probe)
      if (!isInside(realDownloads, realProbe)) {
        throw new Error(`Запрещён выход из Downloads через symlink: ${userPath}`)
      }
      break
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') throw err
      probe = dirname(probe)
    }
  }

  return target
}
