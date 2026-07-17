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

// КРИТИЧНО (инцидент 17.07, linked worktree): git запускает хук с GIT_DIR/GIT_INDEX_FILE
// в окружении; в основном дереве пути ОТНОСИТЕЛЬНЫЕ (безвредны при смене cwd), в linked
// worktree — АБСОЛЮТНЫЕ. Тогда git-операции ТЕСТОВ из временных папок (control-envelope,
// dev-task, worktree-*) бьют в РЕАЛЬНУЮ ветку: фикстурные коммиты «baseline» с calc.mjs
// поверх ветки, чужой индекс, даже core.bare=true у основного репо. Чистим окружение
// хука ДО запуска детей — тесты снова резолвят git по своему cwd, как задумано.
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete process.env[k]

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: process.cwd(), shell: process.platform === 'win32', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

process.stdout.write('[pre-commit] mojibake check... ')
const mojibake = run('npm', ['run', 'check:mojibake'])
if (mojibake.status !== 0) {
  console.error('failed\n[pre-commit] check:mojibake failed - commit blocked.')
  console.error((mojibake.stdout || '') + (mojibake.stderr || ''))
  process.exit(1)
}
console.log('ok')

// 0) lint:changed — гейт по изменённым .ts/.tsx (Фаза 1). Падает только на
//    ESLint-errors (реальные LLM-дефекты из плана §1.2), warnings — ratchet.
//    Быстрый (только staged-файлы), поэтому идёт первым.
process.stdout.write('[pre-commit] lint (изменённые файлы)… ')
const lint = run('npm', ['run', 'lint:changed'])
if (lint.status !== 0) {
  console.error('✖\n[pre-commit] lint провален на изменённых файлах — коммит заблокирован.')
  console.error((lint.stdout || '') + (lint.stderr || ''))
  console.error('[pre-commit] Почини lint-errors, либо обойди осознанно: git commit --no-verify')
  process.exit(1)
}
console.log('✓')

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
