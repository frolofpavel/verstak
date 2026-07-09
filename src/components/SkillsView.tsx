import { useCallback, useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'
import { useSkills } from '../store/skillStore'
import type { Skill, SkillImportPreviewResult, SkillUsageRecord } from '../types/api'

const SOURCE_LABELS: Record<Skill['source'] | 'archived', string> = {
  'built-in': 'Встроенные',
  user: 'Пользовательские',
  server: 'Серверные',
  archived: 'Архив'
}

const SEARCH_ALIASES: Record<string, string[]> = {
  минусация: ['минус', 'минус-слова', 'negative', 'поисков', 'площадк', 'rsya', 'рся'],
  минус: ['минусация', 'negative', 'поисков', 'площадк', 'рся'],
  семантика: ['семантическое', 'ядро', 'ключевые', 'wordstat', 'вордстат', 'direct-semantics'],
  ядро: ['семантика', 'ключевые', 'wordstat', 'вордстат'],
  аудит: ['проверка', 'анализ', 'метрика', 'conversions', 'конверсии', 'audit'],
  метрика: ['конверсии', 'цели', 'аудит', 'ym', 'yandex metrika'],
  вордстат: ['wordstat', 'семантика', 'ключевые', 'ядро'],
  рся: ['rsya', 'площадки', 'минусация', 'сети'],
  поиск: ['search', 'поисковые', 'минусация', 'кампания'],
  настройка: ['setup', 'campaign', 'кампания', 'direct']
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
}

function queryTerms(query: string): string[] {
  const base = normalizeSearchText(query)
    .split(/[^a-zа-я0-9_-]+/i)
    .map(part => part.trim())
    .filter(part => part.length >= 2)
  const all = new Set(base)
  for (const term of base) {
    for (const [key, aliases] of Object.entries(SEARCH_ALIASES)) {
      if (term.includes(key) || key.includes(term)) {
        aliases.forEach(alias => all.add(alias))
      }
    }
  }
  return [...all]
}

function skillHaystack(skill: Skill): string {
  return normalizeSearchText([
    skill.id,
    skill.name ?? '',
    skill.description ?? '',
    skill.slash ?? '',
    ...(skill.suggested_prompts ?? []),
    ...(skill.tools_allow ?? []),
    skill.systemPrompt
  ].join(' '))
}

function scoreSkill(skill: Skill, filter: string): number {
  const query = normalizeSearchText(filter)
  if (!query) return 1
  const haystack = skillHaystack(skill)
  let score = 0
  if (normalizeSearchText(skill.name ?? skill.id).includes(query)) score += 12
  if (normalizeSearchText(skill.description ?? '').includes(query)) score += 8
  if (haystack.includes(query)) score += 6
  for (const term of queryTerms(filter)) {
    if (haystack.includes(term)) score += term.length > 4 ? 3 : 1
  }
  return score
}

function sourceLabel(source: Skill['source']): string {
  if (source === 'built-in') return 'встроенный'
  if (source === 'server') return 'сервер'
  return 'локальный'
}

function compactPath(path: string): string {
  if (!path) return ''
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 3) return normalized
  return `.../${parts.slice(-3).join('/')}`
}

function pluralRu(count: number, one: string, few: string, many: string): string {
  const abs = Math.abs(count)
  const mod10 = abs % 10
  const mod100 = abs % 100
  if (mod100 >= 11 && mod100 <= 14) return many
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}

function ruleCountText(count: number): string {
  return `${count} ${pluralRu(count, 'правило', 'правила', 'правил')}`
}

