#!/usr/bin/env node
/**
 * Классификация ABI better_sqlite3.node из ПЛОСКОГО Node-скрипта (release-build и пр.).
 *
 * Тем же способом, что probeBetterSqlite3Node в electron/native-modules.ts, — пробуем
 * ЗАГРУЗИТЬ .node, но в ОТДЕЛЬНОМ процессе (не in-process): иначе dlopen залочил бы файл
 * до выхода текущего процесса, а release-build удаляет свой worktree с этим .node ещё до
 * exit (git worktree remove упал бы на залоченном файле на Windows). Тот же приём, что
 * probeFresh в scripts/safe-rebuild.cjs.
 *
 * Возврат:
 *   - 'node'     — загрузился под ABI текущего Node. В нашем дереве это Node ABI —
 *                  ровно тот битый случай, что уехал в 2.4.5.
 *   - 'electron' — dlopen упал NODE_MODULE_VERSION → собран под ДРУГОЙ ABI; в нашем
 *                  дереве другой бывает только один — Electron. Это годное состояние.
 *   - 'missing'  — файла нет.
 *   - 'unknown'  — упал иначе (повреждён / не тот бинарь) либо процесс не запустился.
 *
 * Гейт-потребитель обязан быть fail-closed: годно ТОЛЬКО 'electron', всё прочее — стоп.
 *
 * exists/run инъектируются для тестов без реального .node.
 */
const { existsSync } = require('fs')
const { spawnSync } = require('child_process')

/**
 * @param {string} nodePath путь к better_sqlite3.node
 * @param {{exists?: (p:string)=>boolean, run?: (p:string)=>{status:number|null, stderr:string}}} [deps]
 * @returns {'node'|'electron'|'missing'|'unknown'}
 */
function classifyBetterSqlite3Abi(nodePath, deps = {}) {
  const exists = deps.exists || existsSync
  const run = deps.run || defaultRun
  if (!exists(nodePath)) return 'missing'
  const r = run(nodePath)
  if (r.status === 0) return 'node'
  if (/NODE_MODULE_VERSION/.test(r.stderr || '')) return 'electron'
  return 'unknown'
}

/** dlopen в дочернем процессе — не лочит файл в вызывающем. */
function defaultRun(nodePath) {
  const res = spawnSync(
    process.execPath,
    ['-e', 'process.dlopen({ exports: {} }, process.argv[1])', nodePath],
    { encoding: 'utf8', timeout: 30000 },
  )
  return { status: res.status, stderr: `${res.stdout || ''}${res.stderr || ''}` }
}

module.exports = { classifyBetterSqlite3Abi }
