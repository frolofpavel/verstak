import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useProject } from '../store/projectStore'
import type { ProjectGroup, ProjectMeta, ProjectStatus } from '../types/api'
import { ProjectAvatar } from './ProjectAvatar'
import { SettingsGearIcon } from './SettingsGearIcon'
import { UpdateNotification } from './UpdateNotification'
import { CreateClientModal } from './CreateClientModal'
import { CreateProjectGroupModal } from './CreateProjectGroupModal'
import { useT } from '../i18n'

const RAIL_EXPANDED_KEY = 'gg-rail-expanded'
const RAIL_WIDTH_COLLAPSED = '76px'
const RAIL_WIDTH_EXPANDED = 248
const RAIL_WIDTH_MAX = 372
const RAIL_WIDTH_KEY = 'gg-rail-width'
const RAIL_TOGGLE_MS = 380
const RAIL_COLLAPSE_DELAY_MS = 120
const RAIL_EXPAND_CONTENT_DELAY_MS = 55
const RAIL_PINNED_KEY = 'gg-rail-pinned-projects'
const PROJECT_MENU_W = 190
const PROJECT_MENU_H = 220

type ProjectMenuState = { x: number; y: number; project: ProjectMeta }
type CreateMenuState = { x: number; y: number } | null
type ProjectRailFilter = 'default' | ProjectStatus | 'archive'

/**
 * ═══ КОНТРАКТ АНИМАЦИИ RAIL — ЗАМОРОЖЕН 17.06.2026 (RAYNER: «тупо топ») ═══
 * Не менять без ручной проверки открытия И закрытия.
 *
 * Единственный переключатель: railExpanded (кнопка-шеврон в toolbar).
 *
 * Открытие и закрытие СИММЕТРИЧНЫ:
 *   railExpanded меняется → в том же тике React:
 *     • useEffect → shellExpanded + contentExpanded = railExpanded (без setTimeout/rAF-очередей)
 *     • useEffect → --gg-rail-w = 248px | 76px на documentElement
 *   Вся плавность — только CSS: --shell-dur (280ms), --shell-ease в layout.css.
 *
 * Группы и «Скрытые»: expanded = contentExpanded && localOpen — при свёрнутом rail
 *   папки визуально закрыты; состояние в БД / hiddenOpen не сбрасываем.
 *
 * ЗАПРЕЩЕНО: staged setTimeout между shell/content/шириной; разная логика open vs close;
 *   анимировать ширину в JS; отдельные transition-duration для open/close.
 *
 * Skill: .grok/skills/verstak/SKILL.md → «Контракт анимации rail».
 */

function readRailExpanded(): boolean {
  try {
    return localStorage.getItem(RAIL_EXPANDED_KEY) === '1'
  } catch {
    return false
  }
}

function clampRailWidth(width: number): number {
  if (!Number.isFinite(width)) return RAIL_WIDTH_EXPANDED
  return Math.min(RAIL_WIDTH_MAX, Math.max(RAIL_WIDTH_EXPANDED, Math.round(width)))
}

