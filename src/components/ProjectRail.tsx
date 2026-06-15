import { useEffect, useMemo, useRef, useState } from 'react'
import { useProject } from '../store/projectStore'
import type { ProjectMeta } from '../types/api'
import iconUrl from '../assets/icon.png'
import { ProjectAvatar } from './ProjectAvatar'
import { SettingsGearIcon } from './SettingsGearIcon'
import { UpdateNotification } from './UpdateNotification'
import { CreateClientModal } from './CreateClientModal'
import { useT } from '../i18n'

const RAIL_EXPANDED_KEY = 'gg-rail-expanded'
const RAIL_WIDTH_COLLAPSED = '68px'
const RAIL_WIDTH_EXPANDED = '248px'

function readRailExpanded(): boolean {
  try {
    return localStorage.getItem(RAIL_EXPANDED_KEY) === '1'
  } catch {
    return false
  }
}

function filterProjects(list: ProjectMeta[], query: string, activePath: string | null): ProjectMeta[] {
  const q = query.trim().toLowerCase()
  if (!q) return list
  const matches = list.filter(
    p => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)
  )
  if (activePath && !matches.some(p => p.path === activePath)) {
    const active = list.find(p => p.path === activePath)
    if (active) return [active, ...matches]
  }
  return matches
}

interface ProjectChipProps {
  project: ProjectMeta
  active: boolean
  unread: boolean
  streaming: boolean
  expanded: boolean
  onClick: () => void
  onSettings: () => void
}

