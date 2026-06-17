/**
 * Вшивает resources/icon.ico в Verstak.exe.
 * Нужно при signAndEditExecutable: false — electron-builder тогда не трогает exe.
 *
 * Хук сборки: afterPack в package.json
 * Вручную: node scripts/patch-exe-icon.cjs [путь/к/Verstak.exe]
 */
const path = require('path')
const fs = require('fs')
const rcedit = require('rcedit')

const WIN_VERSION_STRINGS = {
  FileDescription: 'VERSTAK',
  ProductName: 'VERSTAK',
  InternalName: 'VERSTAK',
  OriginalFilename: 'Verstak.exe',
}

async function patchExeIcon(exePath, icoPath) {
  if (!fs.existsSync(exePath)) {
    throw new Error(`exe not found: ${exePath}`)
  }
  if (!fs.existsSync(icoPath)) {
    throw new Error(`ico not found: ${icoPath}`)
  }
  await rcedit(exePath, {
    icon: icoPath,
    'version-string': WIN_VERSION_STRINGS,
  })
  console.log('OK: icon + metadata →', exePath)
}

/** @param {import('app-builder-lib').AfterPackContext} context */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  if (context.packager.config.appId === 'ru.verstak.installer') return
  const name = context.packager.appInfo.productFilename
  const exe = path.join(context.appOutDir, `${name}.exe`)
  const ico = path.join(context.packager.projectDir, 'resources', 'icon.ico')
  await patchExeIcon(exe, ico)
}

if (require.main === module) {
  const exe = process.argv[2] || path.join(__dirname, '..', 'release', 'win-unpacked', 'Verstak.exe')
  const ico = path.join(__dirname, '..', 'resources', 'icon.ico')
  patchExeIcon(exe, ico).catch(err => {
    console.error(err)
    process.exit(1)
  })
}