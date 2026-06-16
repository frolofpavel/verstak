import { useEffect, useMemo, useRef, useState } from 'react'
import { useProject } from '../store/projectStore'
import type { ProjectGroup, ProjectMeta } from '../types/api'
import { ProjectAvatar } from './ProjectAvatar'
import { SettingsGearIcon } from './SettingsGearIcon'
import { UpdateNotification } from './UpdateNotification'
import { CreateClientModal } from './CreateClientModal'
import { CreateProjectGroupModal } from './CreateProjectGroupModal'
import { useT } from '../i18n'

const RAIL_EXPANDED_KEY = 'gg-rail-expanded'
const RAIL_WIDTH_COLLAPSED = '76px'
const RAIL_WIDTH_EXPANDED = '248px'

/**
 * Контракт анимации rail (визуально проверен — не ломать без ручной проверки):
 * — Открытие: railExpanded=true → shell, content и --gg-rail-w сразу в expanded;
 *   параллельные переходы только в CSS (--shell-dur / --shell-ease в layout.css).
 * — Закрытие: симметрично — всё сразу в collapsed, без staged setTimeout.
 */

function readRailExpanded(): boolean {
  try {
    return localStorage.getItem(RAIL_EXPANDED_KEY) === '1'
  } catch {
    return false
  }
}

interface RailView {
  groups: Array<{ group: ProjectGroup; projects: ProjectMeta[] }>
  ungrouped: ProjectMeta[]
  visibleCount: number
}

function buildRailView(
  groups: ProjectGroup[],
  projects: ProjectMeta[],
  query: string,
  activePath: string | null
): RailView {
  const visibleProjects = projects.filter(p => !p.hidden)
  const byPath = new Map(visibleProjects.map(p => [p.path, p]))
  const inGroup = new Set<string>()
  for (const g of groups) {
    for (const path of g.projectPaths) inGroup.add(path)
  }

  const q = query.trim().toLowerCase()

  const visibleGroups = groups.flatMap(group => {
    const memberProjects = group.projectPaths
      .map(path => byPath.get(path))
      .filter((p): p is ProjectMeta => !!p)

    if (!q) {
      if (memberProjects.length === 0) return []
      return [{ group, projects: memberProjects }]
    }

    const groupNameMatch = group.name.toLowerCase().includes(q)
    const matching = memberProjects.filter(
      p => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)
    )
    if (groupNameMatch && memberProjects.length > 0) return [{ group, projects: memberProjects }]
    if (matching.length > 0) return [{ group, projects: matching }]
    return []
  })

  let ungrouped = visibleProjects.filter(p => !inGroup.has(p.path))
  if (q) {
    ungrouped = ungrouped.filter(
      p => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)
    )
  }

  if (activePath) {
    const activeMeta = projects.find(p => p.path === activePath)
    if (activeMeta?.hidden) {
      return { groups: visibleGroups, ungrouped, visibleCount: countVisible(visibleGroups, ungrouped) }
    }
    const inVisible = ungrouped.some(p => p.path === activePath)
      || visibleGroups.some(v => v.projects.some(p => p.path === activePath))
    if (!inVisible) {
      const active = byPath.get(activePath)
      if (active) {
        if (inGroup.has(activePath)) {
          const host = visibleGroups.find(v => v.projects.some(p => p.path === activePath))
          if (host) return { groups: visibleGroups, ungrouped, visibleCount: countVisible(visibleGroups, ungrouped) }
          const group = groups.find(g => g.projectPaths.includes(activePath))
          if (group) {
            return {
              groups: [...visibleGroups, { group, projects: [active] }],
              ungrouped,
              visibleCount: countVisible(visibleGroups, ungrouped) + 1
            }
          }
        } else {
          ungrouped = [active, ...ungrouped]
        }
      }
    }
  }

  return {
    groups: visibleGroups,
    ungrouped,
    visibleCount: countVisible(visibleGroups, ungrouped)
  }
}

function countVisible(
  groups: Array<{ group: ProjectGroup; projects: ProjectMeta[] }>,
  ungrouped: ProjectMeta[]
): number {
  return ungrouped.length + groups.reduce((sum, g) => sum + g.projects.length, 0)
}

