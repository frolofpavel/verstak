import { useEffect, useState } from 'react'
import { useProject } from '../store/projectStore'

/**
 * Embedded preview pane для артефактов. Открывается из ArtifactsPanel —
 * клик по pill открывает не в браузере, а здесь, прямо в окне.
 *
 * Источник: V3 Plan раздел 8.2.
 *
 * Поддержка:
 *  - HTML — рендерится в iframe srcDoc (без сети, без скриптов снаружи).
 *  - DOCX — конвертация в HTML через mammoth не реализована, fallback к
 *    «открыть в Word» через electron.shell.openPath.
 *  - PDF — то же что DOCX (нет внутреннего pdf.js renderer).
 *
 * UI: модальное окно с заголовком, телом-iframe, действиями
 * (открыть внешне / скачать копию / закрыть).
 */

interface ArtifactRef {
  kind: 'html' | 'docx' | 'verification'
  filename: string
  path: string
  sizeBytes: number
}

interface Props {
  artifact: ArtifactRef | null
  onClose: () => void
}

function artifactFromPath(path: string): ArtifactRef {
  const filename = path.split(/[\\/]/).pop() || path
  const lower = filename.toLowerCase()
  const kind: ArtifactRef['kind'] = lower.endsWith('.docx')
    ? 'docx'
    : lower.endsWith('.verification.html')
      ? 'verification'
      : 'html'
  return {
    kind,
    filename,
    path,
    sizeBytes: 0,
  }
}

export function ArtifactPreview({ artifact, onClose }: Props) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!artifact) { setContent(null); setError(null); return }

    setLoading(true)
    setError(null)
    void (async () => {
      try {
        if (artifact.kind === 'html' || artifact.kind === 'verification') {
          // Verification рендерится той же веткой что html — это самодостаточный
          // .verification.html (renderVerificationHtml). Через files.read —
          // он применяет secret-scanner (избыточно для нашего же артефакта, но безопасно).
          const html = await window.api.files.read(artifact.path)
          setContent(html)
        } else if (artifact.kind === 'docx') {
          // Конвертация в HTML через mammoth.js на стороне main process.
          const res = await window.api.files.docxToHtml(artifact.path)
          if (res.ok) {
            // Оборачиваем body в минимальный document с базовым CSS,
            // чтобы текст выглядел читаемо (mammoth выдаёт чистый body HTML).
            setContent(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                     max-width: 800px; margin: 32px auto; padding: 0 24px; line-height: 1.6; color: #1a1d22; }
              h1 { font-size: 26px; }
              h2 { font-size: 20px; margin-top: 32px; border-bottom: 1px solid #e6e8ec; padding-bottom: 4px; }
              h3 { font-size: 16px; margin-top: 24px; }
              table { border-collapse: collapse; margin: 12px 0; }
              td, th { padding: 6px 12px; border: 1px solid #e6e8ec; }
              code { background: #f5f7fa; padding: 1px 5px; border-radius: 3px; }
              ul, ol { padding-left: 28px; }
              ${res.warnings.length > 0 ? `.gg-warn { background: rgba(215,186,125,0.1); padding: 8px 12px; border-left: 3px solid #d7ba7d; margin-bottom: 16px; font-size: 11px; }` : ''}
            </style></head><body>${
              res.warnings.length > 0
                ? `<div class="gg-warn">⚠ DOCX→HTML конвертация дала ${res.warnings.length} предупреждений (стили могут потеряться). Для финальной отправки используй «↗ Открыть внешне».</div>`
                : ''
            }${res.html}</body></html>`)
          } else {
            setError(res.error)
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    })()
  }, [artifact])

  if (!artifact) return null

  function openExternal() {
    void window.api.files.revealInExplorer(artifact!.path)
  }

  return (
    <div className="gg-artifact-preview-overlay" onClick={onClose}>
      <div className="gg-artifact-preview-modal" onClick={e => e.stopPropagation()}>
        <div className="gg-artifact-preview-header">
          <span className="gg-artifact-preview-title">
            📄 {artifact.filename}
            <span className="gg-artifact-preview-meta">
              {artifact.kind.toUpperCase()} · {(artifact.sizeBytes / 1024).toFixed(1)} KB
            </span>
          </span>
          <div className="gg-artifact-preview-actions">
            <button
              type="button"
              className="gg-btn gg-btn-ghost"
              onClick={openExternal}
              title="Открыть в дефолтном приложении системы"
            >↗ Открыть внешне</button>
            <button type="button" className="gg-btn gg-btn-ghost" onClick={onClose}>Закрыть</button>
          </div>
        </div>

        <div className="gg-artifact-preview-body">
          {loading && <div className="gg-artifact-preview-state">Загрузка…</div>}
          {error && <div className="gg-artifact-preview-state is-error">⚠ {error}</div>}
          {content && (
            <iframe
              className="gg-artifact-preview-iframe"
              srcDoc={content}
              sandbox="allow-same-origin"  // без allow-scripts: безопасный preview
              title={artifact.filename}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Wrapper-хелпер: открыть preview из ArtifactsPanel.
 * Использует state в projectStore чтобы pills могли передать выбранный
 * артефакт без props drilling.
 */
export function ArtifactPreviewContainer() {
  const previewArtifactId = useProject(s => s.previewArtifactId)
  const artifacts = useProject(s => s.artifacts)
  const setPreviewArtifact = useProject(s => s.setPreviewArtifact)

  const artifact = previewArtifactId != null
    ? artifacts.find(a => a.path === previewArtifactId) ?? artifactFromPath(previewArtifactId)
    : null

  return <ArtifactPreview artifact={artifact} onClose={() => setPreviewArtifact(null)} />
}
