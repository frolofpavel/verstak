// Сборка headless-сервиса Verstak под Node (npm run build:headless).
//
// Отдельная от electron-vite сборка: у сервиса другой рантайм (чистый Node, без
// Electron) и другая точка входа (electron/headless/bin.ts). Раньше бандл собирал
// потребитель у себя — две сборки одного кода неизбежно разъезжаются.
//
// Нативное и «тяжёлое опциональное» остаётся external: better-sqlite3 обязан быть
// собран под ABI целевого Node (`npm rebuild better-sqlite3` на сервере), остальное
// ядру Этапа 1 не нужно и тянется, только если инструмент реально вызовут.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [join(root, 'electron', 'headless', 'bin.ts')],
  outfile: join(root, 'out-headless', 'verstak-headless.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  external: [
    'better-sqlite3',
    'electron',
    '@homebridge/node-pty-prebuilt-multiarch',
    '@huggingface/transformers',
    'unpdf',
    'mammoth',
    'exceljs',
    'sharp'
  ],
  logLevel: 'info'
})

console.log('[build:headless] out-headless/verstak-headless.mjs готов')
