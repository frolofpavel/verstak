import { useEffect, useMemo, useState, useCallback } from 'react'
import { useProject } from '../store/projectStore'
import type { SubSession, SessionTodo, StoredChatMessage, ProviderDescriptorDTO } from '../types/api'
import { Markdown } from './Markdown'
import { MULTI_AGENT_TEMPLATES } from '../lib/multi-agent-templates'
import { buildAgentTree, type TreeNode } from '../lib/agent-tree'

/**
 * Панель Agents (Фаза 2, Идея 7) — Inspector 2.0 для суб-агентов.
 *
 * Живой список ВСЕХ суб-сессий проекта (running + done + error + cancelled):
 * роль, провайдер/модель, статус, задача, длительность, счётчик tool-вызовов.
 * Фильтры по роли/провайдеру/статусу. Клик → история суб-сессии (read-only).
 * Кнопка «притащить в чат» вставляет результат в композер основного чата.
 * Массовая отмена (Идея 6): «отменить всё» / по роли — через agents.cancel.
 *
 * Данные: window.api.agents (новый IPC). Поллинг раз в 2с пока открыта панель —
 * чтобы статусы running → done обновлялись без ручного refresh.
 *
 * Адаптация под verstak: бейдж провайдера рендерится через метаданные из
 * window.api.providers.list() (shortLabel/name всех 18 провайдеров), а не через
 * прямой импорт PROVIDERS из electron/ (renderer не имеет доступа к main).
 */

const STATUS_LABEL: Record<string, string> = {
  running: 'идёт',
  done: 'готово',
  error: 'ошибка',
  cancelled: 'отменён'
}

