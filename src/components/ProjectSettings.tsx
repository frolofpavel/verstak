import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useProject } from '../store/projectStore'
import type { ProjectGroup, ProjectLabel, ProjectMeta, ProjectStatus, RemoteDoctorResult, RemoteDoctorStatus } from '../types/api'
import { ProjectAvatar } from './ProjectAvatar'
import { DeleteCountdownButton } from './DeleteCountdownButton'
import { useT } from '../i18n'

interface ProjectSettingsProps {
  project: ProjectMeta
  onClose: () => void
  onProjectUpdated: (project: ProjectMeta) => void
}

const PROJECT_ACCENT_COLORS = [
  '#8fcfe0',
  '#7fd49a',
  '#d7b56d',
  '#d88a8a',
  '#a9a0e8',
  '#74b9ff',
  '#66d6c2',
  '#f0a96d',
  '#c58adf',
  '#f07f9b'
]

export function ProjectSettings({ project, onClose, onProjectUpdated }: ProjectSettingsProps) {
  const t = useT()
  const { removeProject, updateProjectMeta, refreshProjectList } = useProject()
  const [displayName, setDisplayName] = useState(project.name)
  const [notes, setNotes] = useState(project.notes ?? '')
  const [accentColor, setAccentColor] = useState(project.accentColor ?? '')
  const [projectStatus, setProjectStatus] = useState<ProjectStatus>(project.status ?? 'active')
  const [notificationsMuted, setNotificationsMuted] = useState(Boolean(project.notificationsMuted))
  const [localProject, setLocalProject] = useState(project)
  const [saving, setSaving] = useState(false)
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
  const [labels, setLabels] = useState<ProjectLabel[]>([])
  const [labelName, setLabelName] = useState('')
  const [labelBusy, setLabelBusy] = useState(false)
  const [labelError, setLabelError] = useState<string | null>(null)
  const [metaSaved, setMetaSaved] = useState(false)
  const [projectActionStatus, setProjectActionStatus] = useState<string | null>(null)

  const currentGroup = useMemo(
    () => projectGroups.find(group => group.projectPaths.includes(project.path)) ?? null,
    [projectGroups, project.path]
  )
  const labelQuery = labelName.trim().toLowerCase()
  const attachedLabelIds = useMemo(() => new Set(localProject.labels.map(label => label.id)), [localProject.labels])
  const matchingLabels = useMemo(() => {
    if (!labelQuery) return []
    return labels
      .filter(label => !attachedLabelIds.has(label.id) && label.name.toLowerCase().includes(labelQuery))
      .slice(0, 6)
  }, [attachedLabelIds, labelQuery, labels])

  useEffect(() => {
    setDisplayName(project.name)
    setNotes(project.notes ?? '')
    setAccentColor(project.accentColor ?? '')
    setProjectStatus(project.status ?? 'active')
    setNotificationsMuted(Boolean(project.notificationsMuted))
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
    let cancelled = false
    setGroupsLoading(true)
    setGroupError(null)
    void window.api.projects.listGroups()
      .then(groups => {
        if (!cancelled) setProjectGroups(groups)
      })
      .catch(err => {
        if (!cancelled) setGroupError(err instanceof Error ? err.message : 'РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ РіСЂСѓРїРїС‹')
      })
      .finally(() => {
        if (!cancelled) setGroupsLoading(false)
      })
    return () => { cancelled = true }
  }, [project.path])

  useEffect(() => {
    let cancelled = false
    void window.api.projects.listLabels()
      .then(items => { if (!cancelled) setLabels(items) })
      .catch(() => { if (!cancelled) setLabels([]) })
    return () => { cancelled = true }
  }, [])

  function applyUpdated(next: ProjectMeta) {
    setLocalProject(next)
    setDisplayName(next.name)
    onProjectUpdated(next)
  }

  async function handleSaveProjectSettings() {
    const trimmed = displayName.trim()
    if (!trimmed) return
    setSaving(true)
    const updated = await updateProjectMeta(project.path, {
      name: trimmed,
      notes,
      accentColor: accentColor || null,
      notificationsMuted,
      status: projectStatus
    })
    setSaving(false)
    if (updated) {
      applyUpdated(updated)
      await refreshProjectList()
      setAppearanceSaved(true)
      setMetaSaved(true)
      setTimeout(() => setAppearanceSaved(false), 2000)
      window.setTimeout(() => setMetaSaved(false), 1800)
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

  async function handleToggleHidden(hidden: boolean) {
    setSaving(true)
    const updated = await updateProjectMeta(project.path, { hidden })
    setSaving(false)
    if (updated) {
      applyUpdated(updated)
      await refreshProjectList()
    }
  }

  async function handleCreateLabel() {
    const trimmed = labelName.trim()
    if (!trimmed) return
    setLabelBusy(true)
    setLabelError(null)
    try {
      const result = await window.api.projects.createLabel(trimmed)
      if (!result.ok) throw new Error(result.error)
      const nextLabels = labels.some(label => label.id === result.label.id)
        ? labels
        : [...labels, result.label].sort((a, b) => a.name.localeCompare(b.name, 'ru'))
      setLabels(nextLabels)
      setLabelName('')
      if (!localProject.labels.some(label => label.id === result.label.id)) {
        const updated = await window.api.projects.setLabels(project.path, [...localProject.labels.map(label => label.id), result.label.id])
        if (updated) {
          applyUpdated(updated)
          await refreshProjectList()
        }
      }
    } catch (err) {
      setLabelError(err instanceof Error ? err.message : 'РќРµ СѓРґР°Р»РѕСЃСЊ СЃРѕР·РґР°С‚СЊ СЏСЂР»С‹Рє')
    } finally {
      setLabelBusy(false)
    }
  }

  async function handleToggleLabel(labelId: number) {
    const current = new Set(localProject.labels.map(label => label.id))
    if (current.has(labelId)) current.delete(labelId)
    else current.add(labelId)
    const updated = await window.api.projects.setLabels(project.path, Array.from(current))
    if (updated) {
      applyUpdated(updated)
      await refreshProjectList()
    }
  }

  async function handleProjectAction(action: 'backup' | 'duplicate' | 'cleanup') {
    setProjectActionStatus(null)
    if (action === 'cleanup') {
      const ok = window.confirm('РћС‡РёСЃС‚РєР° СѓРґР°Р»РёС‚ РІСЂРµРјРµРЅРЅС‹Рµ С„Р°Р№Р»С‹ Рё РєСЌС€ РїСЂРѕРµРєС‚Р°. Р§Р°С‚С‹, С„Р°Р№Р»С‹ РїСЂРѕРµРєС‚Р°, Р·Р°РґР°С‡Рё Рё Р¶СѓСЂРЅР°Р» РѕСЃС‚Р°РЅСѓС‚СЃСЏ. РџСЂРѕРґРѕР»Р¶РёС‚СЊ?')
      if (!ok) return
    }
    const result = action === 'backup'
      ? await window.api.projects.backup(project.path)
      : action === 'duplicate'
        ? await window.api.projects.duplicate(project.path)
        : await window.api.projects.cleanupCache(project.path)
    if (!result.ok) {
      setProjectActionStatus(result.error)
      return
    }
    if (action === 'backup') setProjectActionStatus(`Р РµР·РµСЂРІРЅР°СЏ РєРѕРїРёСЏ СЃРѕР·РґР°РЅР°: ${(result as { ok: true; path: string }).path}`)
    if (action === 'duplicate') {
      setProjectActionStatus(`РљРѕРїРёСЏ РїСЂРѕРµРєС‚Р° СЃРѕР·РґР°РЅР°: ${(result as { ok: true; path: string }).path}`)
      await refreshProjectList()
    }
    if (action === 'cleanup') setProjectActionStatus(`РћС‡РёСЃС‚РєР° Р·Р°РІРµСЂС€РµРЅР°. РЈРґР°Р»РµРЅРѕ РїР°РїРѕРє: ${(result as { ok: true; removed: number }).removed}`)
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
        throw new Error('Р“СЂСѓРїРїР° РЅРµ РЅР°Р№РґРµРЅР°')
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
      setGroupError(err instanceof Error ? err.message : 'РќРµ СѓРґР°Р»РѕСЃСЊ РёР·РјРµРЅРёС‚СЊ РіСЂСѓРїРїСѓ РїСЂРѕРµРєС‚Р°')
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
      setRemoteDoctorError(err instanceof Error ? err.message : 'РќРµ СѓРґР°Р»РѕСЃСЊ РІС‹РїРѕР»РЅРёС‚СЊ РїСЂРѕРІРµСЂРєСѓ')
    } finally {
      setRemoteDoctorBusy(false)
    }
  }

  const isSshProject = localProject.kind === 'ssh' || localProject.remote?.kind === 'ssh' || /^ssh:\/\//i.test(project.path)
  const projectKindLabel = localProject.kind === 'ssh'
    ? 'SSH-РїСЂРѕРµРєС‚'
    : localProject.kind === 'git'
      ? 'Git-РїСЂРѕРµРєС‚'
      : 'Р›РѕРєР°Р»СЊРЅР°СЏ РїР°РїРєР°'
  const projectStatusLabel = projectStatus === 'paused'
    ? 'РќР° РїР°СѓР·Рµ'
    : projectStatus === 'done'
      ? 'Р—Р°РІРµСЂС€С‘РЅ'
      : 'РђРєС‚РёРІРЅС‹Р№'
  const lastActivityLabel = localProject.lastAssistantAt
    ? new Date(localProject.lastAssistantAt).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
    : 'РќРµС‚ РґР°РЅРЅС‹С…'
  const createdAtLabel = localProject.createdAt
    ? new Date(localProject.createdAt).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
    : 'РќРµС‚ РґР°РЅРЅС‹С…'

  const projectSettingsDirty =
    displayName.trim() !== localProject.name ||
    notes !== (localProject.notes ?? '') ||
    (accentColor || null) !== (localProject.accentColor ?? null) ||
    notificationsMuted !== Boolean(localProject.notificationsMuted) ||
    projectStatus !== (localProject.status ?? 'active')
  const projectSaveStatus = saving
    ? 'РЎРѕС…СЂР°РЅСЏСЋвЂ¦'
    : appearanceSaved || metaSaved
      ? 'РЎРѕС…СЂР°РЅРµРЅРѕ'
      : projectSettingsDirty
        ? 'Р•СЃС‚СЊ РЅРµСЃРѕС…СЂР°РЅС‘РЅРЅС‹Рµ РёР·РјРµРЅРµРЅРёСЏ'
        : 'РР·РјРµРЅРµРЅРёР№ РЅРµС‚'

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
          <div className="gg-ps-title-block">
            <div className="gg-ps-kicker" id="gg-ps-title">РџР°СЂР°РјРµС‚СЂС‹ РїСЂРѕРµРєС‚Р°</div>
            <div className="gg-ps-title">РћСЃРЅРѕРІРЅС‹Рµ РЅР°СЃС‚СЂРѕР№РєРё Рё РґРѕСЃС‚СѓРї Рє РїСЂРѕРµРєС‚Сѓ</div>
          </div>
          <button className="gg-ps-close" onClick={onClose} title="Р—Р°РєСЂС‹С‚СЊ">Г—</button>
        </div>

        <div className="gg-ps-body">
          <section className="gg-ps-identity-card">
            <button
              type="button"
              className="gg-ps-avatar-btn"
              onClick={() => void handlePickIcon()}
              disabled={iconBusy}
              title="РР·РјРµРЅРёС‚СЊ РёР·РѕР±СЂР°Р¶РµРЅРёРµ РїСЂРѕРµРєС‚Р°"
              aria-label="РР·РјРµРЅРёС‚СЊ РёР·РѕР±СЂР°Р¶РµРЅРёРµ РїСЂРѕРµРєС‚Р°"
            >
              <ProjectAvatar
                project={{ ...localProject, name: displayName || localProject.name, accentColor: accentColor || null }}
                className="gg-rail-avatar"
                size={52}
              />
            </button>
            <div className="gg-ps-identity-main">
              <div className="gg-ps-identity-topline">
                <span>РќР°Р·РІР°РЅРёРµ РїСЂРѕРµРєС‚Р°</span>
                {appearanceSaved && <span className="gg-ps-saved-note">РЎРѕС…СЂР°РЅРµРЅРѕ</span>}
              </div>
              <input
                id="gg-ps-display-name"
                className="gg-ps-hero-name"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="РќР°Р·РІР°РЅРёРµ РїСЂРѕРµРєС‚Р°"
                maxLength={80}
                aria-label="РќР°Р·РІР°РЅРёРµ РїСЂРѕРµРєС‚Р°"
              />
              <div className="gg-ps-hero-actions">
                <button
                  type="button"
                  className="gg-ps-action-btn gg-ps-pick-icon-btn"
                  onClick={() => void handlePickIcon()}
                  disabled={iconBusy}
                >
                  {iconBusy ? 'Р—Р°РіСЂСѓР·РєР°вЂ¦' : 'Р’С‹Р±СЂР°С‚СЊ РёР·РѕР±СЂР°Р¶РµРЅРёРµ'}
                </button>
                {localProject.iconPath && (
                  <button
                    type="button"
                    className="gg-ps-action-btn"
                    onClick={() => void handleClearIcon()}
                    disabled={iconBusy}
                  >
                    РЈР±СЂР°С‚СЊ РёР·РѕР±СЂР°Р¶РµРЅРёРµ
                  </button>
                )}
              </div>
            </div>
          </section>

          <div className="gg-ps-grid">
            <section className="gg-ps-card gg-ps-card-main">
              <div className="gg-ps-card-head">
                <div>
                  <div className="gg-ps-card-title">Р—Р°РјРµС‚РєРё</div>
                  <div className="gg-ps-card-desc">РљРѕСЂРѕС‚РєР°СЏ РІРЅСѓС‚СЂРµРЅРЅСЏСЏ Р·Р°РјРµС‚РєР° РїРѕ РїСЂРѕРµРєС‚Сѓ</div>
                </div>
              </div>
              <textarea
                className="gg-ps-notes"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="РќР°РїСЂРёРјРµСЂ: РѕСЃРЅРѕРІРЅРѕР№ РєР»РёРµРЅС‚, РІР°Р¶РЅС‹Рµ РєРѕРЅС‚Р°РєС‚С‹, РѕСЃРѕР±РµРЅРЅРѕСЃС‚Рё РїСЂРѕРµРєС‚Р°"
                rows={3}
              />
            </section>

            <section className="gg-ps-card gg-ps-card-main">
              <div className="gg-ps-card-head">
                <div>
                  <div className="gg-ps-card-title">РЎРІРµРґРµРЅРёСЏ</div>
                  <div className="gg-ps-card-desc">РљСЂР°С‚РєР°СЏ СЃРІРѕРґРєР° РїРѕ С‚РµРєСѓС‰РµРјСѓ РїСЂРѕРµРєС‚Сѓ</div>
                </div>
              </div>
              <div className="gg-ps-stats">
                <div>
                  <span>РўРёРї</span>
                  <strong>{projectKindLabel}</strong>
                </div>
                <div>
                  <span>РЎС‚Р°С‚СѓСЃ</span>
                  <strong>{projectStatusLabel}</strong>
                </div>
                <div>
                  <span>РЎРѕР·РґР°РЅ</span>
                  <strong>{createdAtLabel}</strong>
                </div>
                <div>
                  <span>РџРѕСЃР»РµРґРЅРёРµ РґРµР№СЃС‚РІРёСЏ</span>
                  <strong>{lastActivityLabel}</strong>
                </div>
              </div>
            </section>

            <section className="gg-ps-card gg-ps-card-main">
              <div className="gg-ps-card-head">
                <div>
                  <div className="gg-ps-card-title">РЇСЂР»С‹РєРё</div>
                  <div className="gg-ps-card-desc">Рљ РїСЂРѕРµРєС‚Сѓ РјРѕР¶РЅРѕ РїСЂРёРєСЂРµРїРёС‚СЊ РЅРµСЃРєРѕР»СЊРєРѕ СЏСЂР»С‹РєРѕРІ</div>
                </div>
              </div>
              <div className="gg-ps-labels">
                {localProject.labels.map(label => (
                  <button
                    type="button"
                    key={label.id}
                    className="gg-ps-label-chip is-active"
                    onClick={() => void handleToggleLabel(label.id)}
                    title="РЈР±СЂР°С‚СЊ СЏСЂР»С‹Рє СЃ РїСЂРѕРµРєС‚Р°"
                  >
                    <span style={{ background: label.color }} />
                    {label.name}
                  </button>
                ))}
                {localProject.labels.length === 0 && <span className="gg-ps-empty-note">РЈ РїСЂРѕРµРєС‚Р° РїРѕРєР° РЅРµС‚ СЏСЂР»С‹РєРѕРІ</span>}
              </div>
              <div className="gg-ps-label-create">
                <div className="gg-ps-label-input-wrap">
                  <input
                    className="gg-ps-inline-input"
                    value={labelName}
                    onChange={e => setLabelName(e.target.value)}
                    placeholder="РќР°Р№С‚Рё РёР»Рё СЃРѕР·РґР°С‚СЊ СЏСЂР»С‹Рє"
                  />
                  {matchingLabels.length > 0 && (
                    <div className="gg-ps-label-suggest" role="listbox">
                      {matchingLabels.map(label => (
                        <button
                          type="button"
                          key={label.id}
                          onClick={() => {
                            setLabelName('')
                            void handleToggleLabel(label.id)
                          }}
                        >
                          <span style={{ background: label.color }} />
                          {label.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="gg-ps-action-btn"
                  onClick={() => void handleCreateLabel()}
                  disabled={labelBusy || !labelName.trim()}
                >
                  {labelBusy ? 'Р”РѕР±Р°РІР»СЏСЋ...' : 'Р”РѕР±Р°РІРёС‚СЊ'}
                </button>
              </div>
              {labelError && <div className="gg-ps-group-error" role="alert">{labelError}</div>}
            </section>

            <section className="gg-ps-card gg-ps-equal-card">
              <div className="gg-ps-card-head">
                <div>
                  <div className="gg-ps-card-title">Р“СЂСѓРїРїР°</div>
                  <div className="gg-ps-card-desc">Р“РґРµ РїСЂРѕРµРєС‚ РїРѕРєР°Р·С‹РІР°РµС‚СЃСЏ РІ Р»РµРІРѕРј СЃРїРёСЃРєРµ</div>
                </div>
                <span className={`gg-ps-group-status ${groupSaved ? 'is-saved' : ''}`}>
                  {groupBusy
                    ? 'РЎРѕС…СЂР°РЅСЏСЋ...'
                    : groupSaved
                      ? 'РЎРѕС…СЂР°РЅРµРЅРѕ'
                      : currentGroup
                        ? currentGroup.name
                        : 'Р‘РµР· РіСЂСѓРїРїС‹'}
                </span>
              </div>
              <div className="gg-ps-control-slot">
                <select
                  className="gg-ps-select"
                  value={currentGroup?.id ?? ''}
                  onChange={e => void handleProjectGroupChange(e.target.value)}
                  disabled={groupsLoading || groupBusy || projectGroups.length === 0}
                  aria-label="Р“СЂСѓРїРїР° РїСЂРѕРµРєС‚Р°"
                >
                  <option value="">Р‘РµР· РіСЂСѓРїРїС‹</option>
                  {projectGroups.map(group => (
                    <option key={group.id} value={group.id}>{group.name}</option>
                  ))}
                </select>
              </div>
              {!groupsLoading && projectGroups.length === 0 && (
                <p className="gg-ps-section-hint-block">РЎРЅР°С‡Р°Р»Р° СЃРѕР·РґР°Р№С‚Рµ РіСЂСѓРїРїСѓ РІ Р»РµРІРѕР№ РїР°РЅРµР»Рё РїСЂРѕРµРєС‚РѕРІ</p>
              )}
              {groupError && <div className="gg-ps-group-error" role="alert">{groupError}</div>}
            </section>

            <section className="gg-ps-card gg-ps-equal-card">
              <div className="gg-ps-card-head">
                <div>
                  <div className="gg-ps-card-title">Р Р°СЃРїРѕР»РѕР¶РµРЅРёРµ</div>
                  <div className="gg-ps-card-desc">РџР°РїРєР°, РіРґРµ Р»РµР¶Р°С‚ С„Р°Р№Р»С‹ РїСЂРѕРµРєС‚Р°</div>
                </div>
              </div>
              <div className="gg-ps-control-slot">
                <div className="gg-ps-path">
                  <span className="gg-ps-path-icon gg-folder-icon" aria-hidden="true" />
                  <span className="gg-ps-path-text" title={project.path}>{project.path}</span>
                  <button
                    className="gg-ps-path-open"
                    onClick={() => void window.api.files.revealInExplorer?.(project.path).catch(() => {})}
                    title="РћС‚РєСЂС‹С‚СЊ РІ РїСЂРѕРІРѕРґРЅРёРєРµ"
                  >в†—</button>
                </div>
              </div>
            </section>

            <section className="gg-ps-card gg-ps-equal-card">
              <div className="gg-ps-card-head">
                <div>
                  <div className="gg-ps-card-title">РЎС‚Р°С‚СѓСЃ РїСЂРѕРµРєС‚Р°</div>
                  <div className="gg-ps-card-desc">РџРѕРјРѕРіР°РµС‚ С„РёР»СЊС‚СЂРѕРІР°С‚СЊ РїСЂРѕРµРєС‚С‹ РІ Р»РµРІРѕРј РјРµРЅСЋ</div>
                </div>
              </div>
              <div className="gg-ps-control-slot">
                <div className="gg-ps-status-segment">
                  {[
                    ['active', 'РђРєС‚РёРІРЅС‹Р№'],
                    ['paused', 'РќР° РїР°СѓР·Рµ'],
                    ['done', 'Р—Р°РІРµСЂС€С‘РЅ']
                  ].map(([value, label]) => (
                    <button
                      type="button"
                      key={value}
                      className={projectStatus === value ? 'is-active' : ''}
                      onClick={() => {
                        const nextStatus = value as ProjectStatus
                        setProjectStatus(nextStatus)
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <section className="gg-ps-card gg-ps-equal-card">
              <div className="gg-ps-card-head">
                <div>
                  <div className="gg-ps-card-title">Р¦РІРµС‚</div>
                  <div className="gg-ps-card-desc">РћС‚РѕР±СЂР°Р¶Р°РµС‚СЃСЏ РїРѕ РєРѕРЅС‚СѓСЂСѓ Р°РІР°С‚Р°СЂРєРё РїСЂРѕРµРєС‚Р°</div>
                </div>
              </div>
              <div className="gg-ps-control-slot">
                <div className="gg-ps-color-row">
                  <div className="gg-ps-color-grid" aria-label="Р¦РІРµС‚ РїСЂРѕРµРєС‚Р°">
                    {PROJECT_ACCENT_COLORS.map(color => (
                      <button
                        type="button"
                        key={color}
                        className={`gg-ps-color-choice ${accentColor === color ? 'is-active' : ''}`}
                        style={{ background: color }}
                        onClick={() => setAccentColor(color)}
                        aria-label={`Р¦РІРµС‚ ${color}`}
                      />
                    ))}
                  </div>
                  <button
                    type="button"
                    className="gg-ps-action-btn"
                    onClick={() => setAccentColor('')}
                  >
                    РЎР±СЂРѕСЃРёС‚СЊ
                  </button>
                </div>
              </div>
            </section>

            {isSshProject && (
              <section className="gg-ps-card gg-ps-card-main gg-ps-remote-section">
                <div className="gg-ps-card-head">
                  <div>
                    <div className="gg-ps-card-title">РЈРґР°Р»С‘РЅРЅС‹Р№ РїСЂРѕРµРєС‚</div>
                    <div className="gg-ps-card-desc">РџСЂРѕРІРµСЂРєР° SSH-РґРѕСЃС‚СѓРїР°, РёРЅСЃС‚СЂСѓРјРµРЅС‚РѕРІ Рё РїСЂР°РІ Р·Р°РїРёСЃРё</div>
                  </div>
                  <button
                    type="button"
                    className="gg-ps-action-btn"
                    onClick={() => void handleRemoteDoctor()}
                    disabled={remoteDoctorBusy}
                  >
                    {remoteDoctorBusy ? 'РџСЂРѕРІРµСЂСЏСЋ...' : 'РџСЂРѕРІРµСЂРёС‚СЊ'}
                  </button>
                </div>
                <div
                  className={`gg-ps-remote-summary ${remoteDoctor ? `is-${remoteDoctor.status}` : 'is-idle'}`}
                >
                  <div>
                    <div className="gg-ps-remote-summary-title">
                      {remoteDoctor ? remoteDoctor.summary : 'РЎРµСЂРІРµСЂ РµС‰С‘ РЅРµ РїСЂРѕРІРµСЂРµРЅ'}
                    </div>
                    <div className="gg-ps-remote-summary-detail">
                      {remoteDoctor
                        ? `${remoteDoctor.target.user ? `${remoteDoctor.target.user}@` : ''}${remoteDoctor.target.host}${remoteDoctor.target.remoteRoot}`
                        : 'РџСЂРѕРІРµСЂРєР° shell, git, node/npm/npx, rg, tsc Рё РїСЂР°РІ Р·Р°РїРёСЃРё'}
                    </div>
                  </div>
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
          </div>

          <section className="gg-ps-card gg-ps-card-main">
            <div className="gg-ps-card-head">
              <div>
                <div className="gg-ps-card-title">Р”Р°РЅРЅС‹Рµ РїСЂРѕРµРєС‚Р°</div>
                <div className="gg-ps-card-desc">РЎРѕР·РґР°РЅРёРµ РєРѕРїРёР№ Рё РѕР±СЃР»СѓР¶РёРІР°РЅРёРµ РІСЂРµРјРµРЅРЅС‹С… РґР°РЅРЅС‹С…</div>
              </div>
            </div>
            <div className="gg-ps-maintenance">
              <button type="button" className="gg-ps-action-btn" onClick={() => void handleProjectAction('backup')}>
                РЎРѕР·РґР°С‚СЊ СЂРµР·РµСЂРІРЅСѓСЋ РєРѕРїРёСЋ
              </button>
              <button type="button" className="gg-ps-action-btn" onClick={() => void handleProjectAction('duplicate')}>
                РЎРѕР·РґР°С‚СЊ РєРѕРїРёСЋ РїСЂРѕРµРєС‚Р°
              </button>
              <button type="button" className="gg-ps-action-btn" onClick={() => void handleProjectAction('cleanup')}>
                РћС‡РёСЃС‚РёС‚СЊ РІСЂРµРјРµРЅРЅС‹Рµ С„Р°Р№Р»С‹
              </button>
            </div>
            <div className="gg-ps-section-hint-block">
              РћС‡РёСЃС‚РєР° СѓРґР°Р»СЏРµС‚ С‚РѕР»СЊРєРѕ СЃР»СѓР¶РµР±РЅС‹Рµ РІСЂРµРјРµРЅРЅС‹Рµ РїР°РїРєРё Verstak. Р¤Р°Р№Р»С‹ РїСЂРѕРµРєС‚Р°, С‡Р°С‚С‹, Р·Р°РґР°С‡Рё Рё Р¶СѓСЂРЅР°Р» РѕСЃС‚Р°СЋС‚СЃСЏ
            </div>
            {projectActionStatus && <div className="gg-ps-action-status">{projectActionStatus}</div>}
          </section>

          <section className="gg-ps-section gg-ps-danger-zone">
            <div className="gg-ps-danger-label">РЈРїСЂР°РІР»РµРЅРёРµ РїСЂРѕРµРєС‚РѕРј</div>

            <div className="gg-ps-danger-row gg-ps-danger-row-stack">
              <div>
                <div className="gg-ps-danger-title">РђСЂС…РёРІ</div>
                <div className="gg-ps-danger-desc">РџСЂРѕРµРєС‚ РёСЃС‡РµР·РЅРµС‚ РёР· РѕСЃРЅРѕРІРЅРѕРіРѕ СЃРїРёСЃРєР°, РЅРѕ РѕСЃС‚Р°РЅРµС‚СЃСЏ РґРѕСЃС‚СѓРїРµРЅ С‡РµСЂРµР· С„РёР»СЊС‚СЂ Р°СЂС…РёРІР°</div>
              </div>
              <label className="gg-ps-switch">
                <input
                  type="checkbox"
                  checked={localProject.hidden}
                  onChange={e => void handleToggleHidden(e.target.checked)}
                  disabled={saving}
                />
                <span aria-hidden="true" />
              </label>
            </div>

            <div className="gg-ps-danger-row gg-ps-danger-row-stack">
              <div>
                <div className="gg-ps-danger-title">РЈРІРµРґРѕРјР»РµРЅРёСЏ</div>
                <div className="gg-ps-danger-desc">РћС‚РєР»СЋС‡Р°РµС‚ СЃРёРіРЅР°Р»С‹ С‚РѕР»СЊРєРѕ РґР»СЏ СЌС‚РѕРіРѕ РїСЂРѕРµРєС‚Р°</div>
              </div>
              <label className="gg-ps-switch">
                <input
                  type="checkbox"
                  checked={!notificationsMuted}
                  onChange={e => {
                    const muted = !e.target.checked
                    setNotificationsMuted(muted)
                  }}
                  disabled={saving}
                />
                <span aria-hidden="true" />
              </label>
            </div>

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
        <div className="gg-settings-actionbar gg-ps-actionbar">
          <div className={`gg-settings-save-status ${projectSettingsDirty ? 'is-dirty' : appearanceSaved || metaSaved ? 'is-saved' : ''}`}>
            {projectSaveStatus}
          </div>
          <button type="button" className="gg-btn gg-btn-ghost" onClick={onClose}>Р—Р°РєСЂС‹С‚СЊ</button>
          <button
            type="button"
            className="gg-btn gg-btn-primary"
            onClick={() => void handleSaveProjectSettings()}
            disabled={saving || !displayName.trim()}
          >
            {saving ? 'РЎРѕС…СЂР°РЅСЏСЋвЂ¦' : appearanceSaved || metaSaved ? 'РЎРѕС…СЂР°РЅРµРЅРѕ' : 'РЎРѕС…СЂР°РЅРёС‚СЊ'}
          </button>
        </div>
      </div>
    </div>

    {showDeleteConfirm && (
      <div className="gg-modal-backdrop gg-delete-confirm-backdrop" onClick={() => setShowDeleteConfirm(false)}>
        <div className="gg-modal gg-delete-client-confirm" onClick={e => e.stopPropagation()} role="alertdialog" aria-modal="true">
          <div className="gg-modal-header">
            <div className="gg-modal-title">{t.projectSettings.deleteConfirmTitle}</div>
            <button type="button" className="gg-modal-close" onClick={() => setShowDeleteConfirm(false)}>Г—</button>
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
  if (status === 'pass') return 'вњ“'
  if (status === 'warn') return '!'
  return 'Г—'
}
