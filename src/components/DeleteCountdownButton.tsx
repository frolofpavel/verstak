import { useEffect, useRef, useState } from 'react'

const HOLD_MS = 5000

interface DeleteCountdownButtonProps {
  label: string
  readyLabel: string
  waitingLabel: (seconds: number) => string
  onActivate: () => void
  disabled?: boolean
  className?: string
}

/**
 * Кнопка опасного действия: при наведении 5 с отсчёта с визуальной полосой,
 * клик возможен только после завершения. Уход курсора сбрасывает таймер.
 */
export function DeleteCountdownButton({
  label,
  readyLabel,
  waitingLabel,
  onActivate,
  disabled = false,
  className = ''
}: DeleteCountdownButtonProps) {
  const [hovering, setHovering] = useState(false)
  const [progress, setProgress] = useState(0)
  const [ready, setReady] = useState(false)
  const [secondsLeft, setSecondsLeft] = useState(5)
  const rafRef = useRef<number | null>(null)
  const startRef = useRef(0)

  useEffect(() => {
    if (!hovering || disabled) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      setProgress(0)
      setReady(false)
      setSecondsLeft(5)
      return
    }

    startRef.current = performance.now()
    setProgress(0)
    setReady(false)
    setSecondsLeft(5)

    const tick = (now: number) => {
      const elapsed = now - startRef.current
      const p = Math.min(1, elapsed / HOLD_MS)
      setProgress(p)
      setSecondsLeft(Math.max(0, Math.ceil((HOLD_MS - elapsed) / 1000)))
      if (p >= 1) {
        setReady(true)
        rafRef.current = null
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [hovering, disabled])

  function handleClick() {
    if (!ready || disabled) return
    onActivate()
  }

  const text = !hovering
    ? label
    : ready
      ? readyLabel
      : waitingLabel(secondsLeft)

  return (
    <button
      type="button"
      className={`gg-delete-countdown-btn ${ready ? 'is-ready' : ''} ${hovering ? 'is-holding' : ''} ${className}`.trim()}
      disabled={disabled || (hovering && !ready)}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onFocus={() => setHovering(true)}
      onBlur={() => setHovering(false)}
      onClick={handleClick}
    >
      <span className="gg-delete-countdown-fill" style={{ transform: `scaleX(${progress})` }} aria-hidden />
      <span className="gg-delete-countdown-text">{text}</span>
    </button>
  )
}