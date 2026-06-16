/**
 * Генерирует icon.png, icon.ico из resources/icon-source.png.
 * Исходник: мастер 1024×1024 в resources/icon-source.png
 * Запуск: node scripts/generate-app-icon.mjs  (npm run generate:icon)
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const SOURCE = path.join(ROOT, 'resources', 'icon-source.png')

async function resizePng(size) {
  return sharp(SOURCE)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
}

async function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`[generate-app-icon] Нет ${SOURCE}`)
    process.exit(1)
  }

  const meta = await sharp(SOURCE).metadata()
  console.log(`[generate-app-icon] source ${meta.width}×${meta.height}`)

  const appSizes = [16, 32, 48, 64, 128, 256, 512]
  const pngs = {}
  for (const s of appSizes) pngs[s] = await resizePng(s)

  const resourcesDir = path.join(ROOT, 'resources')
  const assetsDir = path.join(ROOT, 'src', 'assets')
  fs.mkdirSync(resourcesDir, { recursive: true })
  fs.mkdirSync(assetsDir, { recursive: true })

  fs.writeFileSync(path.join(resourcesDir, 'icon.png'), pngs[512])
  fs.writeFileSync(path.join(assetsDir, 'icon.png'), pngs[512])

  const icoSizes = [16, 32, 48, 64, 128, 256]
  const ico = await pngToIco(icoSizes.map(s => pngs[s]))
  fs.writeFileSync(path.join(resourcesDir, 'icon.ico'), ico)

  console.log('OK: resources/icon.png (512), resources/icon.ico, src/assets/icon.png')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})