import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const assetsDir = join(process.cwd(), 'out', 'renderer', 'assets')
const mainChunks = readdirSync(assetsDir)
  .filter(name => /^index-[^.]+\.js$/.test(name))
  .map(name => ({ name, bytes: statSync(join(assetsDir, name)).size }))
  .sort((a, b) => b.bytes - a.bytes)

if (mainChunks.length !== 1) {
  console.error(`[performance-budget] expected one renderer index chunk, found ${mainChunks.length}`)
  process.exit(1)
}

const MAX_MAIN_RENDERER_BYTES = 1_600_000
const main = mainChunks[0]
console.log(`[performance-budget] ${main.name}: ${main.bytes} / ${MAX_MAIN_RENDERER_BYTES} bytes`)

if (main.bytes > MAX_MAIN_RENDERER_BYTES) {
  console.error('[performance-budget] renderer entry exceeded the 2.2 startup budget')
  process.exit(1)
}
