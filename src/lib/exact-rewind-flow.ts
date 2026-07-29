// UI-сценарий Exact Rewind (хвост 2.0.11-F): preflight → execute → unrevert.
// Чистая логика без React: рендерер (ComposerToolsMenu) передаёт window.api-вызовы и
// window.confirm, здесь — только оркестрация и честные тексты. Фича за флагом
// exact_rewind_enabled: disabled на любом шаге → зовущий падает в обычный undo-путь.
import type {
  ExactRewindExecuteSummaryDTO,
  ExactRewindPreflightDTO,
  RewindCoverageDTO,
} from '../types/api'

export interface ExactRewindFlowDeps {
  preflight: (checkpointId: number) => Promise<ExactRewindPreflightDTO>
  execute: (checkpointId: number) => Promise<ExactRewindExecuteSummaryDTO>
  /** Содержимое бэкапов не покидает main (SEC-SECRET-04) — ссылаемся токеном из execute. */
  unrevert: (backupToken: string) => Promise<{ ok: boolean } | { disabled: true }>
  /** Синхронный confirm (window.confirm). Текст формирует сценарий. */
  confirm: (message: string) => boolean
}

export type ExactRewindFlowResult =
  | { kind: 'disabled' }
  | { kind: 'nothing' }
  | { kind: 'cancelled' }
  | { kind: 'done'; restored: number; failed: 0 }
  | { kind: 'done-with-failures'; restored: number; failed: number }
  | { kind: 'reverted-back'; restored: number; failed: number }
  | { kind: 'error'; message: string }

/** Честный текст превью: что откатим и где НЕ обещаем полноту. */
export function buildPreflightMessage(
  files: Array<{ filePath: string; action: 'restore' | 'delete'; stale: boolean }>,
  coverage: RewindCoverageDTO,
): string {
  const toRestore = files.filter(f => f.action === 'restore').length
  const toDelete = files.length - toRestore
  const parts = [
    `Точный откат к чекпоинту: файлов — ${files.length}` +
      `${toRestore > 0 ? `, восстановить ${toRestore}` : ''}` +
      `${toDelete > 0 ? `, удалить созданные ${toDelete}` : ''}.`,
  ]
  if (coverage.level === 'complete') {
    parts.push('Покрытие полное: все правки сессии откатятся.')
  } else {
    if (coverage.hasUntracedWriters) {
      parts.push('Внимание: прогон менял файлы мимо отслеживания (команды/CLI) — эти правки НЕ откатятся.')
    }
    if (coverage.staleFiles > 0) {
      parts.push(`Внимание: ${coverage.staleFiles} файл(ов) перезаписан кем-то после сессии — их текущее содержимое будет перезатёрто откатом.`)
    }
  }
  parts.push('Продолжить?')
  return parts.join('\n')
}

export async function runExactRewindFlow(
  checkpointId: number,
  deps: ExactRewindFlowDeps,
): Promise<ExactRewindFlowResult> {
  const pre = await deps.preflight(checkpointId)
  if ('disabled' in pre && pre.disabled) return { kind: 'disabled' }
  if (!('files' in pre) || pre.files.length === 0) return { kind: 'nothing' }

  if (!deps.confirm(buildPreflightMessage(pre.files, pre.coverage))) return { kind: 'cancelled' }

  const res = await deps.execute(checkpointId)
  if ('disabled' in res) return { kind: 'disabled' } // флаг щёлкнули между шагами
  if ('error' in res) return { kind: 'error', message: res.error }

  if (res.failed.length === 0) return { kind: 'done', restored: res.restored.length, failed: 0 }

  // Частичный сбой: у нас есть бэкапы ДО любой мутации → можем честно «вернуть как было».
  const undoIt = deps.confirm(
    `Не удалось откатить ${res.failed.length} из ${res.restored.length + res.failed.length} файлов ` +
    `(${res.failed.map(f => f.filePath).join(', ')}).\n` +
    'Отменить откат целиком — вернуть всё как было до отката?',
  )
  if (undoIt) {
    await deps.unrevert(res.backupToken)
    return { kind: 'reverted-back', restored: res.restored.length, failed: res.failed.length }
  }
  return { kind: 'done-with-failures', restored: res.restored.length, failed: res.failed.length }
}
