#!/usr/bin/env node
/**
 * ЖИВОЙ СМОУК: даёт ли правый клик в поле ключа команду «Вставить» и вставляет
 * ли она содержимое буфера в замаскированное поле.
 *
 * Зачем отдельно от vitest: в jsdom нет ни Chromium, ни события `context-menu`,
 * ни ролей Electron — там нельзя измерить ни `editFlags` замаскированного поля,
 * ни подписи пунктов, ни саму вставку. Поэтому смоук живёт рядом с
 * `smoke:browser-spa` и запускает настоящий Electron.
 *
 * Логика меню берётся ИЗ ПРОДУКТА (`electron/editable-context-menu.ts`,
 * транспиляция esbuild на лету). Копии здесь нет намеренно: копия была бы
 * зелёной при сломанном продукте (CLAUDE.md §3.1). То, что эту же функцию
 * реально зовёт `main.ts` на событии окна, стережёт пин
 * `tests/electron/editable-context-menu.test.ts`.
 *
 * Запуск: npm run smoke:context-menu
 *   PASS — меню на поле построено, «Вставить» доступна, значение буфера
 *          оказалось в поле, поле осталось замаскированным;
 *   FAIL — жалоба @lovelymist воспроизводится.
 * Контрольный случай — правый клик по обычному блоку: там меню строиться НЕ
 * должно, иначе замер ничего не измеряет (§3.1).
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const fixtures = path.join(root, 'scripts', 'fixtures')
const TIMEOUT_MS = 90_000
const CLIPBOARD_VALUE = 'TEST_CLIPBOARD_VALUE'

/** Продуктовая функция меню — из исходника, а не из копии. */
async function buildMenuModule(tmp) {
  const esbuild = await import('esbuild')
  const outfile = path.join(tmp, 'editable-context-menu.cjs')
  await (esbuild.default ?? esbuild).build({
    entryPoints: [path.join(root, 'electron', 'editable-context-menu.ts')],
    outfile, format: 'cjs', platform: 'node', bundle: true, logLevel: 'silent',
  })
  return outfile
}

function runElectron(dir, menuModule) {
  return new Promise((resolve, reject) => {
    const electron = createRequire(path.join(root, 'package.json'))('electron')
    const child = spawn(electron, [dir], {
      env: { ...process.env, SMOKE_MENU_MODULE: menuModule, SMOKE_CLIPBOARD: CLIPBOARD_VALUE },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`смоук не ответил за ${TIMEOUT_MS / 1000} с; вывод:\n${out.slice(-2000)}`))
    }, TIMEOUT_MS)
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    child.on('exit', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const line = out.split(/\r?\n/).find(l => l.startsWith('SMOKE '))
      if (!line) return reject(new Error('нет строки замера SMOKE:\n' + out.slice(0, 2000)))
      try { resolve(JSON.parse(line.slice(6))) } catch (e) { reject(e) }
    })
  })
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vsk-ctxmenu-smoke-'))
  const menuModule = await buildMenuModule(tmp)
  fs.writeFileSync(path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'vsk-ctxmenu-smoke', version: '1.0.0', main: 'smoke-context-menu-main.cjs' }))
  for (const f of ['smoke-context-menu-main.cjs', 'context-menu-host.html']) {
    fs.copyFileSync(path.join(fixtures, f), path.join(tmp, f))
  }

  const r = await runElectron(tmp, menuModule)
  fs.rmSync(tmp, { recursive: true, force: true })

  if (r.error) {
    console.log('НЕВАЛИДНЫЙ ПРОГОН: фикстура упала\n' + r.error)
    process.exit(3)
  }

  console.log('\nЗАМЕР: правый клик в поле ключа (input type=password), буфер = ' + CLIPBOARD_VALUE + '\n')
  console.log('событие на поле:   isEditable=%s, canPaste=%s, canCopy=%s, меню=%s',
    r.field?.isEditable, r.field?.canPaste, r.field?.canCopy, r.field?.hasTemplate ? 'построено' : 'НЕТ')
  console.log('контроль на блоке: isEditable=%s, меню=%s',
    r.plain?.isEditable, r.plain?.hasTemplate ? 'ПОСТРОЕНО (плохо)' : 'не строится')
  console.log('\nпункты меню, как их увидит человек:')
  for (const i of r.labels ?? []) console.log('  %s%s  [%s]', i.label || '—', i.enabled === false ? ' (недоступен)' : '', i.role)
  console.log('\nполе до вставки: «%s»', r.pasted?.before ?? '')
  console.log('поле после «Вставить»: «%s» (тип поля %s)', r.pasted?.after ?? '', r.maskedAfterPaste)
  console.log('')

  if (r.plain?.hasTemplate) {
    console.log('НЕВАЛИДНЫЙ ПРОГОН: меню построилось и на нередактируемом блоке — замер не различает случаи.')
    process.exit(3)
  }
  const paste = (r.labels ?? []).find(i => i.role === 'paste')
  if (!r.field?.hasTemplate || !paste) {
    console.log('FAIL: правый клик в поле ключа не даёт меню с «Вставить» — жалоба @lovelymist воспроизводится.')
    process.exit(1)
  }
  if (paste.enabled === false) {
    console.log('FAIL: пункт «Вставить» есть, но недоступен.')
    process.exit(1)
  }
  if (r.pasted?.after !== CLIPBOARD_VALUE) {
    console.log('FAIL: «Вставить» не положила содержимое буфера в поле.')
    process.exit(1)
  }
  if (r.maskedAfterPaste !== 'password') {
    console.log('FAIL: поле перестало быть замаскированным.')
    process.exit(1)
  }
  console.log(`PASS: меню есть, «${paste.label}» доступна, ключ вставлен в замаскированное поле.`)
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
