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

import { resolve, relative, sep } from 'path'
import { realpath } from 'fs/promises'

/** Textual safety only: blocks `..` traversal. Does NOT catch symlinks. */
export function safeJoin(root: string, rel: string): string {
  const abs = resolve(root, rel)
  const r = relative(root, abs)
  if (r.startsWith('..') || r.includes('..' + sep) || r === '..') {
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
    if (r.startsWith('..') || r.includes('..' + sep) || r === '..') {
      throw new Error(`Запрещён выход за пределы проекта через symlink: ${rel}`)
    }
    return abs
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return abs  // creating a new file is fine
    throw err
  }
}
