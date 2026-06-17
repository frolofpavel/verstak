#!/usr/bin/env node
/**
 * BMP-заставка для portable Setup.exe (пока NSIS распаковывает архив).
 */
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'resources', 'installer-splash.bmp')
const ICON = path.join(ROOT, 'resources', 'icon.png')

const W = 480
const H = 300
const BG = { r: 46, g: 52, b: 64 }

function writeBmp24(filePath, width, height, rgbBottomUp) {
  const rowStride = Math.ceil((width * 3) / 4) * 4
  const pixelDataSize = rowStride * height
  const fileSize = 54 + pixelDataSize
  const header = Buffer.alloc(54)
  header.write('BM')
  header.writeUInt32LE(fileSize, 2)
  header.writeUInt32LE(54, 10)
  header.writeUInt32LE(40, 14)
  header.writeInt32LE(width, 18)
  header.writeInt32LE(height, 22)
  header.writeUInt16LE(1, 26)
  header.writeUInt16LE(24, 28)
  header.writeUInt32LE(pixelDataSize, 34)
  fs.writeFileSync(filePath, Buffer.concat([header, rgbBottomUp]))
}

async function main() {
  const bg = await sharp({
    create: { width: W, height: H, channels: 3, background: BG },
  })
    .png()
    .toBuffer()

  const iconSize = 112
  const icon = await sharp(ICON)
    .resize(iconSize, iconSize, { fit: 'contain', background: BG })
    .png()
    .toBuffer()

  const iconLeft = Math.round((W - iconSize) / 2)
  const iconTop = 72

  const composed = await sharp(bg)
    .composite([{ input: icon, left: iconLeft, top: iconTop }])
    .raw()
    .toBuffer({ resolveWithObject: true })

  const { data, info } = composed
  const rowStride = Math.ceil((info.width * 3) / 4) * 4
  const bmpPixels = Buffer.alloc(rowStride * info.height)

  for (let y = 0; y < info.height; y++) {
    const srcY = info.height - 1 - y
    for (let x = 0; x < info.width; x++) {
      const srcIdx = (srcY * info.width + x) * info.channels
      const dstIdx = y * rowStride + x * 3
      bmpPixels[dstIdx] = data[srcIdx + 2]
      bmpPixels[dstIdx + 1] = data[srcIdx + 1]
      bmpPixels[dstIdx + 2] = data[srcIdx]
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  writeBmp24(OUT, info.width, info.height, bmpPixels)
  console.log('OK: installer splash →', OUT)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})