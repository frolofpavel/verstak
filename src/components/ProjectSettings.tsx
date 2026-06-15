import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useProject } from '../store/projectStore'
import type { ProjectMeta } from '../types/api'
import { ProjectAvatar } from './ProjectAvatar'
import { DeleteCountdownButton } from './DeleteCountdownButton'
import { useT } from '../i18n'

interface ProjectSettingsProps {
  project: ProjectMeta
  onClose: () => void
  onProjectUpdated: (project: ProjectMeta) => void
}

export function ProjectSettings({ project, onClose, onProjectUpdated }: ProjectSettingsProps) {
  const t = useT()
  const { removeProject, setProject, updateProjectMeta, refreshProjectList } = useProject()
  const [displayName, setDisplayName] = useState(project.name)
  const [localProject, setLocalProject] = useState(project)
  const [systemPrompt, setSystemPrompt] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [appearanceSaved, setAppearanceSaved] = useState(false)
  const [iconBusy, setIconBusy] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    setDisplayName(project.name)
    setLocalProject(project)
  }, [project])

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  useEffect(() => {
    void (async () => {
      const val = await window.api.settings.getKey(`system_prompt_${project.path}`) as string | null
      setSystemPrompt(val ?? '')
    })()
  }, [project.path])

  function applyUpdated(next: ProjectMeta) {
    setLocalProject(next)
    setDisplayName(next.name)
    onProjectUpdated(next)
  }

  async function handleSaveAppearance() {
    const trimmed = displayName.trim()
    if (!trimmed) return
    setSaving(true)
    const updated = await updateProjectMeta(project.path, { name: trimmed })
    setSaving(false)
    if (updated) {
      applyUpdated(updated)
      setAppearanceSaved(true)
      setTimeout(() => setAppearanceSaved(false), 2000)
    }
  }

  async function handlePickIcon() {
    setIconBusy(true)
    try {
      const updated = await window.api.projects.pickIcon(project.path)
      if (updated) {
        applyUpdated(updated)
        await refreshProjectList()
      }
    } finally {
      setIconBusy(false)
    }
  }

  async function handleClearIcon() {
    setIconBusy(true)
    try {
      const updated = await window.api.projects.clearIcon(project.path)
      if (updated) {
        applyUpdated(updated)
        await refreshProjectList()
      }
    } finally {
      setIconBusy(false)
    }
  }

  async function handleSavePrompt() {
    setSaving(true)
    await window.api.settings.setKey(`system_prompt_${project.path}`, systemPrompt)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function handleRemoveFromList() {
    const ok = window.confirm(
      t.projectSettings.removeFromListConfirm.replace('{name}', localProject.name)
    )
    if (!ok) return
    const result = await removeProject(project.path)
    if (!result.ok) {
      window.alert(t.projectSettings.deleteFailed.replace('{error}', result.error ?? ''))
      return
    }
    onClose()
  }

  async function handleDeleteWithData() {
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      const result = await removeProject(project.path, { deleteData: true })
      if (!result.ok) {
        setDeleteError(t.projectSettings.deleteFailed.replace('{error}', result.error ?? ''))
        return
      }
      setShowDeleteConfirm(false)
      onClose()
    } finally {
      setDeleteBusy(false)
    }
  }

  return createPortal(
    <>
    <div className="gg-modal-backdrop" onClick={onClose}>
      <div
        className="gg-project-settings"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gg-ps-title"
      >
        <div className="gg-ps-header">
          <div className="gg-ps-title" id="gg-ps-title">
            <ProjectAvatar project={localProject} className="gg-ps-header-avatar" size={28} />
            <span>{localProject.name}</span>
          </div>
          <button className="gg-ps-close" onClick={onClose} title="Закрыть">×</button>
        </div>

        <div className="gg-ps-body">
          <section className="gg-ps-section">
            <div className="gg-ps-section-label">Отображение в списке</div>
            <div className="gg-ps-appearance">
              <div className="gg-ps-appearance-preview">
                <ProjectAvatar project={{ ...localProject, name: displayName || localProject.name }} className="gg-ps-icon-preview" size={64} />
              </div>
              <div className="gg-ps-appearance-fields">
                <label className="gg-ps-field-label" htmlFor="gg-ps-display-name">Название проекта</label>
                <input
                  id="gg-ps-display-name"
                  className="gg-input"
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  placeholder="Любое имя — не связано с папкой на диске"
                  maxLength={80}
                />
                <div className="gg-ps-appearance-actions">
                  <button
                    type="button"
                    className={`gg-ps-save-btn ${appearanceSaved ? 'is-saved' : ''}`}
                    onClick={() => void handleSaveAppearance()}
                    disabled={saving || !displayName.trim() || displayName.trim() === localProject.name}
                  >
                    {appearanceSaved ? '✓ Сохранено' : 'Сохранить название'}
                  </button>
                </div>
                <div className="gg-ps-icon-actions">
                  <button type="button" className="gg-ps-action-btn" onClick={() => void handlePickIcon()} disabled={iconBusy}>
                    {iconBusy ? 'Загрузка…' : 'Выбрать изображение'}
                  </button>
                  {localProject.iconPath && (
                    <button type="button" className="gg-btn gg-btn-ghost" onClick={() => void handleClearIcon()} disabled={iconBusy}>
                      Убрать иконку
                    </button>
                  )}
                </div>
                <div className="gg-settings-hint">PNG, JPG, WebP и др. Сохраняется в профиле Verstak — папку на диске не переименовывает.</div>
              </div>
            </div>
          </section>

          <section className="gg-ps-section">
            <div className="gg-ps-section-label">Папка на диске</div>
            <div className="gg-ps-path">
              <span className="gg-ps-path-icon">📁</span>
              <span className="gg-ps-path-text" title={project.path}>{project.path}</span>
              <button
                className="gg-ps-path-open"
                onClick={() => void window.api.files.revealInExplorer?.(project.path).catch(() => {})}
                title="Открыть в проводнике"
              >↗</button>
            </div>
          </section>

          <section className="gg-ps-section">
            <div className="gg-ps-section-label">
              Системный промпт проекта
              <span className="gg-ps-section-hint">Добавляется к каждому чату в этом проекте</span>
            </div>
            <textarea
              className="gg-ps-textarea"
              placeholder="Например: Ты работаешь с проектом на TypeScript + React. Всегда используй строгую типизацию..."
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              rows={6}
            />
            <div className="gg-ps-textarea-actions">
              <span className="gg-ps-char-count">{systemPrompt.length} символов</span>
              <button
                className={`gg-ps-save-btn ${saved ? 'is-saved' : ''}`}
                onClick={() => void handleSavePrompt()}
                disabled={saving}
              >
                {saved ? '✓ Сохранено' : saving ? 'Сохраняю…' : 'Сохранить'}
              </button>
            </div>
          </section>

          <section className="gg-ps-section">
            <div className="gg-ps-section-label">Быстрые действия</div>
            <div className="gg-ps-actions">
              <button
                className="gg-ps-action-btn"
                onClick={() => { void setProject(project.path); onClose() }}
              >
                Открыть проект
              </button>
            </div>
          </section>

          <section className="gg-ps-section gg-ps-danger-zone">
            <div className="gg-ps-section-label gg-ps-danger-label">Удаление клиента</div>

            <div className="gg-ps-danger-row gg-ps-danger-row-stack">
              <div>
                <div className="gg-ps-danger-title">{t.projectSettings.removeFromList}</div>
                <div className="gg-ps-danger-desc">{t.projectSettings.removeFromListDesc}</div>
              </div>
              <button type="button" className="gg-ps-action-btn gg-ps-remove-list-btn" onClick={() => void handleRemoveFromList()}>
                {t.projectSettings.removeFromList}
              </button>
            </div>

            <div className="gg-ps-danger-row gg-ps-danger-row-stack gg-ps-danger-row-separated">
              <div>
                <div className="gg-ps-danger-title">{t.projectSettings.deleteWithData}</div>
                <div className="gg-ps-danger-desc">{t.projectSettings.deleteWithDataDesc}</div>
              </div>
              <DeleteCountdownButton
                className="gg-ps-danger-btn"
                label={t.projectSettings.deleteWithData}
                readyLabel={t.projectSettings.deleteWithDataReady}
                waitingLabel={sec => t.projectSettings.deleteWithDataHold.replace('{seconds}', String(sec))}
                onActivate={() => setShowDeleteConfirm(true)}
                disabled={deleteBusy}
              />
            </div>
          </section>
        </div>
      </div>
    </div>

    {showDeleteConfirm && (
      <div className="gg-modal-backdrop gg-delete-confirm-backdrop" onClick={() => setShowDeleteConfirm(false)}>
        <div className="gg-modal gg-delete-client-confirm" onClick={e => e.stopPropagation()} role="alertdialog" aria-modal="true">
          <div className="gg-modal-header">
            <div className="gg-modal-title">{t.projectSettings.deleteConfirmTitle}</div>
            <button type="button" className="gg-modal-close" onClick={() => setShowDeleteConfirm(false)}>×</button>
          </div>
          <div className="gg-modal-body">
            <p className="gg-delete-confirm-text">
              {t.projectSettings.deleteConfirmBody.replace('{name}', localProject.name)}
            </p>
            <p className="gg-delete-confirm-path">
              {t.projectSettings.deleteConfirmPath.replace('{path}', project.path)}
            </p>
            {deleteError && <div className="gg-create-client-error" role="alert">{deleteError}</div>}
          </div>
          <div className="gg-modal-footer">
            <button type="button" className="gg-btn gg-btn-ghost" onClick={() => setShowDeleteConfirm(false)} disabled={deleteBusy}>
              {t.projectSettings.deleteConfirmNo}
            </button>
            <button type="button" className="gg-btn gg-btn-danger" onClick={() => void handleDeleteWithData()} disabled={deleteBusy}>
              {deleteBusy ? t.projectSettings.deleting : t.projectSettings.deleteConfirmYes}
            </button>
          </div>
        </div>
      </div>
    )}
    </>,
    document.body
  )
}