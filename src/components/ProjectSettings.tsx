import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useProject } from '../store/projectStore'
import type { ProjectGroup, ProjectMeta, RemoteDoctorResult, RemoteDoctorStatus } from '../types/api'
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
  const { removeProject, updateProjectMeta, refreshProjectList } = useProject()
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
  const [remoteDoctorBusy, setRemoteDoctorBusy] = useState(false)
  const [remoteDoctor, setRemoteDoctor] = useState<RemoteDoctorResult | null>(null)
  const [remoteDoctorError, setRemoteDoctorError] = useState<string | null>(null)
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([])
  const [groupsLoading, setGroupsLoading] = useState(false)
  const [groupBusy, setGroupBusy] = useState(false)
  const [groupSaved, setGroupSaved] = useState(false)
  const [groupError, setGroupError] = useState<string | null>(null)

  const currentGroup = useMemo(
    () => projectGroups.find(group => group.projectPaths.includes(project.path)) ?? null,
    [projectGroups, project.path]
  )

  useEffect(() => {
    setDisplayName(project.name)
    setLocalProject(project)
    setRemoteDoctor(null)
    setRemoteDoctorError(null)
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

  useEffect(() => {
    let cancelled = false
    setGroupsLoading(true)
    setGroupError(null)
    void window.api.projects.listGroups()
      .then(groups => {
        if (!cancelled) setProjectGroups(groups)
      })
      .catch(err => {
        if (!cancelled) setGroupError(err instanceof Error ? err.message : 'Не удалось загрузить группы')
      })
      .finally(() => {
        if (!cancelled) setGroupsLoading(false)
      })
    return () => { cancelled = true }
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

  async function handleToggleHidden(hidden: boolean) {
    setSaving(true)
    const updated = await updateProjectMeta(project.path, { hidden })
    setSaving(false)
    if (updated) {
      applyUpdated(updated)
      await refreshProjectList()
    }
  }

  async function handleProjectGroupChange(value: string) {
    const nextGroupId = value ? Number(value) : null
    if ((currentGroup?.id ?? null) === nextGroupId) return

    setGroupBusy(true)
    setGroupSaved(false)
    setGroupError(null)
    try {
      const latestGroups = await window.api.projects.listGroups()
      const latestCurrent = latestGroups.find(group => group.projectPaths.includes(project.path)) ?? null
      const nextGroup = nextGroupId === null
        ? null
        : latestGroups.find(group => group.id === nextGroupId) ?? null

      if (nextGroupId !== null && !nextGroup) {
        throw new Error('Группа не найдена')
      }

      if (nextGroup) {
        const projectPaths = nextGroup.projectPaths.includes(project.path)
          ? nextGroup.projectPaths
          : [...nextGroup.projectPaths, project.path]
        const result = await window.api.projects.updateGroup(nextGroup.id, { projectPaths })
        if (!result.ok) throw new Error(result.error)
      } else if (latestCurrent) {
        const projectPaths = latestCurrent.projectPaths.filter(path => path !== project.path)
        const result = await window.api.projects.updateGroup(latestCurrent.id, { projectPaths })
        if (!result.ok) throw new Error(result.error)
      }

      const updatedGroups = await window.api.projects.listGroups()
      setProjectGroups(updatedGroups)
      await refreshProjectList()
      window.dispatchEvent(new CustomEvent('gg-project-groups-changed'))
      setGroupSaved(true)
      window.setTimeout(() => setGroupSaved(false), 2000)
    } catch (err) {
      setGroupError(err instanceof Error ? err.message : 'Не удалось изменить группу проекта')
    } finally {
      setGroupBusy(false)
    }
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

  async function handleRemoteDoctor() {
    setRemoteDoctorBusy(true)
    setRemoteDoctorError(null)
    try {
      const result = await window.api.projects.remoteDoctor(project.path)
      setRemoteDoctor(result)
    } catch (err) {
      setRemoteDoctorError(err instanceof Error ? err.message : 'Не удалось выполнить проверку')
    } finally {
      setRemoteDoctorBusy(false)
    }
  }

  const isSshProject = localProject.kind === 'ssh' || localProject.remote?.kind === 'ssh' || /^ssh:\/\//i.test(project.path)

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
          <div className="gg-ps-hero" id="gg-ps-title">
            <button
              type="button"
              className="gg-ps-avatar-btn"
              onClick={() => void handlePickIcon()}
              disabled={iconBusy}
              title="Изменить изображение проекта"
              aria-label="Изменить изображение проекта"
            >
              <ProjectAvatar
                project={{ ...localProject, name: displayName || localProject.name }}
                className="gg-rail-avatar"
                size={48}
              />
            </button>
            <div className="gg-ps-hero-main">
              <input
                id="gg-ps-display-name"
                className="gg-ps-hero-name"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="Название проекта"
                maxLength={80}
                aria-label="Название проекта"
              />
              <div className="gg-ps-hero-actions">
                <button
                  type="button"
                  className="gg-ps-action-btn gg-ps-pick-icon-btn"
                  onClick={() => void handlePickIcon()}
                  disabled={iconBusy}
                >
                  {iconBusy ? 'Загрузка…' : 'Выбрать изображение'}
                </button>
                <button
                  type="button"
                  className={`gg-ps-save-btn ${appearanceSaved ? 'is-saved' : ''}`}
                  onClick={() => void handleSaveAppearance()}
                  disabled={saving || !displayName.trim() || displayName.trim() === localProject.name}
                >
                  {appearanceSaved ? '✓ Сохранено' : 'Сохранить название'}
                </button>
                {localProject.iconPath && (
                  <button
                    type="button"
                    className="gg-btn gg-btn-ghost gg-ps-clear-icon-btn"
                    onClick={() => void handleClearIcon()}
                    disabled={iconBusy}
                  >
                    Убрать иконку
                  </button>
                )}
              </div>
            </div>
          </div>
          <button className="gg-ps-close" onClick={onClose} title="Закрыть">×</button>
        </div>

        <div className="gg-ps-body">
          <section className="gg-ps-section">
            <div className="gg-ps-section-label">Папка на диске</div>
            <div className="gg-ps-path">
              <span className="gg-ps-path-icon gg-folder-icon" aria-hidden="true" />
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
              Группа проекта
              <span className="gg-ps-section-hint">Перемещает проект в уже созданную группу в левом списке</span>
            </div>
            <div className="gg-ps-group-row">
              <select
                className="gg-ps-select"
                value={currentGroup?.id ?? ''}
                onChange={e => void handleProjectGroupChange(e.target.value)}
                disabled={groupsLoading || groupBusy || projectGroups.length === 0}
                aria-label="Группа проекта"
              >
                <option value="">Без группы</option>
                {projectGroups.map(group => (
                  <option key={group.id} value={group.id}>{group.name}</option>
                ))}
              </select>
              <span className={`gg-ps-group-status ${groupSaved ? 'is-saved' : ''}`}>
                {groupBusy
                  ? 'Сохраняю...'
                  : groupSaved
                    ? 'Сохранено'
                    : currentGroup
                      ? `Сейчас: ${currentGroup.name}`
                      : 'Сейчас: без группы'}
              </span>
            </div>
            {!groupsLoading && projectGroups.length === 0 && (
              <p className="gg-ps-section-hint-block">
                Сначала создайте группу в левой панели проектов.
              </p>
            )}
            {groupError && <div className="gg-ps-group-error" role="alert">{groupError}</div>}
          </section>

          {isSshProject && (
            <section className="gg-ps-section gg-ps-remote-section">
              <div className="gg-ps-section-label">
                Remote Doctor
                <span className="gg-ps-section-hint">SSH live: Linux/macOS remote host</span>
              </div>
              <div className={`gg-ps-remote-summary ${remoteDoctor ? `is-${remoteDoctor.status}` : 'is-idle'}`}>
                <div>
                  <div className="gg-ps-remote-summary-title">
                    {remoteDoctor ? remoteDoctor.summary : 'Сервер ещё не проверен'}
                  </div>
                  <div className="gg-ps-remote-summary-detail">
                    {remoteDoctor
                      ? `${remoteDoctor.target.user ? `${remoteDoctor.target.user}@` : ''}${remoteDoctor.target.host}${remoteDoctor.target.remoteRoot}`
                      : 'Проверка доступа, shell, git, node/npm/npx, rg, tsc и прав записи.'}
                  </div>
                </div>
                <button
                  type="button"
                  className="gg-ps-action-btn"
                  onClick={() => void handleRemoteDoctor()}
                  disabled={remoteDoctorBusy}
                >
                  {remoteDoctorBusy ? 'Проверяю...' : 'Проверить сервер'}
                </button>
              </div>
              {remoteDoctorError && <div className="gg-ps-remote-error" role="alert">{remoteDoctorError}</div>}
              {remoteDoctor && (
                <>
                  <div className="gg-ps-remote-checks">
                    {remoteDoctor.checks.map(check => (
                      <div key={check.id} className={`gg-ps-remote-check is-${check.status}`}>
                        <span className="gg-ps-remote-check-dot">{remoteStatusMark(check.status)}</span>
                        <span className="gg-ps-remote-check-main">
                          <span className="gg-ps-remote-check-label">{check.label}</span>
                          {check.detail && <span className="gg-ps-remote-check-detail">{check.detail}</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                  {remoteDoctor.notes.length > 0 && (
                    <div className="gg-ps-remote-notes">
                      {remoteDoctor.notes.map(note => <div key={note}>{note}</div>)}
                    </div>
                  )}
                </>
              )}
            </section>
          )}

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
            <div className="gg-ps-section-label">{t.projectSettings.hideFromList}</div>
            <p className="gg-ps-section-hint-block">{t.projectSettings.hideFromListDesc}</p>
            <label className="gg-ps-toggle-row">
              <input
                type="checkbox"
                checked={localProject.hidden}
                onChange={e => void handleToggleHidden(e.target.checked)}
                disabled={saving}
              />
              <span>{t.projectSettings.hideFromList}</span>
            </label>
          </section>

          <section className="gg-ps-section gg-ps-danger-zone">
            <div className="gg-ps-section-label gg-ps-danger-label">Удаление проекта</div>

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

function remoteStatusMark(status: RemoteDoctorStatus): string {
  if (status === 'pass') return '✓'
  if (status === 'warn') return '!'
  return '×'
}
