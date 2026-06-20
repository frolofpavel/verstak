import type { StateCreator } from 'zustand'
import type { PipelineRun, PipelineStep } from '../types/api'
import type { ProjectState } from './projectStore'

/**
 * Slice Pipeline Brief→Proof: активный прогон проекта + управление шагами.
 * Вынесен из projectStore (§5 распил). Типизирован над ПОЛНЫМ ProjectState —
 * get()/set() видят весь стор (get().path и т.п.), set() — частичный мерж.
 * import type ProjectState — обратное ребро type-only, без рантайм-цикла.
 */
export interface PipelineSlice {
  /** Pipeline Brief→Proof: активный прогон проекта (баннер по шагам). null если нет.
   *  Заполняется startPipeline / loadActivePipeline, продвигается advancePipeline. */
  activePipeline: PipelineRun | null
  /** Pipeline: сделать прогон активным (после pipeline.start из визарда). */
  startPipeline: (run: PipelineRun) => void
  /** Pipeline: подгрузить активный прогон проекта из БД (resume-баннер). */
  loadActivePipeline: (projectPath: string) => Promise<void>
  /** Pipeline: продвинуть шаг / привязать planId / runId — пишет в БД + стейт. */
  advancePipeline: (patch: { step?: PipelineStep; planId?: number | null; agentRunId?: string | null; chatId?: number | null; verifyAttempts?: number }) => Promise<void>
  /** Pipeline: отменить активный прогон (step='cancelled') + очистить стейт. */
  cancelPipeline: () => Promise<void>
}

export const createPipelineSlice: StateCreator<ProjectState, [], [], PipelineSlice> = (set, get) => ({
  activePipeline: null,
  startPipeline: (run) => set({ activePipeline: run }),
  loadActivePipeline: async (projectPath) => {
    try {
      const run = await window.api.pipeline.getActive(projectPath)
      // Гонка смены проекта: применяем только если проект всё ещё активен.
      if (get().path !== projectPath) return
      set({ activePipeline: run })
    } catch { /* pipeline-баннер не критичен */ }
  },
  advancePipeline: async (patch) => {
    const cur = get().activePipeline
    if (!cur) return
    try {
      const updated = await window.api.pipeline.advance(cur.id, patch)
      // Применяем только если тот же прогон ещё активен (не переключились).
      if (get().activePipeline?.id !== cur.id) return
      // Завершённый/отменённый прогон обнуляем, иначе он висит в activePipeline и
      // скрывает кнопку ▶ Pipeline (она рендерится при !activePipeline). 'blocked'
      // НЕ терминальный — баннер должен оставаться видимым для вмешательства.
      const isTerminal = updated == null || updated.step === 'completed' || updated.step === 'cancelled'
      set({ activePipeline: isTerminal ? null : updated })
    } catch { /* best-effort */ }
  },
  cancelPipeline: async () => {
    const cur = get().activePipeline
    if (!cur) return
    set({ activePipeline: null })
    try { await window.api.pipeline.cancel(cur.id) } catch { /* best-effort */ }
  },
})
