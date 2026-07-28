// Распил ai.ts (2.1.10-F): IPC управления идущим прогоном — стоп, приостановка,
// дописывание контекста и резолв pending-подтверждений (write / command / plan).
//
// Вынесено из registerAiIpc БЕЗ изменения логики. Хендлеры не зависят от deps —
// только от общего pending-реестра (runner-shared) и переданного abortSend, поэтому
// живут отдельным модулем и не тянут за собой ядро ai.ts (иначе был бы рантайм-цикл).
//
// Три резолвера раньше были тремя копиями одного алгоритма: строгий ключ
// `${sendId}::${callId}`, иначе — скан по суффиксу для старого рендерера. Копии
// разъезжались бы независимо; здесь алгоритм ровно один (resolvePending).

import type { IpcMain } from 'electron'
import { pendingWrites, pendingCommands, pendingPlans, scopedKey, suspendedSends } from '../ai/runner-shared'
import { pushConversationSupplement } from '../ai/runner-supplements'

/**
 * Резолв pending-подтверждения. Если рендерер знает sendId (Chat.tsx хранит его после
 * ai:send) — строгий поиск по скоуп-ключу: параллельные прогоны не резолвят чужое.
 * Иначе — обратная совместимость со старыми путями рендерера: скан по суффиксу callId.
 */
function resolvePending<T>(
  map: Map<string, { sendId: number; resolve: (value: T) => void }>,
  callId: string,
  sendId: number | undefined,
  value: T,
): void {
  if (typeof sendId === 'number' && sendId > 0) {
    const key = scopedKey(sendId, callId)
    const exact = map.get(key)
    if (exact) { exact.resolve(value); map.delete(key); return }
  }
  for (const [k, p] of map) {
    if (k.endsWith('::' + callId)) {
      p.resolve(value)
      map.delete(k)
      return
    }
  }
}

/**
 * Регистрирует IPC управления прогоном. abortSend приходит параметром — его ядро
 * (activeAborts + дренаж pending этой сессии) живёт в ipc/ai.ts.
 */
export function registerAiResolveIpc(ipcMain: IpcMain, abortSend: (sendId: number) => boolean): void {
  ipcMain.handle('ai:stop', (_e, sendId: number) => abortSend(sendId))

  // #4 suspend: приостановить прогон = abort, НО прогон помечается 'suspended'
  // (не 'stopped') и чекпойнт сохраняется (он и так держится на abort) → ↻ Продолжить.
  ipcMain.handle('ai:suspend', (_e, sendId: number) => {
    suspendedSends.add(sendId)
    return abortSend(sendId)
  })

  ipcMain.handle('ai:append-context', (_e, sendId: number, text: string) => {
    const trimmed = String(text ?? '').trim()
    if (!trimmed || sendId <= 0) return { ok: false as const, fallback: 'invalid' as const }
    const mode = pushConversationSupplement(sendId, trimmed)
    if (!mode) return { ok: false as const, fallback: 'unavailable' as const }
    return { ok: true as const, mode }
  })

  ipcMain.handle('ai:resolve-write', (_e, callId: string, accept: boolean, sendId?: number) => {
    resolvePending(pendingWrites, callId, sendId, accept)
  })

  ipcMain.handle('ai:resolve-command', (_e, callId: string, accept: boolean, sendId?: number) => {
    resolvePending(pendingCommands, callId, sendId, accept)
  })

  // #3 plan-gate: решение пользователя по предложенному плану (Approve/Revise/Reject).
  // МЁРТВЫЙ КАНАЛ с §10: ожидание живёт снаружи прогона, класть сюда стало некому,
  // и резолв ничего не находит. Живой путь решения — `plans:resolve-approval`.
  ipcMain.handle('ai:resolve-plan', (_e, callId: string, decision: 'approve' | 'revise' | 'reject', feedback?: string, sendId?: number) => {
    resolvePending(pendingPlans, callId, sendId, { decision, feedback })
  })
}
