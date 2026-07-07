import { useCallback, useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'
import type { Skill, SkillUsageRecord } from '../types/api'

const SOURCE_LABELS: Record<Skill['source'] | 'archived', string> = {
  'built-in': 'Встроенные',
  user: 'Пользовательские',
  server: 'Серверные',
  archived: 'Архив'
}

export function SkillsView({ onActivateSkill }: { onActivateSkill: (slash: string) => void }) {
  const t = useT()
  const [skills, setSkills] = useState<Skill[]>([])
  const [usage, setUsage] = useState<SkillUsageRecord[]>([])
  const [filter, setFilter] = useState('')

  const refresh = useCallback(async () => {
    const [nextSkills, nextUsage] = await Promise.all([
      window.api.skills.list(),
      window.api.skills.usage()
    ])
    setSkills(Array.isArray(nextSkills) ? nextSkills : [])
    setUsage(Array.isArray(nextUsage) ? nextUsage : [])
  }, [])

  useEffect(() => {
    void refresh().catch(() => {})
  }, [refresh])

  const usageById = useMemo(() => new Map(usage.map(u => [u.skillId, u])), [usage])
  const visibleSkillIds = useMemo(() => new Set(skills.map(s => s.id)), [skills])
  const query = filter.trim().toLowerCase()

  const filtered = query
    ? skills.filter(s =>
        (s.name ?? s.id).toLowerCase().includes(query) ||
        s.description?.toLowerCase().includes(query) ||
        s.source.toLowerCase().includes(query)
      )
    : skills
  const archived = usage.filter(u =>
    u.state === 'archived' &&
    !visibleSkillIds.has(u.skillId) &&
    (!query || u.skillId.toLowerCase().includes(query))
  )

  const grouped = (['built-in', 'user', 'server'] as Skill['source'][]).map(source => ({
    source,
    skills: filtered.filter(s => s.source === source)
  })).filter(g => g.skills.length > 0)

  const archiveSkill = async (id: string) => {
    await window.api.skills.archive(id)
    await refresh()
  }

  const restoreSkill = async (id: string) => {
    await window.api.skills.restore(id)
    await refresh()
  }

  return (
    <div className="gg-skills-view">
      <div className="gg-skills-header">
        <h2>{t.views.skillsTitle}</h2>
        <input
          className="gg-input"
          placeholder="Найти скилл..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      </div>
      {grouped.map(group => (
        <section className="gg-skills-section" key={group.source}>
          <div className="gg-skills-section-title">{SOURCE_LABELS[group.source]}</div>
          <div className="gg-skills-grid">
            {group.skills.map(s => {
              const stat = usageById.get(s.id)
              return (
                <div key={s.id} className="gg-skill-card">
                  <button
                    type="button"
                    className="gg-skill-card-main"
                    onClick={() => onActivateSkill(s.slash ?? s.id)}
                    title={s.slash ? `/${s.slash}` : s.id}
                  >
                    <div className="gg-skill-card-icon">{s.icon ?? '⚡'}</div>
                    <div className="gg-skill-card-body">
                      <div className="gg-skill-card-name">{s.name ?? s.id}</div>
                      <div className="gg-skill-card-desc">{s.description ?? ''}</div>
                    </div>
                  </button>
                  <div className="gg-skill-card-meta">
                    {s.slash && <span className="gg-skill-slash">/{s.slash}</span>}
                    <span className={`gg-skill-source gg-skill-source-${s.source}`}>{s.source}</span>
                    {!!stat?.useCount && <span className="gg-skill-usage">{stat.useCount}×</span>}
                    <button type="button" className="gg-skill-action" onClick={() => void archiveSkill(s.id)}>Архив</button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ))}
      {archived.length > 0 && (
        <section className="gg-skills-section">
          <div className="gg-skills-section-title">{SOURCE_LABELS.archived}</div>
          <div className="gg-skills-grid">
            {archived.map(u => (
              <div key={u.skillId} className="gg-skill-card is-archived">
                <div className="gg-skill-card-main">
                  <div className="gg-skill-card-icon">📦</div>
                  <div className="gg-skill-card-body">
                    <div className="gg-skill-card-name">{u.skillId}</div>
                    <div className="gg-skill-card-desc">Скрыт из активного списка</div>
                  </div>
                </div>
                <div className="gg-skill-card-meta">
                  <span className="gg-skill-source gg-skill-source-archived">archived</span>
                  {!!u.useCount && <span className="gg-skill-usage">{u.useCount}×</span>}
                  <button type="button" className="gg-skill-action" onClick={() => void restoreSkill(u.skillId)}>Вернуть</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      {grouped.length === 0 && archived.length === 0 && (
        <div className="gg-skills-empty">
          <p>Скиллы не найдены.</p>
        </div>
      )}
    </div>
  )
}
