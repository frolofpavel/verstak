import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'

interface Props {
  children: ReactNode
}

/** Модалки поверх Settings (backdrop-filter ломает position:fixed у вложенных окон). */
export function ModalPortal({ children }: Props) {
  if (typeof document === 'undefined') return null
  return createPortal(children, document.body)
}