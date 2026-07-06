import { useEffect, useRef, useState } from 'react'
import { useProvider, type ProviderId } from '../hooks/useProvider'
import { useProject } from '../store/projectStore'
import type { TierRecommendation as TierRec } from '../types/api'

// Минимальная длина текста задачи, при которой запрашиваем рекомендацию.
// Короткие реплики («да», «ок») не несут сигнала сложности — не дёргаем роутер.
const MIN_INPUT_LEN = 8
const DEBOUNCE_MS = 400

// Человекочитаемая метка тира для pill.
const TIER_LABEL: Record<TierRec['tier'], string> = {
  cheap: 'эконом',
  frontier: 'топ',
  private: 'приватно',
}

interface Props {
  /** Текущий текст в composer — задача, под которую рекомендуем модель. */
  input: string
}

/**
 * Pill с РЕКОМЕНДАЦИЕЙ тира+провайдера+модели под задачу из composer'а.
 * Это рекомендация, НЕ autopilot: переключение происходит только по клику
 * «применить». Источник истины — electron/ai/tier-router.ts (чистая функция),
 * вызывается через window.api.router.recommend.
 */
export function TierRecommendation({ input }: Props) {
  const provider = useProvider()
  const activeChatId = useProject(s => s.activeChatId)
  const refreshChatSessions = useProject(s => s.refreshChatSessions)
  const [rec, setRec] = useState<TierRec | null>(null)

  const trimmed = input.trim()

  // Debounced запрос рекомендации при изменении текста задачи.
  useEffect(() => {
    if (trimmed.length < MIN_INPUT_LEN) {
      setRec(null)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.api.router.recommend(trimmed)
        .then(r => { if (!cancelled) setRec(r) })
        .catch(() => { if (!cancelled) setRec(null) })
    }, DEBOUNCE_MS)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [trimmed])

  // Применяем рекомендацию тем же механизмом, что ModelPicker:
  // setProviderId/setModel (settings model_<id> + provider) + per-chat setModel.
  async function apply() {
    if (!rec) return
    const pid = rec.providerId as ProviderId
    await provider.setProviderModel(pid, rec.model)
    await provider.setProviderId(pid)
    if (activeChatId) {
      try {
        await window.api.chatSessions.setModel(activeChatId, pid, rec.model)
        await refreshChatSessions()
      } catch { /* не блокируем UX при сбое персиста */ }
    }
  }

  if (trimmed.length < MIN_INPUT_LEN || !rec) return null

  const isCurrent = rec.providerId === provider.id && rec.model === provider.model

  return (
    <div className={`gg-tier-rec gg-tools-pill tier-${rec.tier}`} title={rec.reason}>
      <span className="gg-tier-rec-text">
        💡 {TIER_LABEL[rec.tier]} · {shortModel(rec.model)}
      </span>
      {isCurrent ? (
        <span className="gg-tier-rec-ok" title={rec.reason}>✓</span>
      ) : (
        <button
          type="button"
          className="gg-tier-rec-apply"
          onClick={() => void apply()}
          title={rec.reason}
        >применить</button>
      )}
    </div>
  )
}

function shortModel(m: string): string {
  if (m === 'auto') return 'auto'
  const dateMatch = m.match(/(.*)-\d{8}$/)
  if (dateMatch) return dateMatch[1]
  return m
}
