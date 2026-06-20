import { existsSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'

/** Системный node.exe — не ELECTRON_RUN_AS_NODE (тот ломает распаковку app.asar). */
export function resolveSystemNode(): string | null {
  try {
    const result = spawnSync('where.exe', ['node'], { encoding: 'utf8', windowsHide: true })
    if (result.status === 0 && result.stdout) {
      for (const line of result.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
        // Только настоящий node.exe — отбрасываем .cmd/.bat-врапперы (spawn без shell их не запустит).
        if (line.toLowerCase().endsWith('node.exe') && existsSync(line)) return line
      }
    }
  } catch {
    // ignore
  }

  const candidates = [
    join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}