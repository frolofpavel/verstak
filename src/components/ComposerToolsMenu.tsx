import { useCallback, useEffect, useRef, useState } from 'react'
import { useProject } from '../store/projectStore'
import { useSkills } from '../store/skillStore'
import { composeReviewPayload } from '../lib/compose-review-payload'
import { MULTI_AGENT_LIST } from '../lib/multi-agent-templates'

const PROVIDER_LABELS: Record<string, string> = {
  'gemini-api': 'Gemini (API)',
  'gemini-cli': 'Gemini CLI',
  'claude': 'Claude (API)',
  'claude-cli': 'Claude Code',
  'grok': 'Grok (API)',
  'grok-cli': 'Grok Build',
  'openai': 'OpenAI',
  'codex-cli': 'Codex',
}
const KNOWN_PROVIDERS = Object.keys(PROVIDER_LABELS)

type SubId = 'skill' | 'review' | 'checkpoint' | 'multiagent' | 'worktree' | 'export'
type WorktreeStatus = { active: false } | { active: true; worktreePath: string; fileCount: number; hasChanges: boolean }

export function ComposerToolsMenu({
  onInject,
  onSaveHandoff,
  onExportTranscript,
  exportBusy = false,
}: {
  onInject: (text: string) => void
  onSaveHandoff?: () => Promise<void> | void
  onExportTranscript?: () => Promise<void> | void
  exportBusy?: boolean
}) {
  const path = useProject(s => s.path)
  const messages = useProject(s => s.messages)
  const activeChatId = useProject(s => s.activeChatId)
  const checkpointId = useProject(s => s.checkpointId)
  const checkpointMessageId = useProject(s => s.checkpointMessageId)
  const isStreaming = useProject(s => s.isStreaming)
  const helpMode = useProject(s => s.helpMode)
  const setCheckpoint = useProject(s => s.setCheckpoint)
  const pushActivity = useProject(s => s.pushActivity)
  const startReview = useProject(s => s.startReview)

  const skills = useSkills(s => s.skills)
  const activeSkillId = useSkills(s => s.activeSkillId)
  const loading = useSkills(s => s.loading)
  const lastRefreshAt = useSkills(s => s.lastRefreshAt)
  const serverReachable = useSkills(s => s.serverReachable)
  const setActiveSkill = useSkills(s => s.setActiveSkill)
  const refresh = useSkills(s => s.refresh)

  const [open, setOpen] = useState(false)
  const [openSub, setOpenSub] = useState<SubId | null>(null)
  const [defaultReviewer, setDefaultReviewer] = useState<string | null>(null)
  const [currentProvider, setCurrentProvider] = useState<string | null>(null)
  const [worktreeStatus, setWorktreeStatus] = useState<WorktreeStatus>({ active: false })
  const [worktreeBusy, setWorktreeBusy] = useState(false)
  const [worktreeErr, setWorktreeErr] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const activeSkill = activeSkillId ? skills.find(s => s.id === activeSkillId) : null
  const hasAssistantContent = messages.some(m => m.role === 'assistant' && m.content?.trim())
  const grouped = {
    server: skills.filter(s => s.source === 'server'),
    user: skills.filter(s => s.source === 'user'),
    'built-in': skills.filter(s => s.source === 'built-in'),
  }

  useEffect(() => {
    if (skills.length === 0 && !loading) void refresh()
  }, [skills.length, loading, refresh])

  useEffect(() => {
    let alive = true
    async function load() {
      const dr = await window.api.settings.getKey('default_review_provider')
      const cur = await window.api.settings.getKey('provider')
      if (alive) {
        setDefaultReviewer(dr)
        setCurrentProvider(cur)
      }
    }
    void load()
    const t = window.setInterval(load, 2000)
    return () => { alive = false; window.clearInterval(t) }
  }, [])

  useEffect(() => {
    if (open) return
    setOpenSub(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (openSub) setOpenSub(null)
        else setOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, openSub])

  const refreshWorktree = useCallback(() => {
    if (helpMode || activeChatId == null) {
      setWorktreeStatus({ active: false })
      return
    }
    void window.api.worktree.status(activeChatId)
      .then(setWorktreeStatus)
      .catch(() => setWorktreeStatus({ active: false }))
  }, [activeChatId, helpMode])

  useEffect(() => { refreshWorktree() }, [refreshWorktree, isStreaming])

  function toggleSub(id: SubId) {
    if (id === 'review' && !hasAssistantContent) return
    if (id === 'checkpoint' && !path) return
    if (id === 'worktree' && (helpMode || activeChatId == null)) return
    if (id === 'export' && (helpMode || activeChatId == null)) return
    setOpenSub(prev => (prev === id ? null : id))
  }

  async function runExport(action?: () => Promise<void> | void) {
    if (!action || exportBusy || activeChatId == null) return
    await action()
    setOpenSub(null)
    setOpen(false)
  }

  async function runWorktree(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setWorktreeBusy(true)
    setWorktreeErr(null)
    try {
      const result = await fn()
      if (!result.ok) {
        setWorktreeErr(result.error ?? 'Не удалось включить изоляцию')
        return false
      }
      refreshWorktree()
      return true
    } catch {
      setWorktreeErr('Не удалось включить изоляцию')
      return false
    } finally {
      setWorktreeBusy(false)
    }
  }

  async function isolateWorktree() {
    if (activeChatId == null || !path) return
    const ok = await runWorktree(() => window.api.worktree.isolate(activeChatId, path))
    if (ok) {
      setOpenSub(null)
      setOpen(false)
    }
  }

  async function createCheckpoint() {
    if (!path) return
    const id = await window.api.undo.checkpoint(path)
    // F (ось 3): захватываем границу диалога — для режима «Откатить задачу».
    const msgId = activeChatId != null ? await window.api.chats.maxMessageId(activeChatId) : null
    setCheckpoint(id, msgId)
    pushActivity({
      id: `checkpoint-${Date.now()}`,
      kind: 'write',
      label: '📍 Чекпоинт',
      detail: id === 0 ? 'стек пуст — откатим всё, что начнётся с этого момента' : `на записи #${id}`,
      status: 'ok',
      timestamp: Date.now(),
    })
    setOpen(false)
  }

  // Откат файлов (per-file undo до чекпоинта). Возвращает успех.
  async function revertFilesOnly(): Promise<boolean> {
    if (!path || checkpointId === null) return false
    const result = await window.api.undo.revertToCheckpoint(path, checkpointId)
    if (result.ok) {
      const tree = await window.api.files.tree(path)
      useProject.setState({ tree })
      pushActivity({
        id: `revert-files-${Date.now()}`, kind: 'write', label: `↶ Откатил файлы: ${result.count}`,
        detail: result.restored.slice(0, 4).join(', ') + (result.restored.length > 4 ? ` …+${result.restored.length - 4}` : ''),
        status: 'ok', timestamp: Date.now(),
      })
      return true
    }
    return false
  }

  // Откат задачи: truncate диалога к чекпоинту (файлы не трогаем).
  async function revertTaskOnly() {
    if (activeChatId == null || checkpointMessageId == null) return
    const deleted = await window.api.chats.truncateAfter(activeChatId, checkpointMessageId)
    const msgs = await window.api.chats.list(activeChatId)
    useProject.setState({ messages: msgs.map(m => ({ role: m.role, content: m.content, createdAt: m.createdAt })) })
    pushActivity({
      id: `revert-task-${Date.now()}`, kind: 'write', label: `↶ Откатил задачу: −${deleted} сообщений`,
      detail: 'диалог обрезан к чекпоинту (файлы не тронуты)', status: 'ok', timestamp: Date.now(),
    })
  }

  // Откат во время стрима небезопасен (гонка с дописыванием сообщений/файлов, снятие
  // undo-floor) — гейтим (ревью кросс-фич: HIGH порча истории чата мид-стрим).
  async function revertFiles() {
    if (isStreaming) return
    if (!window.confirm('Откатить ВСЕ файловые правки после чекпоинта? Файлы вернутся к состоянию на момент чекпоинта.')) return
    if (await revertFilesOnly()) setCheckpoint(null)
    setOpen(false)
  }
  async function revertTask() {
    if (isStreaming) return
    if (!window.confirm('Откатить ДИАЛОГ к чекпоинту (файлы НЕ трогаем)? Сообщения после чекпоинта удалятся.')) return
    await revertTaskOnly(); setCheckpoint(null); setOpen(false)
  }
  async function revertBoth() {
    if (isStreaming) return
    if (!window.confirm('Откатить и ФАЙЛЫ, и ДИАЛОГ к чекпоинту? Действие не отменить.')) return
    await revertFilesOnly(); await revertTaskOnly(); setCheckpoint(null); setOpen(false)
  }

  async function runReview(providerId: string) {
    if (currentProvider && providerId === currentProvider) {
      const ok = window.confirm(
        `Ревьюер совпадает с текущим провайдером (${PROVIDER_LABELS[providerId] ?? providerId}). ` +
        'Самоконтроль обычно бесполезен — модель пропустит свои же ошибки. Продолжить?',
      )
      if (!ok) return
    }
    if (!defaultReviewer) {
      await window.api.settings.setKey('default_review_provider', providerId)
      setDefaultReviewer(providerId)
    }
    // Парити с ReviewButton (аудит P1 #10): подтягиваем DoD-верификацию + реальный
    // diff, иначе этот вход в ревью молча терял VERIFICATION-блок и слал ревьюеру
    // только прозу (file:line галлюцинировались, аудит P0 #6).
    let verification = null
    let diff: string | null = null
    if (path) {
      try { verification = await window.api.verifications.latest(path, activeChatId) } catch { /* DoD не критичен */ }
      try { const d = await window.api.git.diff({ path }); diff = d.patch ?? null } catch { /* не git-проект / нет правок */ }
    }
    const payload = composeReviewPayload(messages, verification, diff)
    await startReview({ providerId, model: null, payload })
    setOpen(false)
  }

  async function onReviewDefault() {
    if (!hasAssistantContent) return
    if (defaultReviewer) {
      const needsKey = defaultReviewer.endsWith('-api') ||
        ['claude', 'grok', 'openai'].includes(defaultReviewer)
      if (needsKey) {
        const keyName = `${defaultReviewer.replace('-api', '')}_api_key`
        const key = await window.api.settings.getKey(keyName)
        if (!key) return
      }
      await runReview(defaultReviewer)
    }
  }

  function pickSkill(id: string | null) {
    setActiveSkill(id)
    setOpen(false)
  }

  const skillMeta = activeSkill
    ? (activeSkill.name ?? activeSkill.id)
    : skills.length > 0
      ? `${skills.length} доступно`
      : 'нет инструментов'
  const reviewMeta = hasAssistantContent
    ? (defaultReviewer ? PROVIDER_LABELS[defaultReviewer] ?? defaultReviewer : 'выбрать модель')
    : 'нужен ответ агента'
  const checkpointMeta = !path
    ? 'открой проект'
    : checkpointId === null
      ? 'не установлен'
      : `активен #${checkpointId === 0 ? 'start' : checkpointId}`
  const worktreeMeta = !path
    ? 'открой проект'
    : activeChatId == null
      ? 'нет чата'
      : worktreeStatus.active
        ? 'уже включена'
        : 'отдельная git-копия'

  function pickMultiAgent(template: string) {
    onInject(template)
    setOpen(false)
  }

  const triggerHint = activeSkill
    ? `Инструмент: ${activeSkill.name ?? activeSkill.id}`
    : checkpointId !== null
      ? 'Чекпоинт установлен'
      : 'Инструмент, ревью, мультиагент, чекпоинт'

  return (
    <div className={`gg-tools-wrap ${open ? 'is-open' : ''}`} ref={wrapRef}>
      <button
        type="button"
        className={`gg-tools-pill ${activeSkill || checkpointId !== null ? 'is-active' : ''}`}
        onClick={() => setOpen(v => !v)}
        title={triggerHint}
        aria-expanded={open}
      >
        <span>Выбрать</span>
        <span className="gg-tools-chevron" aria-hidden>{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="gg-tools-popover gg-mp-popover-opaque">
          <ul className="gg-tools-menu" role="menu">
            <li
              className={`gg-tools-menu-item ${openSub === 'skill' ? 'is-submenu-open' : ''}`}
              role="none"
            >
              <button
                type="button"
                className="gg-tools-menu-trigger"
                role="menuitem"
                aria-expanded={openSub === 'skill'}
                onClick={() => toggleSub('skill')}
              >
                <span className="gg-tools-menu-label">Инструмент</span>
                <span className="gg-tools-menu-meta">{skillMeta}</span>
                <span className="gg-tools-menu-arrow" aria-hidden>›</span>
              </button>
              {openSub === 'skill' && (
                <div className="gg-tools-submenu gg-mp-popover-opaque" role="menu">
                  <div className="gg-tools-submenu-head">
                    <span className="gg-tools-submenu-title">Инструменты</span>
                    <button
                      type="button"
                      className="gg-tools-refresh"
                      onClick={e => { e.stopPropagation(); void refresh() }}
                      disabled={loading}
                      title={lastRefreshAt ? `Обновлено: ${new Date(lastRefreshAt).toLocaleTimeString('ru-RU')}` : 'Обновить'}
                    >
                      {loading ? '⌛' : '↻'}
                    </button>
                  </div>
                  <div className="gg-tools-status">
                    {serverReachable
                      ? <span className="gg-tools-status-ok">Сервер подключён</span>
                      : <span className="gg-tools-status-off">Сервер недоступен</span>}
                  </div>
                  {activeSkillId && (
                    <button type="button" className="gg-tools-row" onClick={() => pickSkill(null)}>
                      <span className="gg-tools-row-label">Без инструмента</span>
                      <span className="gg-tools-row-meta">Обычный чат</span>
                    </button>
                  )}
                  {(['server', 'user', 'built-in'] as const).map(group => {
                    const items = grouped[group]
                    if (items.length === 0) return null
                    const groupLabel = group === 'server' ? 'С сервера' : group === 'user' ? 'Личные' : 'Встроенные'
                    return items.map(s => (
                      <button
                        key={s.id}
                        type="button"
                        className={`gg-tools-row ${s.id === activeSkillId ? 'is-active' : ''}`}
                        onClick={() => pickSkill(s.id)}
                      >
                        <span className="gg-tools-row-label">{s.name ?? s.id}</span>
                        <span className="gg-tools-row-meta">{groupLabel}{s.slash ? ` · /${s.slash}` : ''}</span>
                      </button>
                    ))
                  })}
                  {skills.length === 0 && !loading && (
                    <div className="gg-tools-empty">Инструментов нет</div>
                  )}
                </div>
              )}
            </li>

            <li
              className={`gg-tools-menu-item ${openSub === 'review' ? 'is-submenu-open' : ''}`}
              role="none"
            >
              <button
                type="button"
                className={`gg-tools-menu-trigger ${!hasAssistantContent ? 'is-disabled' : ''}`}
                role="menuitem"
                aria-expanded={openSub === 'review'}
                disabled={!hasAssistantContent}
                onClick={() => toggleSub('review')}
              >
                <span className="gg-tools-menu-label">Ревью</span>
                <span className="gg-tools-menu-meta">{reviewMeta}</span>
                <span className="gg-tools-menu-arrow" aria-hidden>›</span>
              </button>
              {openSub === 'review' && (
                <div className="gg-tools-submenu gg-mp-popover-opaque" role="menu">
                  <div className="gg-tools-submenu-title">Ревью ответа</div>
                  {hasAssistantContent ? (
                    <>
                      <button type="button" className="gg-tools-row" onClick={() => void onReviewDefault()}>
                        <span className="gg-tools-row-label">Проверить последний ответ</span>
                        <span className="gg-tools-row-meta">
                          {defaultReviewer ? PROVIDER_LABELS[defaultReviewer] ?? defaultReviewer : 'по умолчанию'}
                        </span>
                      </button>
                      {KNOWN_PROVIDERS.map(pid => (
                        <button
                          key={pid}
                          type="button"
                          className={`gg-tools-row ${pid === defaultReviewer ? 'is-active' : ''}`}
                          onClick={() => void runReview(pid)}
                        >
                          <span className="gg-tools-row-label">{PROVIDER_LABELS[pid]}</span>
                          <span className="gg-tools-row-meta">
                            {pid === defaultReviewer ? 'по умолчанию' : pid === currentProvider ? 'это чат' : ''}
                          </span>
                        </button>
                      ))}
                    </>
                  ) : (
                    <div className="gg-tools-empty">Сначала дождитесь ответа агента</div>
                  )}
                </div>
              )}
            </li>

            <li
              className={`gg-tools-menu-item ${openSub === 'multiagent' ? 'is-submenu-open' : ''}`}
              role="none"
            >
              <button
                type="button"
                className="gg-tools-menu-trigger"
                role="menuitem"
                aria-expanded={openSub === 'multiagent'}
                onClick={() => toggleSub('multiagent')}
              >
                <span className="gg-tools-menu-label">Мультиагент</span>
                <span className="gg-tools-menu-meta">{MULTI_AGENT_LIST.length} режима</span>
                <span className="gg-tools-menu-arrow" aria-hidden>›</span>
              </button>
              {openSub === 'multiagent' && (
                <div className="gg-tools-submenu gg-mp-popover-opaque" role="menu">
                  <div className="gg-tools-submenu-title">Мультиагент</div>
                  {MULTI_AGENT_LIST.map(t => (
                    <button
                      key={t.trigger}
                      type="button"
                      className="gg-tools-row"
                      onClick={() => pickMultiAgent(t.template)}
                    >
                      <span className="gg-tools-row-label">{t.icon} {t.label}</span>
                      <span className="gg-tools-row-meta">/{t.trigger}</span>
                    </button>
                  ))}
                </div>
              )}
            </li>

            <li
              className={`gg-tools-menu-item ${openSub === 'worktree' ? 'is-submenu-open' : ''}`}
              role="none"
            >
              <button
                type="button"
                className={`gg-tools-menu-trigger ${!path || helpMode || activeChatId == null ? 'is-disabled' : ''}`}
                role="menuitem"
                aria-expanded={openSub === 'worktree'}
                disabled={!path || helpMode || activeChatId == null}
                onClick={() => toggleSub('worktree')}
              >
                <span className="gg-tools-menu-label">Изоляция</span>
                <span className="gg-tools-menu-meta">{worktreeMeta}</span>
                <span className="gg-tools-menu-arrow" aria-hidden>›</span>
              </button>
              {openSub === 'worktree' && (
                <div className="gg-tools-submenu gg-mp-popover-opaque" role="menu">
                  <div className="gg-tools-submenu-title">Изолированная сессия</div>
                  {!path ? (
                    <div className="gg-tools-empty">Открой проект слева</div>
                  ) : worktreeStatus.active ? (
                    <div className="gg-tools-empty">Изоляция уже включена. Управление показано над полем чата.</div>
                  ) : (
                    <button
                      type="button"
                      className="gg-tools-row"
                      onClick={() => void isolateWorktree()}
                      disabled={worktreeBusy || isStreaming || activeChatId == null}
                      title="Правки агента пойдут в отдельную git-копию и не затронут основной проект до применения"
                    >
                      <span className="gg-tools-row-label">🌿 Изолировать сессию</span>
                      <span className="gg-tools-row-meta">{isStreaming ? 'дождись завершения ответа' : 'отдельная git-копия для правок агента'}</span>
                    </button>
                  )}
                  {worktreeErr && <div className="gg-tools-empty">{worktreeErr}</div>}
                </div>
              )}
            </li>

            <li
              className={`gg-tools-menu-item ${openSub === 'export' ? 'is-submenu-open' : ''}`}
              role="none"
            >
              <button
                type="button"
                className={`gg-tools-menu-trigger ${helpMode || activeChatId == null ? 'is-disabled' : ''}`}
                role="menuitem"
                aria-expanded={openSub === 'export'}
                disabled={helpMode || activeChatId == null}
                onClick={() => toggleSub('export')}
              >
                <span className="gg-tools-menu-label">Экспорт</span>
                <span className="gg-tools-menu-meta">контекст и история</span>
                <span className="gg-tools-menu-arrow" aria-hidden>›</span>
              </button>
              {openSub === 'export' && (
                <div className="gg-tools-submenu gg-mp-popover-opaque" role="menu">
                  <div className="gg-tools-submenu-title">Экспорт и передача</div>
                  <button
                    type="button"
                    className="gg-tools-row"
                    onClick={() => void runExport(onSaveHandoff)}
                    disabled={exportBusy || !onSaveHandoff}
                    title="Сжать текущую сессию в Markdown для передачи другому агенту или продолжения работы"
                  >
                    <span className="gg-tools-row-label">{exportBusy ? 'Готовлю контекст...' : 'Передать контекст'}</span>
                    <span className="gg-tools-row-meta">сжатый handoff + буфер обмена</span>
                  </button>
                  <button
                    type="button"
                    className="gg-tools-row"
                    onClick={() => void runExport(onExportTranscript)}
                    disabled={exportBusy || !onExportTranscript}
                    title="Сохранить полную историю текущего чата в Markdown"
                  >
                    <span className="gg-tools-row-label">{exportBusy ? 'Сохраняю...' : 'Экспорт чата'}</span>
                    <span className="gg-tools-row-meta">полная история в Markdown</span>
                  </button>
                </div>
              )}
            </li>

            <li
              className={`gg-tools-menu-item ${openSub === 'checkpoint' ? 'is-submenu-open' : ''}`}
              role="none"
            >
              <button
                type="button"
                className={`gg-tools-menu-trigger ${!path ? 'is-disabled' : ''}`}
                role="menuitem"
                aria-expanded={openSub === 'checkpoint'}
                disabled={!path}
                onClick={() => toggleSub('checkpoint')}
              >
                <span className="gg-tools-menu-label">Чекпоинт</span>
                <span className="gg-tools-menu-meta">{checkpointMeta}</span>
                <span className="gg-tools-menu-arrow" aria-hidden>›</span>
              </button>
              {openSub === 'checkpoint' && (
                <div className="gg-tools-submenu gg-mp-popover-opaque" role="menu">
                  <div className="gg-tools-submenu-title">Состояние файлов</div>
                  {!path ? (
                    <div className="gg-tools-empty">Открой проект слева</div>
                  ) : checkpointId === null ? (
                    <button type="button" className="gg-tools-row" onClick={() => void createCheckpoint()}>
                      <span className="gg-tools-row-label">Запомнить состояние</span>
                      <span className="gg-tools-row-meta">Откатить правки позже</span>
                    </button>
                  ) : (
                    <>
                      <button type="button" className="gg-tools-row is-warn" onClick={() => void revertFiles()} disabled={isStreaming}>
                        <span className="gg-tools-row-label">Откатить файлы</span>
                        <span className="gg-tools-row-meta">{isStreaming ? 'дождись завершения ответа' : `После #${checkpointId === 0 ? 'start' : checkpointId}`}</span>
                      </button>
                      <button type="button" className="gg-tools-row is-warn" onClick={() => void revertTask()} disabled={isStreaming || checkpointMessageId == null}>
                        <span className="gg-tools-row-label">Откатить задачу (диалог)</span>
                        <span className="gg-tools-row-meta">{isStreaming ? 'дождись завершения' : checkpointMessageId == null ? 'граница не захвачена' : 'обрезать диалог к чекпоинту'}</span>
                      </button>
                      <button type="button" className="gg-tools-row is-warn" onClick={() => void revertBoth()} disabled={isStreaming}>
                        <span className="gg-tools-row-label">Файлы + задачу</span>
                        <span className="gg-tools-row-meta">{isStreaming ? 'дождись завершения' : 'откатить всё'}</span>
                      </button>
                    </>
                  )}
                </div>
              )}
            </li>
          </ul>
        </div>
      )}
    </div>
  )
}
