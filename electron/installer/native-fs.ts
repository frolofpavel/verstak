import nodeFs from 'fs'
import nodeFsPromises from 'fs/promises'
import { createRequire } from 'module'

/**
 * Electron patches `fs` so paths ending in `.asar` are treated as virtual archives.
 * The installer copies the application payload itself, so `resources/app.asar`
 * must be handled as a normal file.
 */
function loadNativeFs(): typeof nodeFs {
  try {
    const require = createRequire(import.meta.url)
    return require('original-fs') as typeof nodeFs
  } catch {
    return nodeFs
  }
}

export const nativeFs = loadNativeFs()
export const nativeFsPromises = (nativeFs.promises || nodeFsPromises) as typeof nodeFsPromises
