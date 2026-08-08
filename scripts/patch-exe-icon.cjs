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
const { classifyBetterSqlite3Abi } = require('./native-abi.cjs')

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
async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const name = context.packager.appInfo.productFilename
  if (context.packager.config.appId === 'ru.verstak.installer') {
    const exe = path.join(context.appOutDir, `${name}.exe`)
    const ico = path.join(context.packager.projectDir, 'resources', 'icon.ico')
    await patchExeIcon(exe, ico)
    return
  }
  const exe = path.join(context.appOutDir, `${name}.exe`)
  const ico = path.join(context.packager.projectDir, 'resources', 'icon.ico')
  await patchExeIcon(exe, ico)
  stageNativeFix(context.appOutDir)
}

/**
 * Кладёт резервную копию better_sqlite3.node в native-fix/ ДЛЯ самопочинки на старте.
 * ГАРД (закрытие класса на корню): «резервная» копия — это копия того же упакованного
 * модуля, поэтому если он вдруг под Node ABI, в native-fix ушёл бы БИТЫЙ бэкап, а
 * самопочинка потом «чинила» бы им рабочую копию. Проверяем годность ИСТОЧНИКА (ABI под
 * Electron) ДО копирования; негоден → сборку валим (не сеем битый бэкап). Классификатор —
 * out-of-process (native-abi.cjs), не лочит .node при упаковке остальных target'ов.
 * deps инъектируются только для тестов.
 */
function stageNativeFix(appOutDir, deps = {}) {
  const exists = deps.exists || fs.existsSync
  const classify = deps.classify || classifyBetterSqlite3Abi
  const mkdir = deps.mkdir || (d => fs.mkdirSync(d, { recursive: true }))
  const copy = deps.copy || fs.copyFileSync
  const src =
    deps.src ||
    path.join(
      appOutDir,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node',
    )
  const destDir = deps.destDir || path.join(appOutDir, 'resources', 'native-fix')
  if (!exists(src)) {
    console.warn('[afterPack] skip native-fix: better_sqlite3.node not found')
    return
  }
  const abi = classify(src)
  if (abi !== 'electron') {
    throw new Error(
      `[afterPack] better_sqlite3.node в app.asar.unpacked под «${abi}» ABI, а не Electron — ` +
        'native-fix стал бы копией битого модуля, а самопочинка «чинила» бы им рабочую копию. Сборка отклонена.',
    )
  }
  mkdir(destDir)
  copy(src, path.join(destDir, 'better_sqlite3.node'))
  console.log('OK: native-fix →', destDir)
}

module.exports = afterPack
module.exports.afterPack = afterPack
module.exports.stageNativeFix = stageNativeFix
module.exports.patchExeIcon = patchExeIcon

if (require.main === module) {
  const exe = process.argv[2] || path.join(__dirname, '..', 'release', 'win-unpacked', 'Verstak.exe')
  const ico = path.join(__dirname, '..', 'resources', 'icon.ico')
  patchExeIcon(exe, ico).catch(err => {
    console.error(err)
    process.exit(1)
  })
}