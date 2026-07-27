// Декомпозиция Chat.tsx (2.1.11 срез D): панели управления прогоном.
//
// Вынесено из Chat.tsx БЕЗ изменения разметки, классов и порядка узлов — блок
// под потоком: таймлайн активности, pills ревью, баннер pipeline, приёмка
// контракта задачи, модальный визард pipeline, панель «Прогоны» и хост панели
// хода работы.
//
// Перенесён ТОЛЬКО UI-слой. Оркестрация — что делает кнопка, как стартует
// pipeline, как резолвится контракт задачи — осталась в Chat.tsx и приходит
// сюда колбэками. Компонент ничего не решает сам и своего состояния не имеет.
//
// Пропсы намеренно названы теми же именами, что были у переменных замыкания в
// Chat.tsx: так тело JSX переезжает дословно, без единой правки разметки.
// Сетка — tests/components/chat-run-controls-characterization.test.ts.

import { TimelineBar } from '../TimelineBar'
import { ReviewPanel } from '../ReviewPills'
import { PipelineBanner } from '../PipelineBanner'
import { PipelineWizard } from '../PipelineWizard'
import { OutcomeRunsPanel } from '../OutcomeRunsPanel'
import { TaskContractReview } from '../TaskContractReview'
import { AgentProgressPanel } from '../AgentProgressPanel'
import { type AgentProgressEntry } from '../../lib/agent-progress'
import type { PipelineBrief, PipelineMode, PipelineRun, PipelineStep, TaskContractV1 } from '../../types/api'

export interface ChatRunControlsProps {
  isStreaming: boolean
  activePath: string | null
  activeChatId: number | null
  agentProgress: AgentProgressEntry[]
  agentProgressElapsedMs: number | null
  agentProgressDurationMs: number | null
  agentProgressFinishedAt: number | null
  handleAgentProgressToggle: () => void
  onPipelinePrimary: (step: PipelineStep) => Promise<void>
  taskContractReview: TaskContractV1 | null
  approveTaskContract: () => Promise<void>
  refineTaskContract: () => void
  editTaskContractSource: () => Promise<void>
  pipelineWizardOpen: boolean
  pipelineWizardMode: PipelineMode
  pipelineInitialBrief: PipelineBrief | undefined
  setPipelineWizardOpen: (open: boolean) => void
  setPipelineInitialBrief: (brief: PipelineBrief | undefined) => void
  setPipelineWizardMode: (mode: PipelineMode) => void
  onPipelineStarted: (run: PipelineRun) => void
  outcomeRunsOpen: boolean
  setOutcomeRunsOpen: (open: boolean) => void
}

export function ChatRunControls(props: ChatRunControlsProps) {
  const {
    isStreaming, activePath, activeChatId, agentProgress, agentProgressElapsedMs,
    agentProgressDurationMs, agentProgressFinishedAt, handleAgentProgressToggle,
    onPipelinePrimary, taskContractReview, approveTaskContract, refineTaskContract,
    editTaskContractSource, pipelineWizardOpen, pipelineWizardMode, pipelineInitialBrief,
    setPipelineWizardOpen, setPipelineInitialBrief, setPipelineWizardMode,
    onPipelineStarted, outcomeRunsOpen, setOutcomeRunsOpen,
  } = props
  return (
    <>
      <TimelineBar />
      <ReviewPanel />
      <PipelineBanner onPrimary={step => { void onPipelinePrimary(step) }} />
      {taskContractReview && (
        <TaskContractReview
          contract={taskContractReview}
          onApprove={() => void approveTaskContract()}
          onRefine={refineTaskContract}
          onEdit={() => void editTaskContractSource()}
        />
      )}
      {pipelineWizardOpen && (
        <PipelineWizard
          mode={pipelineWizardMode}
          chatId={activeChatId}
          initialBrief={pipelineInitialBrief}
          onClose={() => { setPipelineWizardOpen(false); setPipelineInitialBrief(undefined); setPipelineWizardMode('agency') }}
          onStarted={onPipelineStarted}
        />
      )}
      {outcomeRunsOpen && activePath && (
        <OutcomeRunsPanel projectPath={activePath} onClose={() => setOutcomeRunsOpen(false)} />
      )}

      {isStreaming && agentProgress.length > 0 && (
        <div className="gg-agent-progress-host">
          <AgentProgressPanel
            entries={agentProgress}
            isStreaming={isStreaming}
            elapsedMs={agentProgressElapsedMs}
            durationMs={agentProgressDurationMs}
            finishedAt={agentProgressFinishedAt}
            onToggleOpen={handleAgentProgressToggle}
          />
        </div>
      )}
    </>
  )
}
