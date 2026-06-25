import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import { runLspDiagnostics } from '../../electron/ai/lsp-diagnose'

// T1.1 LIVE-проверка: реальный запуск языкового сервера end-to-end (spawn shell:true
// на Windows → handshake → didOpen → publishDiagnostics → extraction → treeKill).
// Именно этот путь нельзя покрыть юнит-тестом и именно здесь ревью нашло «мёртв на
// Windows». Тяжёлый (спавнит внешний процесс ~сек) → за env-флагом RUN_LSP_IT, чтобы
// pre-commit гейт не тормозить. Запуск: RUN_LSP_IT=1 npx vitest run <этот файл>.

function hasCmd(cmd: string): boolean {
  try { execSync(`where ${cmd}`, { stdio: 'ignore' }); return true } catch { return false }
}

const enabled = process.env.RUN_LSP_IT === '1'
const hasPyright = enabled && hasCmd('pyright-langserver')

describe('runLspDiagnostics — LIVE (нужен языковой сервер + RUN_LSP_IT=1)', () => {
  it.skipIf(!hasPyright)('pyright находит ошибку в Python-файле (end-to-end)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lsp-it-'))
    const file = join(dir, 'broken.py')
    const content = 'def foo():\n    return undefined_variable_xyz\n'
    writeFileSync(file, content)
    const diags = await runLspDiagnostics({ path: file, content, root: dir, timeoutMs: 25000 })
    expect(diags).not.toBeNull()
    expect(diags!.length).toBeGreaterThan(0)
    expect(diags!.some(d => /undefined_variable_xyz|is not defined|not defined/i.test(d.message))).toBe(true)
  }, 30000)

  it.skipIf(!hasPyright)('чистый Python-файл → нет ошибок (null или пусто)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lsp-it-'))
    const file = join(dir, 'ok.py')
    const content = 'def foo() -> int:\n    return 42\n'
    writeFileSync(file, content)
    const diags = await runLspDiagnostics({ path: file, content, root: dir, timeoutMs: 25000 })
    // null (нет publishDiagnostics в окно) или пустой массив — оба «нет ошибок».
    expect(diags === null || diags.length === 0).toBe(true)
  }, 30000)

  // rust-analyzer/gopls end-to-end не тестируем здесь: на машине Pavel rust-analyzer —
  // rustup-прокси без установленного компонента (нужен `rustup component add
  // rust-analyzer`), gopls не установлен. Пайплайн доказан pyright'ом (тот же spawn/
  // handshake/uri/treeKill); graceful-деградация на нерабочем сервере проверена (выход
  // процесса → null, без краша).
})
