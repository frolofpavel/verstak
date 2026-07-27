/**
 * memory-hooks.ts — автозахват наблюдений из tool calls (AgentMemory-style PostToolUse hooks).
 *
 * После каждого tool call из CAPTURE_TOOLS сжимаем результат в короткое наблюдение
 * и сохраняем в долговременную память проекта — без явного вызова memory_save агентом.
 */

import type { MemoryType } from '../storage/memories'
import { scanText } from './secret-scanner'

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

function isDuplicate(projectPath: string, content: string): boolean {
  // Rolling hash с projectPath в затравке — иначе одинаковая команда в проекте B
  // глушилась бы дедупом проекта A (кросс-проектная потеря авто-захвата, ревью LOW).
  const seed = `${projectPath}\u001F${content}`
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0
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

/** Ключ настройки сырого автозахвата. */
export const AUTO_CAPTURE_SETTING_KEY = 'auto_capture_memory'

/**
 * Включён ли сырой автозахват tool-потока.
 *
 * 2.1.13: ВЫКЛЮЧЕН по умолчанию (opt-in вместо opt-out). Раньше он писал в память
 * строку на каждый write_file/run_command («Записан файл X (123 символов)») — это
 * механика, а не знание: recall зашумлялся, и полезные факты вытеснялись служебными
 * записями. Ту же задачу теперь решает bounded-событие `pre-compress`
 * (ai/memory-lifecycle.ts): один ограниченный batch решений и фактов вместо потока.
 *
 * Механизм намеренно оставлен рабочим за флагом: `auto_capture_memory='true'`
 * возвращает прежнее поведение целиком, без правки кода.
 */
export function isAutoCaptureEnabled(getSecret: ((key: string) => string | null) | undefined): boolean {
  return getSecret?.(AUTO_CAPTURE_SETTING_KEY) === 'true'
}

/**
 * Главная функция — вызывается после каждого tool call.
 * Fire-and-forget: не кидает исключения, не блокирует агентный цикл.
 *
 * @param saveMemory — функция сохранения из ToolContext (обёртка над DB)
 * @param obs — контекст tool call
 * @param isEnabled — значение настройки auto_capture_memory. Механизм opt-in:
 *   по умолчанию ВЫКЛЮЧЕН (решение 2026-07-26), включается явным 'true'.
 */
export function captureToolObservation(
  saveMemory: (projectPath: string, type: string, content: string, tags: string[]) => { id: string },
  obs: ToolObservation,
  isEnabled = true
): void {
  if (!isEnabled) return
  if (!CAPTURE_TOOLS.has(obs.tool)) return

  const raw = compressObservation(obs)
  if (!raw) return
  // Редакция секретов ДО записи (ревью HIGH): команда вида `curl -H 'Authorization: Bearer …'`
  // осела бы в памяти и всплыла в system prompt другого чата/провайдера. Симметрично session-summary.
  const content = scanText(raw).redacted
  if (isDuplicate(obs.projectPath, content)) return

  try {
    saveMemory(obs.projectPath, 'fact' satisfies MemoryType, content, [obs.tool])
  } catch {
    // Не блокируем работу агента если память не записалась
  }
}
