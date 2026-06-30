import { useEffect, useMemo, useState } from 'react'
import type { FileNode } from '../types/api'

/**
 * @-mention popup — пикер файлов проекта. Появляется когда в конце композера
 * набирается @токен (в начале строки или после пробела). Выбор вставляет @path.
 *
 * Прозрачный точечный отбор контекста: пользователь сам видит и выбирает, какие
 * файлы уйдут в модель (содержимое подмешивается на отправке через
 * files.resolveMentions). Поверх авто-context-pack, не вместо.
 */

interface Props {
  /** Текущий текст композера. */
  text: string
  /** Путь к проекту (для загрузки дерева файлов). */
  projectPath: string | null
  /** Заменить текст композера (вставка выбранного @path). */
  onReplace: (next: string) => void
}

/** Найти активный @-токен в КОНЦЕ текста (то, что сейчас набирается). null если нет. */
export function activeMentionQuery(text: string): { query: string; start: number } | null {
  const m = text.match(/(?:^|\s)@([A-Za-z0-9._\-/\\]*)$/)
  if (!m) return null
  const query = m[1]
  // start — индекс символа '@' (после ведущего пробела/начала)
  const start = text.length - query.length - 1
  return { query, start }
}

function flattenFiles(nodes: FileNode[], acc: string[], root: string): void {
  for (const n of nodes) {
    if (n.isDirectory) {
      if (n.children) flattenFiles(n.children, acc, root)
    } else {
      // относительный путь от корня проекта, прямые слэши
      const rel = n.path.startsWith(root) ? n.path.slice(root.length).replace(/^[\\/]+/, '') : n.path
      acc.push(rel.replace(/\\/g, '/'))
    }
  }
}

export function MentionPopup({ text, projectPath, onReplace }: Props) {
  const [files, setFiles] = useState<string[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const active = activeMentionQuery(text)
  const isOpen = active !== null && projectPath !== null

  // Грузим плоский список файлов когда popup открывается (один раз на открытие).
  useEffect(() => {
    if (!isOpen || !projectPath) return
    let cancelled = false
    window.api.files.tree(projectPath).then(tree => {
      if (cancelled) return
      const acc: string[] = []
      flattenFiles(tree, acc, projectPath)
      setFiles(acc)
    }).catch(err => console.error('[MentionPopup] files.tree failed:', err))
    return () => { cancelled = true }
  }, [isOpen, projectPath])

  const filtered = useMemo(() => {
    if (!active) return []
    const q = active.query.toLowerCase()
    const matches = q ? files.filter(f => f.toLowerCase().includes(q)) : files
    return matches.slice(0, 12)
  }, [files, active])

  useEffect(() => { setSelectedIdx(0) }, [text])

  useEffect(() => {
    if (!isOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(filtered.length - 1, i + 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(0, i - 1)) }
      else if ((e.key === 'Enter' || e.key === 'Tab') && filtered[selectedIdx]) { e.preventDefault(); pick(filtered[selectedIdx]) }
      // Esc не закрываем жёстко — пользователь может стереть @, и popup сам исчезнет
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, filtered, selectedIdx])

  if (!isOpen || !active || filtered.length === 0) return null

  function pick(path: string) {
    if (!active) return
    // Заменяем активный @query на @path + пробел, сохраняя текст до '@'
    const before = text.slice(0, active.start)
    onReplace(`${before}@${path} `)
  }

  return (
    <div className="gg-slash-popup">
      <div className="gg-slash-header">Файлы в контекст — Enter/Tab вставить, ↑↓ выбор</div>
      {filtered.map((f, i) => (
        <div
          key={f}
          className={`gg-slash-item ${i === selectedIdx ? 'is-selected' : ''}`}
          onMouseEnter={() => setSelectedIdx(i)}
          onClick={() => pick(f)}
        >
          <span className="gg-slash-icon">📄</span>
          <span className="gg-slash-body">
            <span className="gg-slash-name">@{f}</span>
          </span>
        </div>
      ))}
    </div>
  )
}
