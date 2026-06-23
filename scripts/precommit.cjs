#!/usr/bin/env node
/**
 * Pre-commit гейт «гарантия вместо обещания» (skill-архитектура, вариант 2).
 * Блокирует коммит при провале type-check или РЕАЛЬНЫХ падениях тестов. ABI-лок
 * (открыт `npm run dev`) тесты не блокирует — см. scripts/gate-lib.cjs.
 *
 * Мотивация: за сессию 23.06 ручной гейт type+test:fast гоняли десяток раз, а
 * регрессия F2 (коммит «session journal updates» молча убил журнал) — ровно тот
 * класс, что ловит автогейт. Гарантия в коде, не в дисциплине человека.
 *
 * Обойти осознанно: git commit --no-verify
 */
const { spawnSync } = require('child_process')
const { decideTestGate } = require('./gate-lib.cjs')
const { ensureNodeAbi } = require('./safe-rebuild.cjs')

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: process.cwd(), shell: process.platform === 'win32', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

// 1) type-check — ЖЁСТКИЙ гейт.
process.stdout.write('[pre-commit] type-check… ')
const type = run('npm', ['run', 'type'])
if (type.status !== 0) {
  console.error('✖\n[pre-commit] type-check провален — коммит заблокирован.')
  console.error((type.stdout || '') + (type.stderr || ''))
  console.error('[pre-commit] Почини типы, либо обойди осознанно: git commit --no-verify')
  process.exit(1)
}
console.log('✓')

// 2) тесты — блокируют только реальные падения (ABI-шум пропускаем).
process.stdout.write('[pre-commit] тесты (safe-rebuild + vitest)… ')
const abi = ensureNodeAbi({ log: { log: () => {}, warn: () => {} } })
const vitest = run('npx', ['vitest', 'run'])
const out = (vitest.stdout || '') + (vitest.stderr || '')
const gate = decideTestGate({ abiStatus: abi.status, vitestExit: vitest.status, vitestOutput: out })
if (gate.block) {
  console.error('✖\n[pre-commit] ' + gate.reason + ' — коммит заблокирован.')
  console.error(out.split('\n').filter(l => /FAIL|×|AssertionError|Expected|Error:/.test(l)).slice(0, 20).join('\n'))
  console.error('[pre-commit] Почини тесты, либо обойди осознанно: git commit --no-verify')
  process.exit(1)
}
console.log('✓ (' + gate.reason + ')')
process.exit(0)
