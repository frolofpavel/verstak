/**
 * memory-hooks.ts — автозахват наблюдений из tool calls (AgentMemory-style PostToolUse hooks).
 *
 * После каждого tool call из CAPTURE_TOOLS сжимаем результат в короткое наблюдение
 * и сохраняем в долговременную память проекта — без явного вызова memory_save агентом.
 */

import type { MemoryType } from '../storage/memories'

// Какие tool calls захватываем в память
const CAPTURE_TOOLS = new Set([
  'write_file',
  'apply_patch',
  'run_command',
  'check_diagnostics',
  'delegate_task',
  'delegate_parallel',
])

export interface ToolObservation {
  tool: string
  args: Record<string, unknown>
  result: string
  projectPath: string
}

// Сжимает результат tool call в короткое наблюдение для памяти
function compressObservation(obs: ToolObservation): string | null {
  const { tool, args, result } = obs

  switch (tool) {
    case 'write_file':
      return `Записан файл ${String(args.path ?? '')} (${String(args.content ?? '').length} символов)`
    case 'apply_patch':
      return `Применён патч к ${String(args.path ?? '')}`
    case 'run_command': {
      const cmd = String(args.command ?? '').slice(0, 100)
      const exitOk = !result.includes('exit code') || result.includes('exit code 0')
      return `Команда: ${cmd}${exitOk ? '' : ' [ОШИБКА]'}`
    }
    case 'check_diagnostics': {
      const hasErrors = result.includes('error') || result.includes('ошибок') || result.includes('Error')
      return hasErrors ? 'Диагностика: найдены ошибки TypeScript' : 'Диагностика: чисто'
    }
    case 'delegate_task':
      return `Делегирована задача: ${String(args.prompt ?? '').slice(0, 100)}`
    case 'delegate_parallel': {
      const tasks = args.tasks
      const count = Array.isArray(tasks) ? tasks.length : '?'
      return `Параллельные задачи: ${count} штук`
    }
    default:
      return null
  }
}

// Простая дедупликация за окно 5 минут — не записываем одно и то же дважды
const recentHashes = new Map<string, number>() // hash → timestamp
const DEDUP_WINDOW_MS = 5 * 60 * 1000

function isDuplicate(content: string): boolean {
  // Простой rolling hash на основе содержимого
  let h = 0
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) - h + content.charCodeAt(i)) | 0
  }
  const hash = h.toString(36)
  const now = Date.now()

  // Очистка устаревших
  for (const [k, t] of recentHashes) {
    if (now - t > DEDUP_WINDOW_MS) recentHashes.delete(k)
  }

  if (recentHashes.has(hash)) return true
  recentHashes.set(hash, now)
  return false
}

/**
 * Главная функция — вызывается после каждого tool call.
 * Fire-and-forget: не кидает исключения, не блокирует агентный цикл.
 *
 * @param saveMemory — функция сохранения из ToolContext (обёртка над DB)
 * @param obs — контекст tool call
 * @param isEnabled — значение настройки auto_capture_memory (по умолчанию true)
 */
export function captureToolObservation(
  saveMemory: (projectPath: string, type: string, content: string, tags: string[]) => { id: string },
  obs: ToolObservation,
  isEnabled = true
): void {
  if (!isEnabled) return
  if (!CAPTURE_TOOLS.has(obs.tool)) return

  const content = compressObservation(obs)
  if (!content) return
  if (isDuplicate(content)) return

  try {
    saveMemory(obs.projectPath, 'fact' satisfies MemoryType, content, [obs.tool])
  } catch {
    // Не блокируем работу агента если память не записалась
  }
}