function readRailWidth(): number {
  try {
    return clampRailWidth(parseInt(localStorage.getItem(RAIL_WIDTH_KEY) || '', 10))
  } catch {
    return RAIL_WIDTH_EXPANDED
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
  activePath: string | null,
  includeHidden = false
): RailView {
  const visibleProjects = includeHidden ? projects : projects.filter(p => !p.hidden)
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

function readPinnedProjects(): string[] {
  try {
    const raw = localStorage.getItem(RAIL_PINNED_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function clampProjectMenuPos(x: number, y: number): { left: number; top: number } {
  const pad = 8
  const maxX = Math.max(pad, window.innerWidth - PROJECT_MENU_W - pad)
  const maxY = Math.max(pad, window.innerHeight - PROJECT_MENU_H - pad)
  return { left: Math.min(Math.max(pad, x), maxX), top: Math.min(Math.max(pad, y), maxY) }
}

interface ProjectChipProps {
  project: ProjectMeta
  active: boolean
  unread: boolean
  streaming: boolean
  interrupted: boolean
  shellExpanded: boolean
  contentExpanded: boolean
  nested?: boolean
  pinned?: boolean
  draggable?: boolean
  onClick: () => void
  onSettings: () => void
  onContextMenu: (e: MouseEvent) => void
  onDragStart?: (e: DragEvent, projectPath: string) => void
}

function ProjectChip({
  project,
  active,
  unread,
  streaming,
  interrupted,
  shellExpanded,
  contentExpanded,
  nested,
  pinned,
  draggable,
  onClick,
  onSettings,
  onContextMenu,
  onDragStart
}: ProjectChipProps) {
  const [hover, setHover] = useState(false)
  const status = interrupted ? 'interrupted' : streaming ? 'streaming' : unread ? 'unread' : null
  const statusTitle = interrupted
    ? 'Работа была прервана - открой проект для восстановления'
    : streaming
      ? 'AI работает в этом проекте'
      : unread
        ? 'Есть новый ответ'
        : undefined

  return (
    <div
      className={`gg-rail-chip ${active ? 'is-active' : ''} ${status ? `is-status-${status}` : ''} ${project.accentColor ? 'has-project-accent' : ''} ${shellExpanded ? 'is-shell-expanded' : ''} ${contentExpanded ? 'is-expanded' : ''} ${nested ? 'is-nested' : ''} ${pinned ? 'is-pinned' : ''}`}
      style={project.accentColor ? { '--project-accent': project.accentColor } as CSSProperties : undefined}
      data-project-status={status ?? 'idle'}
      data-project-active={active ? 'true' : 'false'}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={e => onDragStart?.(e, project.path)}
    >
      <button
        type="button"
        className="gg-rail-chip-btn"
        onClick={onClick}
      >
        <span
          className={`gg-rail-avatar-wrap ${status ? `is-status-${status}` : ''}`}
          title={statusTitle}
        >
          <ProjectAvatar project={project} className="gg-rail-avatar" size={34} />
          {streaming && (
            <span className="gg-rail-status-arc" aria-hidden="true">
              <svg viewBox="0 0 34 34" focusable="false">
                <circle className="gg-rail-status-arc-track" cx="17" cy="17" r="15.7" />
                <circle className="gg-rail-status-arc-sweep" cx="17" cy="17" r="15.7" />
              </svg>
            </span>
          )}
          {status && <span className="gg-rail-status-mark" aria-hidden="true" />}
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
  activeStreaming: boolean
  sessions: Record<string, { hasUnread?: boolean; isStreaming?: boolean } | undefined>
  isProjectInterrupted: (projectPath: string) => boolean
  shellExpanded: boolean
  contentExpanded: boolean
  collapsedOpen: boolean
  onToggleCollapsed: (group: ProjectGroup) => void
  onToggleCollapsedOpen: (groupId: number) => void
  onEdit: (group: ProjectGroup) => void
  onSelectProject: (path: string) => void
  onProjectSettings: (project: ProjectMeta) => void
  onProjectContextMenu: (e: MouseEvent, project: ProjectMeta) => void
  onProjectDragStart: (e: DragEvent, projectPath: string) => void
  onDropProjectToGroup: (projectPath: string, groupId: number) => void
}

function ProjectGroupBlock({
  group,
  projects,
  activePath,
  activeStreaming,
  sessions,
  isProjectInterrupted,
  shellExpanded,
  contentExpanded,
  collapsedOpen,
  onToggleCollapsed,
  onToggleCollapsedOpen,
  onEdit,
  onSelectProject,
  onProjectSettings,
  onProjectContextMenu,
  onProjectDragStart,
  onDropProjectToGroup
}: ProjectGroupBlockProps) {
  const t = useT()
  const [hover, setHover] = useState(false)
  /** Свёрнутая панель → группы визуально закрыты; состояние в БД не трогаем. */
  const expanded = contentExpanded && !group.collapsed
  const bodyOpen = expanded || collapsedOpen
  const hasActive = projects.some(p => p.path === activePath)

  function handleGroupToggle() {
    if (!contentExpanded) {
      onToggleCollapsedOpen(group.id)
      return
    }
    onToggleCollapsed(group)
  }

  return (
    <div
      className={`gg-rail-group ${expanded ? 'is-open' : ''} ${collapsedOpen ? 'is-collapsed-open' : ''} ${shellExpanded ? 'is-shell-expanded' : ''} ${contentExpanded ? 'is-expanded' : ''} ${hasActive ? 'has-active' : ''}`}
      onDragOver={e => {
        if (!e.dataTransfer.types.includes('text/project-path')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      }}
      onDrop={e => {
        const projectPath = e.dataTransfer.getData('text/project-path')
        if (!projectPath) return
        e.preventDefault()
        onDropProjectToGroup(projectPath, group.id)
      }}
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
          aria-expanded={bodyOpen}
        >
          <svg
            className={`gg-rail-group-chevron ${bodyOpen ? 'is-open' : ''}`}
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
      {bodyOpen && (
        <div className="gg-rail-group-body">
          {projects.map(p => {
            const session = sessions[p.path]
            const streaming = activePath === p.path ? activeStreaming || !!session?.isStreaming : !!session?.isStreaming
            return (
              <ProjectChip
                key={p.path}
                project={p}
                active={activePath === p.path}
                unread={!!session?.hasUnread}
                streaming={streaming}
                interrupted={isProjectInterrupted(p.path)}
                shellExpanded={shellExpanded}
                contentExpanded={contentExpanded}
                nested
                draggable
                onClick={() => onSelectProject(p.path)}
                onSettings={() => onProjectSettings(p)}
                onContextMenu={e => onProjectContextMenu(e, p)}
                onDragStart={onProjectDragStart}
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
  onOpenHelp: () => void
  sidebarOpen: boolean
  onToggleSidebar: () => void
}

export function ProjectRail({ onOpenProjectSettings, onOpenAppSettings, onOpenHelp, sidebarOpen, onToggleSidebar }: ProjectRailProps) {
  const t = useT()
  const {
    path,
    projectList,
    sessions,
    setProject,
    refreshProjectList,
    helpMode,
    help,
    resumableRuns,
    isStreaming,
  } = useProject()
  const [startupInterruptedPaths, setStartupInterruptedPaths] = useState<Set<string>>(() => new Set())
  const interruptedPaths = useMemo(() => {
    const paths = new Set<string>()
    if (path && resumableRuns.length > 0) paths.add(path)
    return paths
  }, [path, resumableRuns.length])
  const activeInterruptedPath = !helpMode && path && resumableRuns.length > 0 ? path : null
  const isProjectInterrupted = (projectPath: string) => {
    if (!helpMode && path === projectPath) return activeInterruptedPath === projectPath
    return interruptedPaths.has(projectPath) || startupInterruptedPaths.has(projectPath)
  }
  const [bootstrapped, setBootstrapped] = useState(false)
  const initialRailExpanded = readRailExpanded()
  const [railExpanded, setRailExpanded] = useState(initialRailExpanded)
  const [railWidth, setRailWidth] = useState(() => readRailWidth())
  const [shellExpanded, setShellExpanded] = useState(initialRailExpanded)
  const [contentExpanded, setContentExpanded] = useState(initialRailExpanded)
  const [projectQuery, setProjectQuery] = useState('')
  const [projectFilter, setProjectFilter] = useState<ProjectRailFilter>('default')
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([])
  const [collapsedOpenGroupId, setCollapsedOpenGroupId] = useState<number | null>(null)
  const [showCreateClient, setShowCreateClient] = useState(false)
  const [groupModal, setGroupModal] = useState<{ mode: 'create' } | { mode: 'edit'; group: ProjectGroup } | null>(null)
  const [createMenu, setCreateMenu] = useState<CreateMenuState>(null)
  const [projectMenu, setProjectMenu] = useState<ProjectMenuState | null>(null)
  const [pinnedPaths, setPinnedPaths] = useState<string[]>(() => readPinnedProjects())
  const createMenuRef = useRef<HTMLDivElement | null>(null)
  const projectMenuRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const filteredProjectList = useMemo(() => {
    if (projectFilter === 'archive') return projectList.filter(p => p.hidden)
    if (projectFilter === 'default') return projectList
    return projectList.filter(p => !p.hidden && (p.status ?? 'active') === projectFilter)
  }, [projectFilter, projectList])

  const railView = useMemo(
    () => buildRailView(projectGroups, filteredProjectList, projectQuery, path, projectFilter === 'archive'),
    [projectGroups, filteredProjectList, projectQuery, path, projectFilter]
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
  const pinnedProjects = useMemo(() => {
    const byPath = new Map(filteredProjectList.filter(p => !p.hidden).map(p => [p.path, p]))
    const q = projectQuery.trim().toLowerCase()
    return pinnedPaths
      .map(projectPath => byPath.get(projectPath))
      .filter((p): p is ProjectMeta => !!p)
      .filter(p => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
  }, [pinnedPaths, filteredProjectList, projectQuery])
  const pinnedSet = useMemo(() => new Set(pinnedProjects.map(p => p.path)), [pinnedProjects])

  useEffect(() => {
    if (contentExpanded) setCollapsedOpenGroupId(null)
  }, [contentExpanded])

  useEffect(() => {
    if (!collapsedOpenGroupId) return
    const exists = railView.groups.some(({ group }) => group.id === collapsedOpenGroupId)
    if (!exists) setCollapsedOpenGroupId(null)
  }, [collapsedOpenGroupId, railView.groups])

  useEffect(() => {
    try {
      localStorage.setItem(RAIL_PINNED_KEY, JSON.stringify(pinnedPaths))
    } catch { /* ignore */ }
  }, [pinnedPaths])

  useEffect(() => {
    if (!createMenu && !projectMenu) return
    const close = () => {
      setCreateMenu(null)
      setProjectMenu(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (createMenuRef.current?.contains(target)) return
      if (projectMenuRef.current?.contains(target)) return
      close()
    }
    const timer = window.setTimeout(() => {
      window.addEventListener('pointerdown', onPointerDown, true)
    }, 0)
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [createMenu, projectMenu])

  useEffect(() => {
    const projectPaths = projectList.map(p => p.path)
    if (projectPaths.length === 0) {
      setStartupInterruptedPaths(new Set())
      return
    }

    let cancelled = false
    void (async () => {
      const found = new Set<string>()
      await Promise.all(projectPaths.map(async projectPath => {
        try {
          const resumable = await window.api.agentRuns.listResumable(projectPath)
          if (resumable.length > 0) {
            found.add(projectPath)
            return
          }

        } catch {
          // Startup indicator scan is best-effort; opening the project still hydrates exact state.
        }
      }))
      if (!cancelled) setStartupInterruptedPaths(found)
    })()

    return () => { cancelled = true }
  }, [projectList])

  useEffect(() => {
    if (!path || activeInterruptedPath || !startupInterruptedPaths.has(path)) return
    setStartupInterruptedPaths(prev => {
      const next = new Set(prev)
      next.delete(path)
      return next
    })
  }, [activeInterruptedPath, path, startupInterruptedPaths])

  async function refreshGroups() {
    const list = await window.api.projects.listGroups()
    setProjectGroups(list)
  }

  useEffect(() => {
    const onGroupsChanged = () => {
      void refreshGroups()
    }
    window.addEventListener('gg-project-groups-changed', onGroupsChanged)
    return () => window.removeEventListener('gg-project-groups-changed', onGroupsChanged)
  }, [])

  function openSearch() {
    setRailExpanded(true)
    window.setTimeout(() => searchRef.current?.focus(), 180)
  }

  useEffect(() => {
    document.body.classList.add('gg-rail-toggling')
    const timers: number[] = []
    const finishTimer = window.setTimeout(() => {
      document.body.classList.remove('gg-rail-toggling')
    }, RAIL_TOGGLE_MS)
    timers.push(finishTimer)

    if (railExpanded) {
      document.documentElement.style.setProperty('--gg-rail-w', `${railWidth}px`)
      setShellExpanded(true)
      const contentTimer = window.setTimeout(() => {
        setContentExpanded(true)
      }, RAIL_EXPAND_CONTENT_DELAY_MS)
      timers.push(contentTimer)
    } else {
      setContentExpanded(false)
      const collapseTimer = window.setTimeout(() => {
        setShellExpanded(false)
        document.documentElement.style.setProperty('--gg-rail-w', RAIL_WIDTH_COLLAPSED)
      }, RAIL_COLLAPSE_DELAY_MS)
      timers.push(collapseTimer)
    }

    try {
      localStorage.setItem(RAIL_EXPANDED_KEY, railExpanded ? '1' : '0')
    } catch { /* ignore */ }
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
      document.body.classList.remove('gg-rail-toggling')
    }
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

  function openCreateMenu(e: MouseEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    setCreateMenu({ x: rect.left, y: rect.bottom + 8 })
  }

  function openProjectMenu(e: MouseEvent, project: ProjectMeta) {
    e.preventDefault()
    e.stopPropagation()
    setProjectMenu({ x: e.clientX, y: e.clientY, project })
  }

  function togglePinned(projectPath: string) {
    setPinnedPaths(current => current.includes(projectPath)
      ? current.filter(path => path !== projectPath)
      : [projectPath, ...current].slice(0, 8)
    )
  }

  async function setProjectArchived(project: ProjectMeta, archived: boolean) {
    setProjectMenu(null)
    const updated = await useProject.getState().updateProjectMeta(project.path, { hidden: archived })
    if (updated) {
      await refreshProjectList()
      if (archived) setPinnedPaths(current => current.filter(path => path !== project.path))
    }
  }

  function handleProjectDragStart(e: DragEvent, projectPath: string) {
    e.dataTransfer.setData('text/project-path', projectPath)
    e.dataTransfer.effectAllowed = 'move'
  }

  async function moveProjectToGroup(projectPath: string, targetGroupId: number | null) {
    const latestGroups = await window.api.projects.listGroups()
    const currentGroup = latestGroups.find(group => group.projectPaths.includes(projectPath)) ?? null
    const targetGroup = targetGroupId === null ? null : latestGroups.find(group => group.id === targetGroupId) ?? null
    if (targetGroupId !== null && !targetGroup) return
    if ((currentGroup?.id ?? null) === (targetGroup?.id ?? null)) return

    if (currentGroup) {
      const result = await window.api.projects.updateGroup(currentGroup.id, {
        projectPaths: currentGroup.projectPaths.filter(path => path !== projectPath)
      })
      if (!result.ok) return
    }
    if (targetGroup) {
      const result = await window.api.projects.updateGroup(targetGroup.id, {
        projectPaths: targetGroup.projectPaths.includes(projectPath)
          ? targetGroup.projectPaths
          : [...targetGroup.projectPaths, projectPath]
      })
      if (!result.ok) return
    }
    await refreshGroups()
    window.dispatchEvent(new CustomEvent('gg-project-groups-changed'))
  }

  async function handleToggleGroupCollapsed(group: ProjectGroup) {
    const result = await window.api.projects.updateGroup(group.id, { collapsed: !group.collapsed })
    if (result.ok) await refreshGroups()
  }

  function handleToggleCollapsedGroupOpen(groupId: number) {
    setCollapsedOpenGroupId(current => current === groupId ? null : groupId)
  }

  function handleRailResizeStart(e: MouseEvent<HTMLDivElement>) {
    if (!railExpanded) return
    e.preventDefault()
    const startX = e.clientX
    const startWidth = railWidth
    document.body.classList.add('gg-rail-resizing')

    const onMove = (event: globalThis.MouseEvent) => {
      const next = clampRailWidth(startWidth + event.clientX - startX)
      setRailWidth(next)
      document.documentElement.style.setProperty('--gg-rail-w', `${next}px`)
    }
    const onUp = () => {
      document.body.classList.remove('gg-rail-resizing')
      try {
        localStorage.setItem(RAIL_WIDTH_KEY, String(readRailWidthFromStyle()))
      } catch { /* ignore */ }
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    const readRailWidthFromStyle = () => {
      const raw = document.documentElement.style.getPropertyValue('--gg-rail-w')
      return clampRailWidth(parseInt(raw || String(railWidth), 10))
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
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
                onClick={openCreateMenu}
                title="Создать"
                aria-label="Создать проект или папку"
                tabIndex={contentExpanded ? 0 : -1}
              >
                +
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
          <div className="gg-rail-filter-tabs" aria-label="Фильтр проектов">
            {[
              ['default', 'Все'],
              ['active', 'Активные'],
              ['paused', 'Пауза'],
              ['done', 'Завершённые'],
              ['archive', 'Архив']
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={projectFilter === value ? 'is-active' : ''}
                onClick={() => setProjectFilter(value as ProjectRailFilter)}
                tabIndex={contentExpanded ? 0 : -1}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="gg-rail-list">
        {listEmpty && hasActiveFilter && (
          <div className="gg-rail-empty">{t.rail.noResults}</div>
        )}
        {pinnedProjects.length > 0 && (
          <div className={`gg-rail-pinned ${contentExpanded ? 'is-expanded' : ''}`}>
            <div className="gg-rail-pinned-title" aria-hidden={!contentExpanded}>Закреплённые</div>
            {pinnedProjects.map(p => {
              const session = sessions[p.path]
              const streaming = !helpMode && path === p.path ? isStreaming || !!session?.isStreaming : !!session?.isStreaming
              return (
                <ProjectChip
                  key={`pinned-${p.path}`}
                  project={p}
                  active={!helpMode && path === p.path}
                  unread={!!session?.hasUnread}
                  streaming={streaming}
                  interrupted={isProjectInterrupted(p.path)}
                  shellExpanded={shellExpanded}
                  contentExpanded={contentExpanded}
                  pinned
                  draggable
                  onClick={() => { if (helpMode || path !== p.path) void setProject(p.path) }}
                  onSettings={() => onOpenProjectSettings(p)}
                  onContextMenu={e => openProjectMenu(e, p)}
                  onDragStart={handleProjectDragStart}
                />
              )
            })}
          </div>
        )}
        {railView.groups.map(({ group, projects }) => {
          const visibleProjects = projects.filter(project => !pinnedSet.has(project.path))
          if (visibleProjects.length === 0) return null
          return (
          <ProjectGroupBlock
            key={group.id}
            group={group}
            projects={visibleProjects}
            activePath={helpMode ? null : path}
            activeStreaming={!helpMode && isStreaming}
            sessions={sessions}
            isProjectInterrupted={isProjectInterrupted}
            shellExpanded={shellExpanded}
            contentExpanded={contentExpanded}
            collapsedOpen={!contentExpanded && collapsedOpenGroupId === group.id}
            onToggleCollapsed={g => void handleToggleGroupCollapsed(g)}
            onToggleCollapsedOpen={handleToggleCollapsedGroupOpen}
            onEdit={g => setGroupModal({ mode: 'edit', group: g })}
            onSelectProject={p => { if (helpMode || path !== p) void setProject(p) }}
            onProjectSettings={onOpenProjectSettings}
            onProjectContextMenu={openProjectMenu}
            onProjectDragStart={handleProjectDragStart}
            onDropProjectToGroup={(projectPath, groupId) => void moveProjectToGroup(projectPath, groupId)}
          />
          )
        })}
        <div
          className="gg-rail-ungrouped-drop"
          onDragOver={e => {
            if (!e.dataTransfer.types.includes('text/project-path')) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
          }}
          onDrop={e => {
            const projectPath = e.dataTransfer.getData('text/project-path')
            if (!projectPath) return
            e.preventDefault()
            void moveProjectToGroup(projectPath, null)
          }}
        >
        {railView.ungrouped.filter(project => !pinnedSet.has(project.path)).map(p => {
          const session = sessions[p.path]
          const streaming = !helpMode && path === p.path ? isStreaming || !!session?.isStreaming : !!session?.isStreaming
          return (
            <ProjectChip
              key={p.path}
              project={p}
              active={!helpMode && path === p.path}
              unread={!!session?.hasUnread}
              streaming={streaming}
              interrupted={isProjectInterrupted(p.path)}
              shellExpanded={shellExpanded}
              contentExpanded={contentExpanded}
              draggable
              onClick={() => { if (helpMode || path !== p.path) void setProject(p.path) }}
              onSettings={() => onOpenProjectSettings(p)}
              onContextMenu={e => openProjectMenu(e, p)}
              onDragStart={handleProjectDragStart}
            />
          )
        })}
        </div>
        {projectFilter === 'default' && hiddenProjects.length > 0 && (() => {
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
              <span className="gg-rail-hidden-label" aria-hidden={!contentExpanded}>{t.rail.hiddenProjects}</span>
              <span className="gg-rail-hidden-count" aria-hidden={!contentExpanded}>{hiddenProjects.length}</span>
            </button>
            {hiddenExpanded && hiddenProjects.map(p => {
              const session = sessions[p.path]
              const streaming = !helpMode && path === p.path ? isStreaming || !!session?.isStreaming : !!session?.isStreaming
              return (
                <ProjectChip
                  key={p.path}
                  project={p}
                  active={!helpMode && path === p.path}
                  unread={!!session?.hasUnread}
                  streaming={streaming}
                  interrupted={isProjectInterrupted(p.path)}
                  shellExpanded={shellExpanded}
                  contentExpanded={contentExpanded}
                  nested
                  draggable
                  onClick={() => { if (helpMode || path !== p.path) void setProject(p.path) }}
                  onSettings={() => onOpenProjectSettings(p)}
                  onContextMenu={e => openProjectMenu(e, p)}
                  onDragStart={handleProjectDragStart}
                />
              )
            })}
          </div>
          )
        })()}
        <button
          type="button"
          className="gg-rail-add"
          onClick={openCreateMenu}
          title={t.rail.createClient}
        >
          <span className="gg-rail-add-icon" aria-hidden>+</span>
          <span className="gg-rail-add-label" aria-hidden={!contentExpanded}>{t.rail.createClient}</span>
        </button>
      </div>

      <div className="gg-rail-footer">
        <UpdateNotification railExpanded={contentExpanded} />
        <div className="gg-rail-footer-actions">
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
          <button
            type="button"
            className={`gg-rail-help-btn ${helpMode ? 'is-active' : ''}`}
            onClick={onOpenHelp}
            title={t.help.title}
            aria-label={t.help.title}
            aria-pressed={helpMode}
          >
            <span className={`gg-rail-help-status-wrap ${help.isStreaming ? 'is-status-streaming' : help.hasUnread ? 'is-status-unread' : ''}`}>
              <span className="gg-rail-help-icon" aria-hidden>?</span>
            </span>
          </button>
        </div>
      </div>
      {shellExpanded && (
        <div
          className="gg-rail-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Изменить ширину панели проектов"
          onMouseDown={handleRailResizeStart}
        />
      )}
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
    {createMenu && typeof document !== 'undefined' && createPortal(
      <div
        ref={createMenuRef}
        className="gg-rail-menu gg-rail-create-menu"
        style={clampProjectMenuPos(createMenu.x, createMenu.y)}
        role="menu"
      >
        <button type="button" role="menuitem" onClick={() => { setCreateMenu(null); setShowCreateClient(true) }}>
          Новый проект
        </button>
        <button type="button" role="menuitem" onClick={() => { setCreateMenu(null); setShowCreateClient(true) }}>
          Открыть папку
        </button>
        <button type="button" role="menuitem" onClick={() => { setCreateMenu(null); setGroupModal({ mode: 'create' }) }}>
          Новая папка
        </button>
      </div>,
      document.body
    )}
    {projectMenu && typeof document !== 'undefined' && createPortal(
      <div
        ref={projectMenuRef}
        className="gg-rail-menu gg-rail-project-menu"
        style={clampProjectMenuPos(projectMenu.x, projectMenu.y)}
        role="menu"
        onContextMenu={e => e.preventDefault()}
      >
        <button type="button" role="menuitem" onClick={() => { const project = projectMenu.project; setProjectMenu(null); onOpenProjectSettings(project) }}>
          Настройки
        </button>
        <button type="button" role="menuitem" onClick={() => { togglePinned(projectMenu.project.path); setProjectMenu(null) }}>
          {pinnedPaths.includes(projectMenu.project.path) ? 'Открепить' : 'Закрепить'}
        </button>
        <button type="button" role="menuitem" onClick={() => void setProjectArchived(projectMenu.project, !projectMenu.project.hidden)}>
          {projectMenu.project.hidden ? 'Вернуть из архива' : 'В архив'}
        </button>
      </div>,
      document.body
    )}
    </>
  )
}
