import { useEffect, useRef, useState } from 'react'

type TooltipState = {
  text: string
  x: number
  y: number
  placement: 'top' | 'bottom'
}

const NATIVE_TITLE_ATTR = 'data-gg-native-title'
const SHOW_DELAY_MS = 900

function tooltipSource(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null
  return target.closest<HTMLElement>('[data-tooltip], [title]')
}

function tooltipText(el: HTMLElement): string {
  return (el.getAttribute('data-tooltip') || el.getAttribute(NATIVE_TITLE_ATTR) || '').trim()
}

function convertNativeTitle(el: HTMLElement) {
  const title = el.getAttribute('title')
  if (title == null) return
  const text = title.trim()
  if (text && !el.hasAttribute('data-tooltip')) {
    el.setAttribute('data-tooltip', text)
  }
  if (text && !el.hasAttribute(NATIVE_TITLE_ATTR)) {
    el.setAttribute(NATIVE_TITLE_ATTR, text)
  }
  el.removeAttribute('title')
}

function convertTitlesIn(root: ParentNode) {
  if (root instanceof HTMLElement) convertNativeTitle(root)
  root.querySelectorAll<HTMLElement>('[title]').forEach(convertNativeTitle)
}

function anchorTooltip(el: HTMLElement, text: string): TooltipState {
  const rect = el.getBoundingClientRect()
  const maxX = Math.max(18, window.innerWidth - 18)
  const x = Math.min(maxX, Math.max(18, rect.left + rect.width / 2))
  const bottomY = rect.bottom + 9
  const useTop = bottomY + 92 > window.innerHeight && rect.top > 96

  return {
    text,
    x,
    y: useTop ? rect.top - 9 : bottomY,
    placement: useTop ? 'top' : 'bottom'
  }
}

export function GlobalTooltipHost() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const activeRef = useRef<HTMLElement | null>(null)
  const showTimerRef = useRef<number | null>(null)

  useEffect(() => {
    convertTitlesIn(document)

    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes' && record.target instanceof HTMLElement) {
          convertNativeTitle(record.target)
          continue
        }
        record.addedNodes.forEach(node => {
          if (node instanceof HTMLElement) convertTitlesIn(node)
        })
      }
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['title']
    })

    function clearShowTimer() {
      if (showTimerRef.current != null) {
        window.clearTimeout(showTimerRef.current)
        showTimerRef.current = null
      }
    }

    function clearActive() {
      activeRef.current = null
    }

    function hide() {
      clearShowTimer()
      setTooltip(null)
      clearActive()
    }

    function showFor(el: HTMLElement) {
      convertNativeTitle(el)
      const text = tooltipText(el)
      if (!text) return
      activeRef.current = el

      clearShowTimer()
      showTimerRef.current = window.setTimeout(() => {
        if (activeRef.current === el) setTooltip(anchorTooltip(el, text))
      }, SHOW_DELAY_MS)
    }

    function onEnter(event: PointerEvent | FocusEvent) {
      const el = tooltipSource(event.target)
      if (!el) return
      showFor(el)
    }

    function onLeave(event: PointerEvent | FocusEvent) {
      const active = activeRef.current
      if (!active) return
      const next = 'relatedTarget' in event ? event.relatedTarget : null
      if (next instanceof Node && active.contains(next)) return
      hide()
    }

    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') hide()
    }

    document.addEventListener('pointerover', onEnter, true)
    document.addEventListener('focusin', onEnter, true)
    document.addEventListener('pointerout', onLeave, true)
    document.addEventListener('focusout', onLeave, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)

    return () => {
      observer.disconnect()
      document.removeEventListener('pointerover', onEnter, true)
      document.removeEventListener('focusin', onEnter, true)
      document.removeEventListener('pointerout', onLeave, true)
      document.removeEventListener('focusout', onLeave, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
      hide()
    }
  }, [])

  if (!tooltip) return null

  return (
    <div
      className={`gg-global-tooltip is-${tooltip.placement}`}
      style={{ left: tooltip.x, top: tooltip.y }}
      role="tooltip"
    >
      {tooltip.text}
    </div>
  )
}
