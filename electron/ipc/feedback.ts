import { ipcMain, app } from 'electron'
import { readFileSync, existsSync } from 'fs'
import { release, platform } from 'os'
import type { Feedback } from '../storage/feedback'
import { buildSupportReport, MAX_LOG_LINES } from '../support-report'
import { runtimeLogFiles } from '../runtime-log'

/** Хвост файла журнала: последние строки. Файл может отсутствовать или быть занят —
 *  отчёт обязан собираться и без него, иначе одна беда мешает сообщить о другой. */
function tailLogFile(file: string, lines: number): string[] {
  try {
    if (!existsSync(file)) return []
    const text = readFileSync(file, 'utf8')
    return text.split('\n').filter((l) => l.trim().length > 0).slice(-lines)
  } catch {
    return []
  }
}

export function registerFeedbackIpc(feedback: Feedback): void {
  ipcMain.handle('feedback:list', (_e, projectPath: string | null, limit?: number) => feedback.list(projectPath, limit))
  ipcMain.handle('feedback:submit', (_e, input: { projectPath: string | null; providerId: string | null; rating: number | null; message: string }) =>
    feedback.submit(input)
  )
  ipcMain.handle('feedback:remove', (_e, id: number) => feedback.remove(id))

  // Отчёт о проблеме. НИЧЕГО НЕ ОТПРАВЛЯЕТ — собирает текст и отдаёт renderer'у, чтобы
  // показать человеку целиком. Решение отправить принимает человек (см. support-report.ts).
  ipcMain.handle(
    'feedback:build-report',
    (_e, input: { message: string; rating: number | null; providerId: string | null; model: string | null }): string => {
      const files = runtimeLogFiles()
      // Сначала ошибки — в них причина; добираем обычный журнал, если ошибок мало.
      const errors = tailLogFile(files.errors, MAX_LOG_LINES)
      const runtime = errors.length >= MAX_LOG_LINES ? [] : tailLogFile(files.runtime, MAX_LOG_LINES - errors.length)
      return buildSupportReport({
        message: input.message,
        rating: input.rating,
        appVersion: app.getVersion(),
        platform: platform(),
        osRelease: release(),
        providerId: input.providerId,
        model: input.model,
        now: Date.now(),
        logTail: [...runtime, ...errors]
      })
    }
  )
}
