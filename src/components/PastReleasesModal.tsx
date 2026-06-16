import { useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'
import { ReleaseNotesModal, type ReleaseNote } from './ReleaseNotesModal'

function formatReleaseDate(iso: string | undefined): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
  } catch {
    return iso
  }
}

function sortNewestFirst(notes: ReleaseNote[]): ReleaseNote[] {
  return [...notes].sort((a, b) => {
    const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0
    const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0
    if (tb !== ta) return tb - ta
    return b.version.localeCompare(a.version, undefined, { numeric: true })
  })
}

interface Props {
  open: boolean
  onClose: () => void
}

export function PastReleasesModal({ open, onClose }: Props) {
  const t = useT()
  const [loading, setLoading] = useState(false)
  const [releases, setReleases] = useState<ReleaseNote[]>([])
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailNote, setDetailNote] = useState<ReleaseNote | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    void (async () => {
      try {
        const list = await window.api.updater.getReleaseNotes({ all: true })
        if (!alive) return
        setReleases(sortNewestFirst(list))
      } catch {
        if (alive) setReleases([])
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [open])

  const list = useMemo(() => releases, [releases])

  function handleClose() {
    setDetailOpen(false)
    setDetailNote(null)
    onClose()
  }

  async function openRelease(note: ReleaseNote) {
    setDetailNote(note)
    setDetailOpen(true)
    try {
      const fresh = await window.api.updater.getReleaseNotes({ version: note.version })
      if (fresh[0]) setDetailNote(fresh[0])
    } catch { /* keep list copy */ }
  }

  if (!open) return null

  return (
    <>
      {!detailOpen && (
      <div className="gg-modal-backdrop" role="dialog" aria-modal="true">
        <div className="gg-modal gg-modal-large gg-past-releases-modal" onClick={e => e.stopPropagation()}>
          <div className="gg-modal-header">
            <div>
              <div className="gg-modal-title">{t.settings.pastUpdatesTitle}</div>
              <div className="gg-release-notes-subtitle">{t.settings.pastUpdatesHint}</div>
            </div>
            <button
              type="button"
              className="gg-modal-close"
              onClick={handleClose}
              aria-label={t.updates.releaseNotesClose}
            >
              ×
            </button>
          </div>
          <div className="gg-modal-body gg-past-releases-body">
            {loading ? (
              <p className="gg-models-required-text">{t.settings.pastUpdatesLoading}</p>
            ) : list.length === 0 ? (
              <p className="gg-models-required-text">{t.settings.pastUpdatesEmpty}</p>
            ) : (
              <ul className="gg-past-releases-list" role="list">
                {list.map(note => (
                  <li key={`${note.version}-${note.publishedAt ?? ''}`}>
                    <button
                      type="button"
                      className="gg-past-releases-item"
                      onClick={() => void openRelease(note)}
                    >
                      <span className="gg-past-releases-item-main">
                        <span className="gg-past-releases-version">v{note.version}</span>
                        <span className="gg-past-releases-name">{note.name}</span>
                      </span>
                      {note.publishedAt && (
                        <time className="gg-past-releases-date" dateTime={note.publishedAt}>
                          {formatReleaseDate(note.publishedAt)}
                        </time>
                      )}
                      <span className="gg-past-releases-chevron" aria-hidden>›</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="gg-modal-footer">
            <button type="button" className="gg-btn gg-btn-primary" onClick={handleClose}>
              {t.updates.releaseNotesClose}
            </button>
          </div>
        </div>
      </div>
      )}

      <ReleaseNotesModal
        open={detailOpen}
        onClose={() => { setDetailOpen(false); setDetailNote(null) }}
        notes={detailNote ? [detailNote] : []}
        title={detailNote
          ? t.updates.releaseNotesTitleCurrent.replace('{version}', detailNote.version)
          : t.settings.pastUpdatesTitle}
        emptyText={t.settings.releaseNotesEmpty}
        showAllVersionHeaders
      />
    </>
  )
}