function ProjectChip({ project, active, unread, streaming, expanded, onClick, onSettings }: ProjectChipProps) {
  const [hover, setHover] = useState(false)
  const status = streaming ? 'streaming' : unread ? 'unread' : null

  return (
    <div
      className={`gg-rail-chip ${active ? 'is-active' : ''} ${expanded ? 'is-expanded' : ''}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={expanded ? project.path : `${project.name}\n${project.path}`}
    >
      <button
        type="button"
        className="gg-rail-chip-btn"
        onClick={onClick}
      >
        <span className="gg-rail-avatar-wrap">
          <ProjectAvatar project={project} className="gg-rail-avatar" size={expanded ? 36 : 40} />
          {status && (
            <span
              className={`gg-rail-status ${status === 'streaming' ? 'is-streaming' : 'is-unread'}`}
              title={streaming ? 'AI работает в этом проекте' : 'Есть новый ответ'}
            />
          )}
        </span>
        {expanded && (
          <span className="gg-rail-chip-text">
            <span className="gg-rail-label">{project.name}</span>
          </span>
        )}
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

interface ProjectRailProps {
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onOpenProjectSettings: (project: ProjectMeta) => void
  onOpenAppSettings: () => void
}

export function ProjectRail({ sidebarOpen, onToggleSidebar, onOpenProjectSettings, onOpenAppSettings }: ProjectRailProps) {
  const t = useT()
  const { path, projectList, sessions, setProject, refreshProjectList } = useProject()
  const [bootstrapped, setBootstrapped] = useState(false)
  const [railExpanded, setRailExpanded] = useState(readRailExpanded)
  const [projectQuery, setProjectQuery] = useState('')
  const [showCreateClient, setShowCreateClient] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const filteredProjects = useMemo(
    () => filterProjects(projectList, projectQuery, path),
    [projectList, projectQuery, path]
  )
  const showSearch = projectList.length >= 2
  const hasActiveFilter = projectQuery.trim().length > 0

  function openSearch() {
    setRailExpanded(true)
    window.setTimeout(() => searchRef.current?.focus(), 180)
  }

  useEffect(() => {
    document.documentElement.style.setProperty('--gg-rail-w', railExpanded ? RAIL_WIDTH_EXPANDED : RAIL_WIDTH_COLLAPSED)
    try {
      localStorage.setItem(RAIL_EXPANDED_KEY, railExpanded ? '1' : '0')
    } catch { /* ignore */ }
  }, [railExpanded])

  useEffect(() => {
    void (async () => {
      await refreshProjectList()
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

  async function handleClientOpened(path: string) {
    await setProject(path)
    await refreshProjectList()
  }

  return (
    <>
    <div className={`gg-rail ${railExpanded ? 'is-expanded' : ''}`}>
      <div className="gg-rail-top">
        <button
          type="button"
          className="gg-rail-home"
          onClick={() => useProject.getState().closeProject()}
          title="Главная"
        >
          <img src={iconUrl} alt="Verstak" />
        </button>
        {railExpanded && <span className="gg-rail-brand-name">Verstak</span>}
      </div>

      <div className={`gg-rail-toolbar ${railExpanded ? 'is-expanded' : ''}`}>
        <button
          type="button"
          className={`gg-rail-tool ${sidebarOpen ? 'is-on' : ''}`}
          onClick={onToggleSidebar}
          title={sidebarOpen ? 'Скрыть боковую панель (Ctrl+B)' : 'Показать боковую панель (Ctrl+B)'}
          aria-pressed={sidebarOpen}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <line x1="9" y1="4" x2="9" y2="20" />
          </svg>
        </button>
        <button
          type="button"
          className={`gg-rail-tool ${railExpanded ? 'is-on' : ''}`}
          onClick={() => setRailExpanded(v => !v)}
          title={railExpanded ? t.rail.collapsePanel : t.rail.expandPanel}
          aria-expanded={railExpanded}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {railExpanded ? (
              <polyline points="15 6 9 12 15 18" />
            ) : (
              <polyline points="9 6 15 12 9 18" />
            )}
          </svg>
        </button>
        {showSearch && (
          <button
            type="button"
            className={`gg-rail-tool ${hasActiveFilter ? 'is-on' : ''}`}
            onClick={openSearch}
            title={t.rail.search}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="11" cy="11" r="7" />
              <line x1="16.5" y1="16.5" x2="21" y2="21" />
            </svg>
          </button>
        )}
      </div>

      {railExpanded && (
        <div className="gg-rail-section-head">
          <span className="gg-rail-section-title">{t.rail.clients}</span>
          <span className="gg-rail-section-count">{filteredProjects.length}</span>
        </div>
      )}

      {railExpanded && showSearch && (
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
          />
          {hasActiveFilter && (
            <button
              type="button"
              className="gg-rail-search-clear"
              onClick={() => setProjectQuery('')}
              title={t.rail.clearSearch}
            >×</button>
          )}
        </div>
      )}

      <div className="gg-rail-list">
        {filteredProjects.length === 0 && hasActiveFilter && (
          <div className="gg-rail-empty">{t.rail.noResults}</div>
        )}
        {filteredProjects.map(p => {
          const session = sessions[p.path]
          return (
            <ProjectChip
              key={p.path}
              project={p}
              active={path === p.path}
              unread={!!session?.hasUnread}
              streaming={!!session?.isStreaming}
              expanded={railExpanded}
              onClick={() => { if (path !== p.path) void setProject(p.path) }}
              onSettings={() => onOpenProjectSettings(p)}
            />
          )
        })}
        <button
          type="button"
          className="gg-rail-add"
          onClick={() => setShowCreateClient(true)}
          title={t.rail.createClient}
        >
          <span className="gg-rail-add-icon" aria-hidden>+</span>
          {railExpanded && <span className="gg-rail-add-label">{t.rail.createClient}</span>}
        </button>
      </div>

      <div className="gg-rail-footer">
        <UpdateNotification railExpanded={railExpanded} />
        <button
          type="button"
          className="gg-rail-app-settings"
          onClick={onOpenAppSettings}
          title={t.settings.title}
          aria-label={t.settings.title}
        >
          <SettingsGearIcon size={18} />
          {railExpanded && <span className="gg-rail-app-settings-label">{t.settings.title}</span>}
        </button>
      </div>
    </div>
    {showCreateClient && (
      <CreateClientModal
        onClose={() => setShowCreateClient(false)}
        onOpened={path => void handleClientOpened(path)}
      />
    )}
    </>
  )
}