import { describe, it, expect } from 'vitest'
import { tmpdir } from 'os'
import { vi } from 'vitest'

/**
 * Security-guard: unattended NL-cron прогон (runScheduledHeadless) получает
 * ТОЛЬКО read-only инструменты (1.9.7 #8). Регрессия, добавившая мутирующий
 * инструмент в SCHEDULED_READONLY_TOOLS, обязана уронить этот тест — фоновый
 * прогон без надзора не должен писать файлы / выполнять команды / мутировать.
 *
 * ipcMain мокаем — ai.ts тянет его на загрузке модуля.
 */
vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { getPath: () => tmpdir() } }))

const { SCHEDULED_READONLY_TOOLS } = await import('../../electron/ipc/ai')

// Явный список опасных (мутирующих/исполняющих) инструментов, которых НИКОГДА
// не должно быть в unattended-наборе. Сверять с TOOL_DEFS (tools.ts) при
// добавлении новых мутирующих инструментов.
const FORBIDDEN_IN_SCHEDULED = [
  'write_file', 'apply_patch', 'run_command', 'ssh', 'spawn_process',
  'delegate_task', 'delegate_parallel', 'execute_code', 'generate_docx', 'generate_html',
]

describe('SCHEDULED_READONLY_TOOLS — security-guard unattended прогона (1.9.7 #8)', () => {
  it('не содержит ни одного мутирующего/исполняющего инструмента', () => {
    for (const bad of FORBIDDEN_IN_SCHEDULED) {
      expect(SCHEDULED_READONLY_TOOLS, `запрещённый в scheduled: ${bad}`).not.toContain(bad)
    }
  })

  it('не содержит инструмент, оканчивающийся на мутирующий суффикс (_write/_create/_update/_delete/_send)', () => {
    for (const name of SCHEDULED_READONLY_TOOLS) {
      expect(/_(write|create|update|delete|send|exec|run)$/.test(name), name).toBe(false)
    }
  })

  it('не пуст и содержит базовые read-инструменты', () => {
    expect(SCHEDULED_READONLY_TOOLS.length).toBeGreaterThan(0)
    expect(SCHEDULED_READONLY_TOOLS).toContain('read_file')
  })

  it('connector_query разрешён (read-only), но connector-запись — нет', () => {
    expect(SCHEDULED_READONLY_TOOLS).toContain('connector_query')
    // Никаких connector_* кроме query/list (запись коннектора = мутация).
    for (const name of SCHEDULED_READONLY_TOOLS) {
      if (name.startsWith('connector')) {
        expect(['connector_query', 'list_connectors'].includes(name), name).toBe(true)
      }
    }
  })
})
