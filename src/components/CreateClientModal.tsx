import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../i18n'
import { pickProjectColor } from '../lib/project-avatar'
import { ProjectAvatar } from './ProjectAvatar'
import type { ProjectGroup, ProjectMeta } from '../types/api'

type Mode = 'choose' | 'create' | 'open'

interface CreateClientModalProps {
  onClose: () => void
  onOpened: (path: string) => void
  onGroupsChanged?: () => void
}

function slugFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[^a-z]+/, '')
}

export function CreateClientModal({ onClose, onOpened, onGroupsChanged }: CreateClientModalProps) {
  const t = useT()
  const [mode, setMode] = useState<Mode>('choose')
  const [name, setName] = useState('')
  const [folderSlug, setFolderSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [iconPath, setIconPath] = useState<string | null>(null)
  const [clientsRoot, setClientsRoot] = useState('')
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState<number | ''>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  useEffect(() => {
    void window.api.projects.clientsRoot().then(setClientsRoot).catch(() => {})
    void window.api.projects.listGroups().then(setProjectGroups).catch(() => {})
  }, [])

  useEffect(() => {
    if (slugTouched || !name.trim()) return
    setFolderSlug(slugFromName(name))
  }, [name, slugTouched])

  const previewProject = useMemo<Pick<ProjectMeta, 'name' | 'color' | 'iconPath'>>(() => {
    const previewPath = folderSlug.trim() || name.trim() || 'preview'
    return {
      name: name.trim() || t.rail.createPreviewFallback,
      color: pickProjectColor(previewPath),
      iconPath
    }
  }, [name, folderSlug, iconPath, t.rail.createPreviewFallback])

  async function handleOpenExisting() {
    setBusy(true)
    setError(null)
    try {
      const picked = await window.api.projects.pick()
      if (picked) {
        onOpened(picked)
        onClose()
      }
    } finally {
      setBusy(false)
    }
  }

  async function handlePickImage() {
    const picked = await window.api.projects.pickImage()
    if (picked) setIconPath(picked)
  }

  async function handleCreate() {
    const trimmedName = name.trim()
    const trimmedSlug = folderSlug.trim().toLowerCase()
    if (!trimmedName) {
      setError(t.rail.createNameRequired)
      return
    }
    if (!trimmedSlug) {
      setError(t.rail.createSlugRequired)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.projects.create({
        name: trimmedName,
        folderSlug: trimmedSlug,
        iconSourcePath: iconPath
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      if (selectedGroupId !== '') {
        const group = projectGroups.find(g => g.id === selectedGroupId)
        if (group) {
          const groupResult = await window.api.projects.updateGroup(group.id, {
            projectPaths: [...group.projectPaths, result.path]
          })
          if (groupResult.ok) onGroupsChanged?.()
        }
      }
      onOpened(result.path)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className="gg-modal-backdrop" onClick={onClose}>
      <div
        className="gg-modal gg-create-client-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gg-create-client-title"
      >
        <div className="gg-modal-header">
          <div className="gg-modal-title" id="gg-create-client-title">
            {mode === 'choose' ? t.rail.createClient : mode === 'create' ? t.rail.createNewClient : t.rail.openExistingClient}
          </div>
          <button type="button" className="gg-modal-close" onClick={onClose} title={t.rail.close}>×</button>
        </div>

        <div className="gg-modal-body">
          {mode === 'choose' && (
            <div className="gg-create-client-choices">
              <button
                type="button"
                className="gg-create-client-choice"
                onClick={() => setMode('create')}
              >
                <span className="gg-create-client-choice-icon" aria-hidden>+</span>
                <span className="gg-create-client-choice-title">{t.rail.createNewClient}</span>
                <span className="gg-create-client-choice-desc">{t.rail.createNewClientHint}</span>
              </button>
              <button
                type="button"
                className="gg-create-client-choice"
                onClick={() => void handleOpenExisting()}
                disabled={busy}
              >
                <span className="gg-create-client-choice-icon" aria-hidden>
                  <span className="gg-folder-icon" aria-hidden="true" />
                </span>
                <span className="gg-create-client-choice-title">{t.rail.openExistingClient}</span>
                <span className="gg-create-client-choice-desc">{t.rail.openExistingClientHint}</span>
              </button>
            </div>
          )}

          {mode === 'create' && (
            <div className="gg-create-client-form">
              <div className="gg-create-client-preview">
                <ProjectAvatar project={previewProject} className="gg-rail-avatar" size={56} />
                <div className="gg-create-client-preview-text">
                  <div className="gg-create-client-preview-name">{previewProject.name}</div>
                  {folderSlug && <div className="gg-create-client-preview-slug">{folderSlug}</div>}
                </div>
              </div>

              <label className="gg-create-client-field">
                <span className="gg-create-client-label">{t.rail.createNameLabel}</span>
                <input
                  className="gg-input"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder={t.rail.createNamePlaceholder}
                  autoFocus
                />
              </label>

              <label className="gg-create-client-field">
                <span className="gg-create-client-label">{t.rail.createSlugLabel}</span>
                <input
                  className="gg-input gg-input-mono"
                  value={folderSlug}
                  onChange={e => {
                    setSlugTouched(true)
                    setFolderSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))
                  }}
                  placeholder={t.rail.createSlugPlaceholder}
                />
                {clientsRoot && (
                  <span className="gg-create-client-hint">
                    {t.rail.createPathHint.replace('{root}', clientsRoot).replace('{slug}', folderSlug || '…')}
                  </span>
                )}
              </label>

              {projectGroups.length > 0 && (
                <label className="gg-create-client-field">
                  <span className="gg-create-client-label">{t.rail.createGroupLabel}</span>
                  <select
                    className="gg-input gg-create-client-select"
                    value={selectedGroupId === '' ? '' : String(selectedGroupId)}
                    onChange={e => {
                      const v = e.target.value
                      setSelectedGroupId(v === '' ? '' : Number(v))
                    }}
                    disabled={busy}
                  >
                    <option value="">{t.rail.createGroupNone}</option>
                    {projectGroups.map(group => (
                      <option key={group.id} value={group.id}>{group.name}</option>
                    ))}
                  </select>
                </label>
              )}

              <div className="gg-create-client-field">
                <span className="gg-create-client-label">{t.rail.createImageLabel}</span>
                <div className="gg-create-client-image-row">
                  <button type="button" className="gg-btn" onClick={() => void handlePickImage()} disabled={busy}>
                    {iconPath ? t.rail.createImageChange : t.rail.createImagePick}
                  </button>
                  {iconPath && (
                    <button type="button" className="gg-btn gg-btn-ghost" onClick={() => setIconPath(null)} disabled={busy}>
                      {t.rail.createImageClear}
                    </button>
                  )}
                </div>
              </div>

              {error && <div className="gg-create-client-error" role="alert">{error}</div>}
            </div>
          )}
        </div>

        <div className="gg-modal-footer">
          {mode === 'create' ? (
            <>
              <button type="button" className="gg-btn gg-btn-ghost" onClick={() => setMode('choose')} disabled={busy}>
                {t.rail.back}
              </button>
              <button type="button" className="gg-btn gg-btn-primary" onClick={() => void handleCreate()} disabled={busy}>
                {busy ? t.rail.creating : t.rail.createSubmit}
              </button>
            </>
          ) : (
            <button type="button" className="gg-btn gg-btn-ghost" onClick={onClose}>
              {t.rail.close}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