interface ProjectChipProps {
  project: ProjectMeta
  active: boolean
  unread: boolean
  streaming: boolean
  shellExpanded: boolean
  contentExpanded: boolean
  nested?: boolean
  onClick: () => void
  onSettings: () => void
}

function ProjectChip({
  project,
  active,
  unread,
  streaming,
  shellExpanded,
  contentExpanded,
  nested,
  onClick,
  onSettings
}: ProjectChipProps) {
  const [hover, setHover] = useState(false)
  const status = streaming ? 'streaming' : unread ? 'unread' : null

  return (
    <div
      className={`gg-rail-chip ${active ? 'is-active' : ''} ${shellExpanded ? 'is-shell-expanded' : ''} ${contentExpanded ? 'is-expanded' : ''} ${nested ? 'is-nested' : ''}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={contentExpanded ? project.path : `${project.name}\n${project.path}`}
    >
      <button
        type="button"
        className="gg-rail-chip-btn"
        onClick={onClick}
      >
        <span className="gg-rail-avatar-wrap">
          <ProjectAvatar project={project} className="gg-rail-avatar" size={34} />
          {status && (
            <span
              className={`gg-rail-status ${status === 'streaming' ? 'is-streaming' : 'is-unread'}`}
              title={streaming ? 'AI работает в этом проекте' : 'Есть новый ответ'}
            />
          )}
        </span>
        <span className="gg-rail-chip-text" aria-hidden={!contentExpanded}>
          <span className="gg-rail-label">{project.name}</span>
        </span>
      </button>
      {hover && (
        <button
          type="button"
          className="gg-rail-settings"
          onClick={e => { e.stopPropagation(); onSettings() }}
          title="Настройки проекта"
          aria-label="Настройки проекта"
        >
          <SettingsGearIcon size={13} />
        </button>
      )}
    </div>
  )
}

interface ProjectGroupBlockProps {
  group: ProjectGroup
  projects: ProjectMeta[]
  activePath: string | null
  sessions: Record<string, { hasUnread?: boolean; isStreaming?: boolean } | undefined>
  shellExpanded: boolean
  contentExpanded: boolean
  onToggleCollapsed: (group: ProjectGroup) => void
  onExpandRail: () => void
  onEdit: (group: ProjectGroup) => void
  onSelectProject: (path: string) => void
  onProjectSettings: (project: ProjectMeta) => void
}

function ProjectGroupBlock({
  group,
  projects,
  activePath,
  sessions,
  shellExpanded,
  contentExpanded,
  onToggleCollapsed,
  onExpandRail,
  onEdit,
  onSelectProject,
  onProjectSettings
}: ProjectGroupBlockProps) {
  const t = useT()
  const [hover, setHover] = useState(false)
  /** Свёрнутая панель → группы визуально закрыты; состояние в БД не трогаем. */
  const expanded = contentExpanded && !group.collapsed
  const hasActive = projects.some(p => p.path === activePath)

  function handleGroupToggle() {
    if (!contentExpanded) {
      onExpandRail()
      return
    }
    onToggleCollapsed(group)
  }

  return (
    <div
      className={`gg-rail-group ${expanded ? 'is-open' : ''} ${shellExpanded ? 'is-shell-expanded' : ''} ${contentExpanded ? 'is-expanded' : ''} ${hasActive ? 'has-active' : ''}`}
    >
      <div
        className="gg-rail-group-head"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <button
          type="button"
          className="gg-rail-group-toggle"
          onClick={handleGroupToggle}
          title={contentExpanded
            ? (expanded ? t.rail.groupCollapse : t.rail.groupExpand)
            : `${group.name} (${projects.length})`}
          aria-expanded={expanded}
        >
          <svg
            className={`gg-rail-group-chevron ${expanded ? 'is-open' : ''}`}
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <polyline points="9 6 15 12 9 18" />
          </svg>
          <span className="gg-rail-group-icon" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </span>
          <span className="gg-rail-group-label" aria-hidden={!contentExpanded}>
            {group.name}
          </span>
          <span className="gg-rail-group-count" aria-hidden={!contentExpanded}>
            {projects.length}
          </span>
        </button>
        {hover && contentExpanded && (
          <button
            type="button"
            className="gg-rail-group-edit"
            onClick={e => { e.stopPropagation(); onEdit(group) }}
            title={t.rail.groupEdit}
            aria-label={t.rail.groupEdit}
          >
            <SettingsGearIcon size={13} />
          </button>
        )}
      </div>
      {expanded && (
        <div className="gg-rail-group-body">
          {projects.map(p => {
            const session = sessions[p.path]
            return (
              <ProjectChip
                key={p.path}
                project={p}
                active={activePath === p.path}
                unread={!!session?.hasUnread}
                streaming={!!session?.isStreaming}
                shellExpanded={shellExpanded}
                contentExpanded={contentExpanded}
                nested
                onClick={() => onSelectProject(p.path)}
                onSettings={() => onProjectSettings(p)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

interface ProjectRailProps {
  onOpenProjectSettings: (project: ProjectMeta) => void
  onOpenAppSettings: () => void
  sidebarOpen: boolean
  onToggleSidebar: () => void
}

export function ProjectRail({ onOpenProjectSettings, onOpenAppSettings, sidebarOpen, onToggleSidebar }: ProjectRailProps) {
  const t = useT()
  const { path, projectList, sessions, setProject, refreshProjectList } = useProject()
  const [bootstrapped, setBootstrapped] = useState(false)
  const initialRailExpanded = readRailExpanded()
  const [railExpanded, setRailExpanded] = useState(initialRailExpanded)
  const [shellExpanded, setShellExpanded] = useState(initialRailExpanded)
  const [contentExpanded, setContentExpanded] = useState(initialRailExpanded)
  const [projectQuery, setProjectQuery] = useState('')
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([])
  const [showCreateClient, setShowCreateClient] = useState(false)
  const [groupModal, setGroupModal] = useState<{ mode: 'create' } | { mode: 'edit'; group: ProjectGroup } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const railView = useMemo(
    () => buildRailView(projectGroups, projectList, projectQuery, path),
    [projectGroups, projectList, projectQuery, path]
  )
  const hiddenProjects = useMemo(
    () => projectList.filter(p => p.hidden),
    [projectList]
  )
  const [hiddenOpen, setHiddenOpen] = useState(false)
  useEffect(() => {
    if (path && hiddenProjects.some(p => p.path === path)) setHiddenOpen(true)
  }, [path, hiddenProjects])
  const showSearch = projectList.length >= 2
  const hasActiveFilter = projectQuery.trim().length > 0
  const showSearchTool = !contentExpanded && showSearch
  const toolbarToolCount = 2 + (showSearchTool ? 1 : 0)
  const listEmpty = railView.visibleCount === 0

  async function refreshGroups() {
    const list = await window.api.projects.listGroups()
    setProjectGroups(list)
  }

  function openSearch() {
    setRailExpanded(true)
    window.setTimeout(() => searchRef.current?.focus(), 180)
  }

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--gg-rail-w',
      railExpanded ? RAIL_WIDTH_EXPANDED : RAIL_WIDTH_COLLAPSED
    )
    try {
      localStorage.setItem(RAIL_EXPANDED_KEY, railExpanded ? '1' : '0')
    } catch { /* ignore */ }
  }, [railExpanded])

  useEffect(() => {
    setShellExpanded(railExpanded)
    setContentExpanded(railExpanded)
  }, [railExpanded])

  useEffect(() => {
    void (async () => {
      await Promise.all([refreshProjectList(), refreshGroups()])
      const state = useProject.getState()
      if (!state.path) {
        const list = state.projectList
        const last = await window.api.settings.getKey('last_project_path')
        const lastInList = last && list.some(p => p.path === last) ? last : null
        if (lastInList) {
          await setProject(lastInList)
        } else if (list.length > 0) {
          await setProject(list[0].path)
        } else {
          const home = await window.api.app.getHomeDir()
          const fallback = (last && last.length > 0) ? last : home
          if (fallback) await setProject(fallback)
        }
      }
      setBootstrapped(true)
    })()
  }, [])
  void bootstrapped

  async function handleClientOpened(projectPath: string) {
    await setProject(projectPath)
    await refreshProjectList()
    await refreshGroups()
  }

  async function handleGroupSaved() {
    await refreshGroups()
  }

  async function handleToggleGroupCollapsed(group: ProjectGroup) {
    const result = await window.api.projects.updateGroup(group.id, { collapsed: !group.collapsed })
    if (result.ok) await refreshGroups()
  }

  return (
    <>
    <div className={`gg-rail ${shellExpanded ? 'is-shell-expanded' : ''} ${contentExpanded ? 'is-expanded' : ''}`}>
      <div
        className={`gg-rail-toolbar ${shellExpanded ? 'is-expanded is-row' : ''}`}
        data-tool-count={toolbarToolCount}
      >
        <button
          type="button"
          className={`gg-rail-tool ${railExpanded ? 'is-on' : ''}`}
          onClick={() => setRailExpanded(v => !v)}
          title={railExpanded ? t.rail.collapsePanel : t.rail.expandPanel}
          aria-expanded={railExpanded}
        >
          <svg
            className={`gg-rail-tool-chevron ${railExpanded ? 'is-expanded' : ''}`}
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <polyline points="9 6 15 12 9 18" />
          </svg>
        </button>
        {showSearchTool && (
          <button
            type="button"
            className={`gg-rail-tool gg-rail-tool-search ${hasActiveFilter ? 'is-on' : ''}`}
            onClick={openSearch}
            title={t.rail.search}
            aria-label={t.rail.search}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="11" cy="11" r="7" />
              <line x1="16.5" y1="16.5" x2="21" y2="21" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className={`gg-rail-tool gg-rail-tool-sidebar ${sidebarOpen ? 'is-on' : ''}`}
          onClick={onToggleSidebar}
          title={sidebarOpen ? t.rail.hideNavPanel : t.rail.showNavPanel}
          aria-pressed={sidebarOpen}
          aria-label={sidebarOpen ? t.rail.hideNavPanel : t.rail.showNavPanel}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <line x1="9" y1="4" x2="9" y2="20" />
          </svg>
        </button>
      </div>

      <div className="gg-rail-expand-panel" aria-hidden={!contentExpanded}>
        <div className="gg-rail-expand-inner">
          <div className="gg-rail-section-head">
            <span className="gg-rail-section-title">{t.rail.clients}</span>
            <div className="gg-rail-section-actions">
              <button
                type="button"
                className="gg-rail-section-btn"
                onClick={() => setGroupModal({ mode: 'create' })}
                title={t.rail.createGroup}
                aria-label={t.rail.createGroup}
                tabIndex={contentExpanded ? 0 : -1}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  <line x1="12" y1="11" x2="12" y2="17" />
                  <line x1="9" y1="14" x2="15" y2="14" />
                </svg>
              </button>
              <span className="gg-rail-section-count">{railView.visibleCount}</span>
            </div>
          </div>
          {showSearch && (
            <div className="gg-rail-search-wrap">
              <svg className="gg-rail-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="11" cy="11" r="7" />
                <line x1="16.5" y1="16.5" x2="21" y2="21" />
              </svg>
              <input
                ref={searchRef}
                type="search"
                className="gg-input gg-rail-search"
                placeholder={t.rail.searchPlaceholder}
                value={projectQuery}
                onChange={e => setProjectQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') setProjectQuery('') }}
                aria-label={t.rail.search}
                tabIndex={contentExpanded ? 0 : -1}
              />
              {hasActiveFilter && (
                <button
                  type="button"
                  className="gg-rail-search-clear"
                  onClick={() => setProjectQuery('')}
                  title={t.rail.clearSearch}
                  tabIndex={contentExpanded ? 0 : -1}
                >×</button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="gg-rail-list">
        {listEmpty && hasActiveFilter && (
          <div className="gg-rail-empty">{t.rail.noResults}</div>
        )}
        {railView.groups.map(({ group, projects }) => (
          <ProjectGroupBlock
            key={group.id}
            group={group}
            projects={projects}
            activePath={path}
            sessions={sessions}
            shellExpanded={shellExpanded}
            contentExpanded={contentExpanded}
            onToggleCollapsed={g => void handleToggleGroupCollapsed(g)}
            onExpandRail={() => setRailExpanded(true)}
            onEdit={g => setGroupModal({ mode: 'edit', group: g })}
            onSelectProject={p => { if (path !== p) void setProject(p) }}
            onProjectSettings={onOpenProjectSettings}
          />
        ))}
        {railView.ungrouped.map(p => {
          const session = sessions[p.path]
          return (
            <ProjectChip
              key={p.path}
              project={p}
              active={path === p.path}
              unread={!!session?.hasUnread}
              streaming={!!session?.isStreaming}
              shellExpanded={shellExpanded}
              contentExpanded={contentExpanded}
              onClick={() => { if (path !== p.path) void setProject(p.path) }}
              onSettings={() => onOpenProjectSettings(p)}
            />
          )
        })}
        {hiddenProjects.length > 0 && (() => {
          const hiddenExpanded = contentExpanded && hiddenOpen
          return (
          <div className={`gg-rail-hidden ${hiddenExpanded ? 'is-open' : ''} ${contentExpanded ? 'is-expanded' : ''}`}>
            <button
              type="button"
              className="gg-rail-hidden-toggle"
              onClick={() => {
                if (!contentExpanded) {
                  setRailExpanded(true)
                  return
                }
                setHiddenOpen(v => !v)
              }}
              title={contentExpanded
                ? t.rail.hiddenProjects
                : `${t.rail.hiddenProjects} (${hiddenProjects.length})`}
              aria-expanded={hiddenExpanded}
            >
              <span className={`gg-rail-group-chevron ${hiddenExpanded ? 'is-open' : ''}`} aria-hidden>›</span>
              <span className="gg-rail-hidden-icon" aria-hidden>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </span>
              <span className="gg-rail-hidden-label" aria-hidden={!contentExpanded}>{t.rail.hiddenProjects}</span>
              <span className="gg-rail-hidden-count" aria-hidden={!contentExpanded}>{hiddenProjects.length}</span>
            </button>
            {hiddenExpanded && hiddenProjects.map(p => {
              const session = sessions[p.path]
              return (
                <ProjectChip
                  key={p.path}
                  project={p}
                  active={path === p.path}
                  unread={!!session?.hasUnread}
                  streaming={!!session?.isStreaming}
                  shellExpanded={shellExpanded}
                  contentExpanded={contentExpanded}
                  nested
                  onClick={() => { if (path !== p.path) void setProject(p.path) }}
                  onSettings={() => onOpenProjectSettings(p)}
                />
              )
            })}
          </div>
          )
        })()}
        <button
          type="button"
          className="gg-rail-add"
          onClick={() => setShowCreateClient(true)}
          title={t.rail.createClient}
        >
          <span className="gg-rail-add-icon" aria-hidden>+</span>
          <span className="gg-rail-add-label" aria-hidden={!contentExpanded}>{t.rail.createClient}</span>
        </button>
      </div>

      <div className="gg-rail-footer">
        <UpdateNotification railExpanded={contentExpanded} />
        <button
          type="button"
          className="gg-rail-app-settings"
          onClick={onOpenAppSettings}
          title={t.settings.title}
          aria-label={t.settings.title}
        >
          <SettingsGearIcon size={18} />
          <span className="gg-rail-app-settings-label" aria-hidden={!contentExpanded}>{t.settings.title}</span>
        </button>
      </div>
    </div>
    {showCreateClient && (
      <CreateClientModal
        onClose={() => setShowCreateClient(false)}
        onOpened={projectPath => void handleClientOpened(projectPath)}
        onGroupsChanged={() => void refreshGroups()}
      />
    )}
    {groupModal && (
      <CreateProjectGroupModal
        projects={projectList}
        initialGroup={groupModal.mode === 'edit' ? groupModal.group : null}
        onClose={() => setGroupModal(null)}
        onSaved={() => void handleGroupSaved()}
      />
    )}
    </>
  )
}