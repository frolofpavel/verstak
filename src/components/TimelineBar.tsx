import { useProject } from '../store/projectStore'
import { useActiveChatField } from '../hooks/useActiveChatBundle'
import { ReviewPills } from './ReviewPills'
import { ArtifactsPanel } from './ArtifactsPanel'

/**
 * Подвал чата между потоком и композером.
 *
 * История: с 2026-05-21 (Gemini Ultra audit, idea A) здесь жила лента-«пульс» —
 * чип на каждый tool-вызов текущего хода. В1 (решение Павла 11.08): после
 * появления браузерных событий лента стала дублем карточки «Ход работы»
 * (AgentProgressPanel читает те же события) — рендер чипов активности снят,
 * остаётся только карточка. Данные не тронуты: `activity` по-прежнему пишется
 * в store тем же путём, компонент лишь не рисует её вторым слоем.
 *
 * НЕ дубли — и потому остаются здесь: pills ревью (вход в Explicit Review) и
 * pills артефактов (вход в preview) — другого входа у них нет.
 */

export function TimelineBar() {
  const isStreaming = useActiveChatField('isStreaming') ?? false
  const reviews = useProject(s => s.reviews)
  const artifactsCount = useProject(s => s.artifacts.length)
  const activeChatId = useProject(s => s.activeChatId)

  // Считаем reviews для текущего чата, чтобы понимать показывать ли лейн.
  const reviewCount = activeChatId == null
    ? 0
    : Object.values(reviews).filter(r => r.parentChatId === activeChatId).length

  // В1: активность лейн больше не показывает — рендерим его только ради
  // ревью/артефактов.
  if (reviewCount === 0 && artifactsCount === 0) return null

  return (
    <div className={`gg-timeline ${isStreaming ? 'is-streaming' : ''}`} role="log" aria-label="Ревью и артефакты">
      <ReviewPills />
      <ArtifactsPanel />
    </div>
  )
}
