import { describe, expect, it } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { classifyBetterSqlite3Abi } = require('../../scripts/native-abi.cjs')

describe('classifyBetterSqlite3Abi', () => {
  it('missing, когда файла нет', () => {
    expect(classifyBetterSqlite3Abi('/nope.node', { exists: () => false })).toBe('missing')
  })

  it("'node', когда .node грузится в текущем Node-процессе (Node ABI — битый для релиза)", () => {
    expect(
      classifyBetterSqlite3Abi('/x.node', { exists: () => true, run: () => ({ status: 0, stderr: '' }) }),
    ).toBe('node')
  })

  it("'electron', когда dlopen падает NODE_MODULE_VERSION (другой ABI — годный)", () => {
    expect(
      classifyBetterSqlite3Abi('/x.node', {
        exists: () => true,
        run: () => ({
          status: 1,
          stderr:
            'was compiled against a different Node.js version using NODE_MODULE_VERSION 143. requires 137',
        }),
      }),
    ).toBe('electron')
  })

  it("'unknown', когда dlopen падает иначе (повреждён/не тот бинарь) — fail-closed", () => {
    expect(
      classifyBetterSqlite3Abi('/x.node', {
        exists: () => true,
        run: () => ({ status: 1, stderr: 'is not a valid Win32 application' }),
      }),
    ).toBe('unknown')
  })

  it("'unknown', когда дочерний процесс не запустился (status null)", () => {
    expect(
      classifyBetterSqlite3Abi('/x.node', {
        exists: () => true,
        run: () => ({ status: null, stderr: '' }),
      }),
    ).toBe('unknown')
  })
})
