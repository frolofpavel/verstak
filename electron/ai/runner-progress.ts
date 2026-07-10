// Эмиссия прогресса агентного прогона (распил ai.ts, 1.9.8 #1, срез 1).
//
// Вынесено из electron/ipc/ai.ts БЕЗ изменения логики: tagSender / progress-
// события / heartbeat ожидания модели. Кластер самодостаточен — не зависит от
// стейта runner'а, только от TaggedSender + PROVIDERS + типов ниже. Покрытие
// поведения — через харнесы agent-loop/plain-loop, которые гоняют реальные runner'ы.

import { PROVIDERS, type ProviderId } from './registry'
import type { TaggedSender } from '../ipc/tool-handlers/shared'

export type { TaggedSender }

export type AgentProgressPhase =
  | 'understand'
  | 'context'
  | 'model'
  | 'reasoning'
  | 'tool'
  | 'command'
  | 'write'
  | 'verify'
  | 'final'

export type AgentProgressStatus = 'pending' | 'running' | 'done' | 'error' | 'blocked'

export interface AgentProgressPayload {
  id?: string
  phase: AgentProgressPhase
  title: string
  detail?: string
  status?: AgentProgressStatus
}

/**
 * Tag every ai:event with the project it belongs to so the renderer can route
 * the update to the correct session (background-agent support).
 */
export function tagSender(sender: Electron.WebContents, projectPath: string | null): TaggedSender {
  return {
    send: (channel: string, payload: { id: number; event: unknown }) => {
      sender.send(channel, { ...payload, projectPath })
    },
    exec: (code: string) => sender.executeJavaScript(code, true)
  }
}

export function compactProgressText(value: unknown, max = 220): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value
    .replace(/```[\s\S]*?```/g, 'фрагмент кода')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return undefined
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean
}

export function modelProgressLabel(providerId?: ProviderId, model?: string | null): string {
  const providerName = providerId ? (PROVIDERS[providerId]?.name ?? providerId) : ''
  return [providerName, model].filter(Boolean).join(' · ') || 'модель'
}

export function emitAgentProgress(sender: TaggedSender, sendId: number, payload: AgentProgressPayload): void {
  try {
    sender.send('ai:event', {
      id: sendId,
      event: {
        type: 'agent-progress',
        id: payload.id,
        phase: payload.phase,
        title: payload.title,
        detail: compactProgressText(payload.detail),
        status: payload.status ?? 'running'
      }
    })
  } catch {
    // Progress telemetry must never break the actual AI response.
  }
}

export function createModelWaitHeartbeat(
  sender: TaggedSender,
  sendId: number,
  opts: { id: string; label: string; detail?: string; intervalMs?: number }
): { stop: (status?: AgentProgressStatus, detail?: string) => void } {
  const startedAt = Date.now()
  const intervalMs = opts.intervalMs ?? 12000
  let stopped = false
  let lastStageKey: string | null = null

  const stageForElapsed = (elapsedSec: number): { key: string; title: string; detail: string; checkpointTitle: string; checkpointDetail: string } => {
    if (elapsedSec < 18) {
      return {
        key: 'accepted',
        title: `${opts.label} анализирует запрос`,
        detail: opts.detail ?? 'Задача и контекст переданы модели. Жду первый видимый фрагмент или служебный сигнал.',
        checkpointTitle: 'Запрос передан модели',
        checkpointDetail: 'Verstak отправил задачу внешнему агенту и держит активный поток.'
      }
    }
    if (elapsedSec < 45) {
      return {
        key: 'forming',
        title: `${opts.label} формирует ответ`,
        detail: `${elapsedSec} сек. Модель работает внутри внешнего агента; Verstak пока не получил новый текст, инструмент или служебный сигнал хода работы.`,
        checkpointTitle: 'Жду первый видимый результат',
        checkpointDetail: 'Модель уже работает, но внешний агент пока не прислал текст, инструмент или понятный промежуточный статус.'
      }
    }
    if (elapsedSec < 90) {
      return {
        key: 'internal',
        title: `${opts.label} выполняет долгий внутренний шаг`,
        detail: `${elapsedSec} сек. Запрос активен. Точные промежуточные действия этот CLI-провайдер сейчас не отдаёт, поэтому показываю честный статус ожидания без засорения ленты.`,
        checkpointTitle: 'Долгий внутренний шаг',
        checkpointDetail: 'Внешний агент молчит дольше обычного, но процесс не закрыт и поток остаётся активным.'
      }
    }
    return {
      key: 'long-wait',
      title: `${opts.label} всё ещё работает`,
      detail: `${elapsedSec} сек. Verstak держит активный поток и ждёт первый видимый результат; если провайдер отдаст текст, служебный ход работы или инструмент, этап сразу сменится.`,
      checkpointTitle: 'Продолжаю ждать внешний агент',
      checkpointDetail: 'Это не новый запрос и не повтор. Verstak удерживает текущую задачу активной до первого результата или ошибки.'
    }
  }

  const tick = () => {
    if (stopped) return
    const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
    const stage = stageForElapsed(elapsedSec)
    if (stage.key !== lastStageKey) {
      lastStageKey = stage.key
      emitAgentProgress(sender, sendId, {
        id: `${opts.id}-stage-${stage.key}`,
        phase: 'model',
        title: stage.checkpointTitle,
        detail: stage.checkpointDetail,
        status: 'done'
      })
    }
    emitAgentProgress(sender, sendId, {
      id: `${opts.id}-wait`,
      phase: 'model',
      title: stage.title,
      detail: stage.detail,
      status: 'running'
    })
  }

  const timer = setInterval(tick, intervalMs)
  tick()

  return {
    stop(status: AgentProgressStatus = 'done', detail?: string) {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      if (detail) {
        emitAgentProgress(sender, sendId, {
          id: `${opts.id}-wait`,
          phase: 'model',
          title: status === 'done' ? `${opts.label} отдал первый сигнал` : `${opts.label}: ожидание завершилось`,
          detail,
          status
        })
      }
    }
  }
}
