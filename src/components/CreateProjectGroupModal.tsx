import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../i18n'
import { ProjectAvatar } from './ProjectAvatar'
import type { ProjectGroup, ProjectMeta } from '../types/api'

interface CreateProjectGroupModalProps {
  projects: ProjectMeta[]
  initialGroup?: ProjectGroup | null
  onClose: () => void
  onSaved: () => void
}

export function CreateProjectGroupModal({
  projects,
  initialGroup,
  onClose,
  onSaved
}: CreateProjectGroupModalProps) {
  const t = useT()
  const isEdit = !!initialGroup
  const [name, setName] = useState(initialGroup?.name ?? '')
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialGroup?.projectPaths ?? [])
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [projects]
  )

  function togglePath(path: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  async function handleSave() {
    const trimmed = name.trim()
    if (!trimmed) {
      setError(t.rail.groupNameRequired)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const paths = [...selected]
      const result = isEdit
        ? await window.api.projects.updateGroup(initialGroup!.id, { name: trimmed, projectPaths: paths })
        : await window.api.projects.createGroup(trimmed, paths)
      if (!result.ok) {
        setError(result.error)
        return
      }
      onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    if (!initialGroup) return
    const ok = window.confirm(t.rail.groupDeleteConfirm.replace('{name}', initialGroup.name))
    if (!ok) return
    setBusy(true)
    try {
      await window.api.projects.deleteGroup(initialGroup.id)
      onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className="gg-modal-backdrop" onClick={onClose}>
      <div
        className="gg-modal gg-create-group-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gg-create-group-title"
      >
        <div className="gg-modal-header">
          <div className="gg-modal-title" id="gg-create-group-title">
            {isEdit ? t.rail.editGroup : t.rail.createGroup}
          </div>
          <button type="button" className="gg-modal-close" onClick={onClose} title={t.rail.close}>×</button>
        </div>

        <div className="gg-modal-body">
          <div className="gg-create-group-form">
            <label className="gg-create-client-field">
              <span className="gg-create-client-label">{t.rail.groupNameLabel}</span>
              <input
                className="gg-input"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t.rail.groupNamePlaceholder}
                autoFocus
              />
            </label>

            <div className="gg-create-group-projects">
              <div className="gg-create-group-projects-head">
                <span className="gg-create-client-label">{t.rail.groupProjectsLabel}</span>
                {sortedProjects.length > 0 && (
                  <div className="gg-create-group-bulk">
                    <button
                      type="button"
                      className="gg-btn gg-btn-ghost gg-btn-xs"
                      onClick={() => setSelected(new Set(sortedProjects.map(p => p.path)))}
                      disabled={busy}
                    >
                      {t.rail.groupSelectAll}
                    </button>
                    <button
                      type="button"
                      className="gg-btn gg-btn-ghost gg-btn-xs"
                      onClick={() => setSelected(new Set())}
                      disabled={busy}
                    >
                      {t.rail.groupClearAll}
                    </button>
                  </div>
                )}
              </div>
              <span className="gg-create-client-hint">{t.rail.groupProjectsHint}</span>

              {sortedProjects.length === 0 ? (
                <div className="gg-create-group-empty">{t.rail.groupProjectsEmpty}</div>
              ) : (
                <ul className="gg-create-group-list">
                  {sortedProjects.map(project => {
                    const checked = selected.has(project.path)
                    return (
                      <li key={project.path}>
                        <label className={`gg-create-group-item ${checked ? 'is-checked' : ''}`}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => togglePath(project.path)}
                            disabled={busy}
                          />
                          <ProjectAvatar project={project} className="gg-rail-avatar" size={28} />
                          <span className="gg-create-group-item-text">
                            <span className="gg-create-group-item-name">{project.name}</span>
                          </span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            {error && <div className="gg-create-client-error" role="alert">{error}</div>}
          </div>
        </div>

        <div className="gg-modal-footer">
          {isEdit && (
            <button
              type="button"
              className="gg-btn gg-btn-ghost gg-btn-danger"
              onClick={() => void handleDelete()}
              disabled={busy}
            >
              {t.rail.deleteGroup}
            </button>
          )}
          <span className="gg-modal-footer-spacer" />
          <button type="button" className="gg-btn gg-btn-ghost" onClick={onClose} disabled={busy}>
            {t.rail.close}
          </button>
          <button type="button" className="gg-btn gg-btn-primary" onClick={() => void handleSave()} disabled={busy}>
            {busy ? t.rail.groupCreating : t.rail.groupSave}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}