function ImportPreviewModal({
  preview,
  busy,
  onCancel,
  onInstall
}: {
  preview: Extract<SkillImportPreviewResult, { ok: true }>
  busy: boolean
  onCancel: () => void
  onInstall: (replace: boolean) => void
}) {
  const conflicts = preview.skills.filter(skill => skill.existing)
  return (
    <div className="gg-modal-backdrop" onClick={onCancel}>
      <div className="gg-modal gg-skills-import-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="gg-modal-header">
          <div className="gg-modal-title">Проверка скиллов перед установкой</div>
          <button type="button" className="gg-modal-close" onClick={onCancel} disabled={busy}>×</button>
        </div>
        <div className="gg-modal-body">
          <div className="gg-skills-import-summary">
            <div className="gg-skills-import-summary-title">Что сейчас произойдёт</div>
            <div>
              Verstak проверил выбранный файл, папку или архив и нашёл {preview.skills.length} {pluralRu(preview.skills.length, 'скилл', 'скилла', 'скиллов')}.
              {conflicts.length > 0
                ? ' Один из них уже есть в базе, поэтому перед заменой нужно подтвердить действие.'
                : ' Конфликтов с установленными скиллами нет.'}
            </div>
            {conflicts.length > 0 && (
              <div className="gg-skills-import-summary-note">
                При замене текущий файл будет сохранён как backup, а новый вариант станет активным после обновления списка скиллов.
              </div>
            )}
          </div>
          <div className="gg-skills-import-list">
            {preview.skills.map(skill => (
              <div key={skill.id} className={`gg-skills-import-card${skill.existing ? ' has-conflict' : ''}`}>
                <div className="gg-skills-import-card-head">
                  <div>
                    <div className="gg-skills-import-kicker">Скилл из выбранного файла</div>
                    <div className="gg-skills-import-name">{skill.name || skill.id}</div>
                    <div className="gg-skills-import-id">ID: {skill.id}</div>
                  </div>
                  <span className={skill.existing ? 'gg-skills-import-badge is-conflict' : 'gg-skills-import-badge'}>
                    {skill.existing ? 'есть конфликт' : 'новый'}
                  </span>
                </div>
                {skill.description && <div className="gg-skills-import-desc">{skill.description}</div>}
                <div className="gg-skills-import-path">Источник: {compactPath(skill.sourcePath)}</div>
                {skill.existing && (
                  <div className="gg-skills-import-existing-box">
                    <div className="gg-skills-import-kicker">Уже установлен в Verstak</div>
                    <div className="gg-skills-import-existing-name">{skill.existing.name || skill.existing.id}</div>
                    <div className="gg-skills-import-existing">
                      ID: {skill.existing.id} · источник: {sourceLabel(skill.existing.source)}
                    </div>
                    <div className="gg-skills-import-replace-note">
                      Если нажать «Заменить», этот установленный скилл будет заменён новым файлом выше.
                    </div>
                  </div>
                )}
                <div className="gg-skills-import-compare">
                  <div className="gg-skills-import-compare-title">
                    {skill.existing ? 'Что изменится при замене' : 'Что будет установлено'}
                  </div>
                  <div>{skill.comparison.summary}</div>
                  <div className="gg-skills-import-counts">
                    <span>Сейчас: {ruleCountText(skill.comparison.currentRuleCount)}</span>
                    <span>В новом: {ruleCountText(skill.comparison.incomingRuleCount)}</span>
                    <span>Совпадает: {ruleCountText(skill.comparison.sameRules.length)}</span>
                    <span>Добавится: {ruleCountText(skill.comparison.addedRules.length)}</span>
                    <span>Отличается: {ruleCountText(skill.comparison.changedRules.length)}</span>
                  </div>
                </div>
                {(skill.comparison.addedRules.length > 0 || skill.comparison.changedRules.length > 0) && (
                  <details className="gg-skills-import-details">
                    <summary>Показать конкретные отличия</summary>
                    {skill.comparison.addedRules.length > 0 && (
                      <div className="gg-skills-import-diff-block">
                        <div className="gg-skills-import-diff-title">Новые правила, которых не было в установленном скилле</div>
                        {skill.comparison.addedRules.slice(0, 5).map(rule => <div key={rule}>+ {rule}</div>)}
                      </div>
                    )}
                    {skill.comparison.changedRules.length > 0 && (
                      <div className="gg-skills-import-diff-block">
                        <div className="gg-skills-import-diff-title">Правила с отличающейся формулировкой</div>
                        {skill.comparison.changedRules.slice(0, 3).map((rule, index) => (
                          <div key={`${skill.id}-${index}`}>
                            <div>- {rule.current}</div>
                            <div>+ {rule.incoming}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </details>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="gg-modal-footer">
          <button type="button" className="gg-btn gg-btn-ghost" onClick={onCancel} disabled={busy}>Отмена</button>
          {conflicts.length > 0 && (
            <button type="button" className="gg-btn" onClick={() => onInstall(false)} disabled={busy}>
              Не заменять конфликтующие
            </button>
          )}
          <button type="button" className="gg-btn gg-btn-primary" onClick={() => onInstall(true)} disabled={busy}>
            {conflicts.length > 0 ? 'Заменить с backup' : 'Установить'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function SkillsView({ onActivateSkill }: { onActivateSkill: (slash: string) => void }) {
  const t = useT()
  const refreshStore = useSkills(s => s.refresh)
  const [skills, setSkills] = useState<Skill[]>([])
  const [usage, setUsage] = useState<SkillUsageRecord[]>([])
  const [filter, setFilter] = useState('')
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [preview, setPreview] = useState<Extract<SkillImportPreviewResult, { ok: true }> | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

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

  // Ilya: семантический поиск со скорингом (название/описание/содержимое + алиасы).
  const filtered = useMemo(() => {
    const query = filter.trim()
    return skills
      .map(skill => ({ skill, score: scoreSkill(skill, query) }))
      .filter(item => !query || item.score > 0)
      .sort((a, b) => b.score - a.score || (a.skill.name ?? a.skill.id).localeCompare(b.skill.name ?? b.skill.id))
      .map(item => item.skill)
  }, [filter, skills])

  // Наша governance: группировка по provenance (built-in / user / server).
  const grouped = useMemo(
    () => (['built-in', 'user', 'server'] as Skill['source'][])
      .map(source => ({ source, skills: filtered.filter(s => s.source === source) }))
      .filter(g => g.skills.length > 0),
    [filtered]
  )

  // Наша governance: архивные скиллы (в usage, но убраны из активного списка).
  const archived = useMemo(() => {
    const query = normalizeSearchText(filter)
    return usage.filter(u =>
      u.state === 'archived' &&
      !visibleSkillIds.has(u.skillId) &&
      (!query || normalizeSearchText(u.skillId).includes(query))
    )
  }, [usage, visibleSkillIds, filter])

  const selectedSkill = useMemo(() => {
    if (selectedSkillId) return skills.find(skill => skill.id === selectedSkillId) ?? null
    return filtered[0] ?? null
  }, [filtered, selectedSkillId, skills])
  const selectedUsage = selectedSkill ? usageById.get(selectedSkill.id) : undefined

  useEffect(() => {
    if (selectedSkillId && !skills.some(skill => skill.id === selectedSkillId)) {
      setSelectedSkillId(null)
    }
  }, [selectedSkillId, skills])

  async function handleImport() {
    setBusy(true)
    setNotice(null)
    try {
      const result = await window.api.skills.importPreview()
      if (!result.ok) {
        if (!result.cancelled) setNotice(result.error ?? 'Не удалось прочитать скиллы.')
        return
      }
      setPreview(result)
    } finally {
      setBusy(false)
    }
  }

  async function handleInstall(replace: boolean) {
    if (!preview) return
    setBusy(true)
    setNotice(null)
    try {
      const result = await window.api.skills.importCommit({ token: preview.token, replace })
      if (!result.ok) {
        setNotice(result.error)
        return
      }
      setPreview(null)
      await refreshStore()
      await refresh()
      const skipped = result.skipped.length > 0 ? ` Пропущено: ${result.skipped.length}.` : ''
      const backups = result.backups.length > 0 ? ` Backup: ${result.backups.length}.` : ''
      setNotice(`Установлено скиллов: ${result.installed.length}.${skipped}${backups}`)
    } finally {
      setBusy(false)
    }
  }

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
        <div>
          <h2>{t.views.skillsTitle}</h2>
          <p className="gg-skills-subtitle">Локальные, встроенные и серверные скиллы. Поиск смотрит название, описание и содержимое.</p>
        </div>
        <div className="gg-skills-actions">
          <input
            className="gg-input"
            placeholder="Поиск по названию или смыслу..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
          <button type="button" className="gg-btn gg-btn-primary" onClick={() => void handleImport()} disabled={busy}>
            Установить скилл
          </button>
        </div>
      </div>
      {notice && <div className="gg-skills-notice">{notice}</div>}
      <div className="gg-skills-layout">
        <div className="gg-skills-cards">
          {grouped.map(group => (
            <section className="gg-skills-section" key={group.source}>
              <div className="gg-skills-section-title">{SOURCE_LABELS[group.source]}</div>
              <div className="gg-skills-grid">
                {group.skills.map(s => {
                  const stat = usageById.get(s.id)
                  return (
                    <div key={s.id} className={`gg-skill-card${selectedSkill?.id === s.id ? ' is-selected' : ''}`}>
                      <button
                        type="button"
                        className="gg-skill-card-main"
                        onClick={() => setSelectedSkillId(s.id)}
                        title="Открыть карточку скилла"
                      >
                        <div className="gg-skill-card-icon">{s.icon ?? '◆'}</div>
                        <div className="gg-skill-card-body">
                          <div className="gg-skill-card-name">{s.name ?? s.id}</div>
                          <div className="gg-skill-card-desc">{s.description ?? ''}</div>
                        </div>
                      </button>
                      <div className="gg-skill-card-meta">
                        {s.slash && <span className="gg-skill-slash">/{s.slash}</span>}
                        <span className={`gg-skill-source gg-skill-source-${s.source}`}>{sourceLabel(s.source)}</span>
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
        </div>
        <aside className="gg-skill-detail" aria-live="polite">
          {selectedSkill ? (
            <>
              <div className="gg-skill-detail-head">
                <div className="gg-skill-detail-icon" aria-hidden>{selectedSkill.icon ?? '◆'}</div>
                <div className="gg-skill-detail-title-wrap">
                  <div className="gg-skills-import-kicker">Карточка скилла</div>
                  <h3>{selectedSkill.name ?? selectedSkill.id}</h3>
                  <div className="gg-skill-detail-meta">
                    {selectedSkill.slash && <span className="gg-skill-slash">/{selectedSkill.slash}</span>}
                    <span className={`gg-skill-source gg-skill-source-${selectedSkill.source}`}>{sourceLabel(selectedSkill.source)}</span>
                  </div>
                </div>
              </div>
              {selectedSkill.description && (
                <p className="gg-skill-detail-desc">{selectedSkill.description}</p>
              )}
              <div className="gg-skill-detail-actions">
                <button
                  type="button"
                  className="gg-btn gg-btn-primary"
                  onClick={() => onActivateSkill(selectedSkill.id)}
                >
                  Использовать в чате
                </button>
                <button
                  type="button"
                  className="gg-btn gg-btn-ghost"
                  onClick={() => navigator.clipboard?.writeText(selectedSkill.slash ? `/${selectedSkill.slash}` : selectedSkill.id).catch(() => {})}
                >
                  Скопировать команду
                </button>
                <button
                  type="button"
                  className="gg-btn gg-btn-ghost"
                  onClick={() => void archiveSkill(selectedSkill.id)}
                >
                  В архив
                </button>
              </div>
              <div className="gg-skill-detail-section">
                <div className="gg-skill-detail-section-title">Как будет применён</div>
                <div className="gg-skill-detail-note">
                  После нажатия скилл станет активным для следующего сообщения в чате и будет передан модели как рабочая инструкция.
                </div>
              </div>
              {(selectedSkill.tools_allow?.length ?? 0) > 0 && (
                <div className="gg-skill-detail-section">
                  <div className="gg-skill-detail-section-title">Инструменты</div>
                  <div className="gg-skill-detail-chips">
                    {selectedSkill.tools_allow?.map(tool => <span key={tool}>{tool}</span>)}
                  </div>
                </div>
              )}
              {(selectedSkill.suggested_prompts?.length ?? 0) > 0 && (
                <div className="gg-skill-detail-section">
                  <div className="gg-skill-detail-section-title">Подходит для запросов</div>
                  <div className="gg-skill-detail-prompts">
                    {selectedSkill.suggested_prompts?.slice(0, 8).map(prompt => <div key={prompt}>{prompt}</div>)}
                  </div>
                </div>
              )}
              <div className="gg-skill-detail-section">
                <div className="gg-skill-detail-section-title">Служебные данные</div>
                <div className="gg-skill-detail-kv">
                  <span>ID</span><strong>{selectedSkill.id}</strong>
                  <span>Режим</span><strong>{selectedSkill.default_mode ?? 'по умолчанию'}</strong>
                  <span>Провайдер</span><strong>{selectedSkill.default_provider ?? 'текущий'}</strong>
                  <span>Модель</span><strong>{selectedSkill.default_model ?? 'текущая'}</strong>
                  <span>Запусков</span><strong>{selectedUsage?.useCount ?? 0}</strong>
                </div>
              </div>
              <details className="gg-skill-detail-system">
                <summary>Показать рабочую инструкцию</summary>
                <pre>{selectedSkill.systemPrompt}</pre>
              </details>
            </>
          ) : (
            <div className="gg-skill-detail-empty">Выбери скилл слева, чтобы посмотреть описание и применить его в чате.</div>
          )}
        </aside>
      </div>
      {grouped.length === 0 && archived.length === 0 && (
        <div className="gg-skills-empty">
          <p>Скиллы не найдены. Попробуй другой запрос или установи скилл из файла, папки или архива.</p>
        </div>
      )}
      {preview && (
        <ImportPreviewModal
          preview={preview}
          busy={busy}
          onCancel={() => setPreview(null)}
          onInstall={replace => void handleInstall(replace)}
        />
      )}
    </div>
  )
}