function fmtDuration(start: number | null, end: number | null): string {
  if (!start) return '—'
  const ms = (end ?? Date.now()) - start
  if (ms < 1000) return `${ms}мс`
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}с`
  return `${Math.floor(sec / 60)}м ${sec % 60}с`
}

function fmtCost(cents: number | null): string | null {
  if (cents == null || cents <= 0) return null
  return `$${(cents / 100).toFixed(2)}`
}

// Просмотр истории суб-сессии (read-only) — модалка поверх панели.
function SubSessionViewer({ sub, providerLabel, onClose, onBring }: { sub: SubSession; providerLabel: (id: string | null) => string; onClose: () => void; onBring: (text: string) => void }) {
  const [messages, setMessages] = useState<StoredChatMessage[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void window.api.agents.history(sub.id).then(h => {
      if (!cancelled) { setMessages(h); setLoading(false) }
    }).catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [sub.id])

  // Последний ответ ассистента — это «результат» суба, его и тащим в чат.
  const lastAssistant = useMemo(
    () => [...messages].reverse().find(m => m.role === 'assistant')?.content ?? '',
    [messages]
  )

  const status = sub.status ?? ''
  return (
    <div className="gg-subviewer-overlay" onClick={onClose}>
      <div className="gg-subviewer-modal" onClick={e => e.stopPropagation()}>
        <div className="gg-subviewer-head">
          <div className="gg-subviewer-title">
            <span className={`gg-agent-status-dot is-${status}`} />
            <span className="gg-subviewer-role">🤖 {sub.role ?? 'sub-agent'}</span>
            <span className="gg-subviewer-sub">{providerLabel(sub.providerId)}{sub.model ? ` · ${sub.model}` : ''}</span>
            <span className={`gg-subviewer-status is-${status}`}>{STATUS_LABEL[status] ?? status}</span>
          </div>
          <div className="gg-subviewer-actions">
            {lastAssistant && (
              <button className="gg-btn gg-btn-ghost" onClick={() => { onBring(lastAssistant); onClose() }}>↪ Притащить в чат</button>
            )}
            <button className="gg-btn gg-btn-ghost" onClick={onClose}>Закрыть</button>
          </div>
        </div>
        <div className="gg-subviewer-body">
          <div className="gg-subviewer-section-title">Задача</div>
          <pre className="gg-subviewer-pre">{sub.task ?? '—'}</pre>
          <div className="gg-subviewer-section-title">История ({messages.length})</div>
          {loading && <div className="gg-panel-empty">Загрузка…</div>}
          {!loading && messages.length === 0 && <div className="gg-panel-empty">История пуста.</div>}
          {messages.map(m => (
            <div key={m.id} className={`gg-agents-msg is-${m.role}`}>
              <div className="gg-agents-msg-role">{m.role === 'user' ? 'задача' : 'ответ'}</div>
              <div className="gg-agents-msg-body">
                {m.role === 'assistant' ? <Markdown text={m.content} /> : <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function AgentsPanel() {
  const path = useProject(s => s.path)
  const setActiveView = useProject(s => s.setActiveView)
  const [subs, setSubs] = useState<SubSession[]>([])
  const [todos, setTodos] = useState<SessionTodo[]>([])
  const [queue, setQueue] = useState<{ inFlight: number; queued: number; tracked: number } | null>(null)
  const [viewing, setViewing] = useState<SubSession | null>(null)
  const [roleFilter, setRoleFilter] = useState<string>('')
  const [providerFilter, setProviderFilter] = useState<string>('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  // Свёрнутые родительские узлы дерева (по sub.id). По умолчанию всё развёрнуто.
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  // Карта id провайдера → читаемый лейбл (shortLabel/name всех провайдеров).
  const [providerMeta, setProviderMeta] = useState<Record<string, string>>({})

  useEffect(() => {
    void window.api.providers.list().then((list: ProviderDescriptorDTO[]) => {
      const map: Record<string, string> = {}
      for (const p of list) map[p.id] = p.shortLabel || p.name
      setProviderMeta(map)
    }).catch(() => { /* IPC может быть недоступен — fallback на сырой id */ })
  }, [])

  const providerLabel = useCallback((id: string | null) => {
    if (!id) return '?'
    return providerMeta[id] ?? id
  }, [providerMeta])

  const refresh = useCallback(async () => {
    if (!path) return
    try {
      const [list, stats, todoList] = await Promise.all([
        window.api.agents.list(path),
        window.api.agents.queueStats(),
        window.api.agents.todos(path)
      ])
      setSubs(list)
      setQueue(stats)
      setTodos(todoList)
    } catch { /* IPC может быть недоступен в dev — панель просто пустая */ }
  }, [path])

  // Поллинг раз в 2с пока панель открыта — живые статусы.
  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 2000)
    return () => clearInterval(t)
  }, [refresh])

  const roles = useMemo(() => Array.from(new Set(subs.map(s => s.role).filter(Boolean))) as string[], [subs])
  const providers = useMemo(() => Array.from(new Set(subs.map(s => s.providerId).filter(Boolean))) as string[], [subs])

  const filtered = useMemo(() => subs.filter(s =>
    (!roleFilter || s.role === roleFilter) &&
    (!providerFilter || s.providerId === providerFilter) &&
    (!statusFilter || s.status === statusFilter)
  ), [subs, roleFilter, providerFilter, statusFilter])

  // Дерево делегирования: когда фильтры не активны — показываем иерархию
  // main → суб → под-суб с отступами. С активным фильтром структура рвётся,
  // поэтому показываем плоско (level 0, без детей).
  const treeActive = !roleFilter && !providerFilter && !statusFilter
  const tree = useMemo<TreeNode[]>(
    () => treeActive
      ? buildAgentTree(filtered)
      : filtered.map(sub => ({ sub, level: 0, hasChildren: false, parentId: null })),
    [filtered, treeActive]
  )

  // Видимое дерево: скрываем узлы, у которых свёрнут какой-либо предок.
  // Идём по pre-order списку — если родитель в collapsed, прячем всё поддерево.
  const visibleTree = useMemo<TreeNode[]>(() => {
    if (collapsed.size === 0) return tree
    const hidden = new Set<number>()
    const out: TreeNode[] = []
    for (const node of tree) {
      const parentHidden = node.parentId != null && (hidden.has(node.parentId) || collapsed.has(node.parentId))
      if (parentHidden) {
        hidden.add(node.sub.id)
        continue
      }
      out.push(node)
    }
    return out
  }, [tree, collapsed])

  function toggleCollapse(id: number) {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const runningCount = subs.filter(s => s.status === 'running').length

  // Инжект в композер основного чата + переход на вкладку Chat.
  // Используется empty-state кнопками быстрого старта оркестрации/роя.
  function injectToChat(text: string) {
    window.dispatchEvent(new CustomEvent('gg-inject-prompt', { detail: text }))
    setActiveView('chat')
  }

  // Притащить результат суба в композер основного чата (переиспользуем
  // существующий CustomEvent gg-inject-prompt, что слушает Chat.tsx).
  function bringToChat(text: string) {
    const quoted = `Контекст от суб-агента:\n\n${text}\n\n---\n`
    window.dispatchEvent(new CustomEvent('gg-inject-prompt', { detail: quoted }))
    setActiveView('chat')
  }

  async function cancelAll() {
    await window.api.agents.cancel({ all: true }).catch(() => 0)
    void refresh()
  }
  async function cancelRole(role: string) {
    await window.api.agents.cancel({ role }).catch(() => 0)
    void refresh()
  }

  if (!path) {
    return (
      <div className="gg-panel">
        <div className="gg-panel-empty" style={{ marginTop: 80 }}>Открой проект чтобы видеть агентов</div>
      </div>
    )
  }

  return (
    <div className="gg-panel">
      <div className="gg-panel-header">
        <h2 className="gg-panel-title">Агенты</h2>
        <div className="gg-panel-meta">
          {subs.length} суб-сессий · {runningCount} активно
          {queue && ` · очередь: ${queue.inFlight} в работе / ${queue.queued} ждут`}
        </div>
      </div>

      <div className="gg-inspector-toolbar gg-agents-toolbar">
        <select className="gg-input gg-agents-select" value={roleFilter} onChange={e => setRoleFilter(e.target.value)}>
          <option value="">Все роли</option>
          {roles.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <select className="gg-input gg-agents-select" value={providerFilter} onChange={e => setProviderFilter(e.target.value)}>
          <option value="">Все провайдеры</option>
          {providers.map(p => <option key={p} value={p}>{providerLabel(p)}</option>)}
        </select>
        <select className="gg-input gg-agents-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">Все статусы</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <div className="gg-agents-toolbar-spacer" />
        {runningCount > 0 && (
          <button className="gg-btn gg-btn-ghost gg-agents-cancel" onClick={() => void cancelAll()} title="Прервать все активные суб-агенты">
            ⛔ Отменить всё
          </button>
        )}
        <button className="gg-btn gg-btn-ghost" onClick={() => void refresh()}>↻</button>
      </div>

      <div className="gg-panel-body">
        {todos.length > 0 && (() => {
          const doneCount = todos.filter(t => t.status === 'done').length
          const pct = todos.length > 0 ? Math.round((doneCount / todos.length) * 100) : 0
          return (
            <div className="gg-todogate">
              <div className="gg-todogate-head">
                <span className="gg-todogate-title">TodoGate</span>
                <span className="gg-todogate-progress">{doneCount}/{todos.length} готово</span>
              </div>
              {/* Прогресс-бар — наглядная доля закрытых пунктов. */}
              <div className="gg-todogate-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="gg-todogate-bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="gg-todogate-list">
                {todos.map(t => (
                  <div key={t.id} className={`gg-todo-item is-${t.status}`} title={t.goal ?? ''}>
                    <span className="gg-todo-icon">
                      {t.status === 'done' ? '✅' : t.status === 'in_progress' ? '⏳' : t.status === 'blocked' ? '⛔' : '○'}
                    </span>
                    <span className="gg-todo-title">{t.title}</span>
                  </div>
                ))}
              </div>
            </div>
          )
        })()}
        {filtered.length === 0 && (
          <div className="gg-agents-empty">
            <div className="gg-agents-empty-icon">🤖</div>
            <div className="gg-agents-empty-title">Пока агентов нет</div>
            <div className="gg-agents-empty-hint">
              Запусти оркестрацию или рой — суб-агенты появятся здесь с живым статусом.
            </div>
            <div className="gg-agents-empty-actions">
              <button
                className="gg-quick-action"
                onClick={() => injectToChat(MULTI_AGENT_TEMPLATES.orchestrate.template)}
                title="Разбить цель на подзадачи по ролям и выполнить параллельно (orchestrate)"
              >
                📊 Оркестровать · /orchestrate
              </button>
              <button
                className="gg-quick-action"
                onClick={() => injectToChat(MULTI_AGENT_TEMPLATES.swarm.template)}
                title="Несколько агентов разными стратегиями + арбитр (swarm)"
              >
                🐝 Запустить рой · /swarm
              </button>
            </div>
          </div>
        )}
        <div className="gg-run-list">
          {visibleTree.map(({ sub: s, level, hasChildren }) => {
            const cost = fmtCost(s.costCents)
            // Узлы роя помечаются по sub_group (callId роя в group). Здесь —
            // эвристика: задача начинается с [swarm. Бейдж 🐝 для наглядности.
            const isSwarm = (s.task ?? '').startsWith('[swarm')
            const isCollapsed = collapsed.has(s.id)
            return (
              <div
                key={s.id}
                className={`gg-agent-card gg-agent-card-anim is-${s.status}${level > 0 ? ' is-child' : ''}`}
                style={level > 0 ? { marginLeft: level * 18 } : undefined}
              >
                {/* Toggle сворачивания поддерева — только у родительских узлов. */}
                {hasChildren ? (
                  <button
                    className="gg-agent-toggle"
                    title={isCollapsed ? 'Развернуть поддерево' : 'Свернуть поддерево'}
                    onClick={() => toggleCollapse(s.id)}
                  >{isCollapsed ? '▸' : '▾'}</button>
                ) : (
                  level > 0 && <span className="gg-agent-tree-branch" aria-hidden>↳</span>
                )}
                <button className="gg-agent-card-main" onClick={() => setViewing(s)}>
                  <span className={`gg-agent-status-dot is-${s.status}`} />
                  <span className="gg-agent-role">{isSwarm ? '🐝 ' : ''}{s.role ?? 'sub-agent'}</span>
                  <span className="gg-agent-provider">{providerLabel(s.providerId)}{s.model ? ` · ${s.model}` : ''}</span>
                  {s.depth != null && s.depth > 0 && <span className="gg-agent-depth" title="глубина в дереве делегирования">d{s.depth}</span>}
                  <span className="gg-agent-task" title={s.task ?? ''}>{s.task ?? ''}</span>
                  <span className="gg-agent-meta">
                    <span className="gg-agent-meta-dur">{fmtDuration(s.startedAt, s.endedAt)}</span>
                    {s.toolCount != null && <span className="gg-agent-meta-tools">🔧{s.toolCount}</span>}
                    {cost && <span className="gg-agent-meta-cost">{cost}</span>}
                  </span>
                </button>
                {s.status === 'running' && s.role && (
                  <button className="gg-agent-card-cancel" title={`Отменить всех с ролью ${s.role}`} onClick={() => void cancelRole(s.role!)}>⛔</button>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {viewing && <SubSessionViewer sub={viewing} providerLabel={providerLabel} onClose={() => setViewing(null)} onBring={bringToChat} />}
    </div>
  )
}
