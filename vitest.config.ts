import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Self-healing ABI better-sqlite3 (Node vs Electron) до старта воркеров.
    globalSetup: ['tests/global-setup.ts'],
    // Снимает протёкшие vi.stubGlobal (fetch) после каждого теста — см. tests/setup.ts.
    setupFiles: ['tests/setup.ts']
  }
})
