import { useEffect, useMemo, useState } from 'react'
import { useProject } from '../store/projectStore'
import type { Memory } from '../types/api'

/**
 * Memory Governance — control/transparency screen over the agent's archival
 * memory. Lets the user REVIEW what the agent auto-remembered and keep / edit /
 * reject each entry, guarding against silent memory auto-dump.
 *
 * Data source: window.api.memory (list/delete/save). No new IPC.
 * Edit is implemented as delete(old) + save(new) — id/created_at change, which
 * is acceptable for v1 (there is no update IPC).
 */

// Memories created within this window are surfaced for review.
const RECENT_MS = 24 * 60 * 60 * 1000

const TYPE_BADGE: Record<Memory['type'], { icon: string; label: string }> = {
  fact: { icon: '📌', label: 'факт' },
  decision: { icon: '⚖️', label: 'решение' },
  bug: { icon: '🐞', label: 'баг' },
  preference: { icon: '❤', label: 'предпочтение' },
  pattern: { icon: '🧩', label: 'паттерн' }
}

// Russian plural picker (1 запись / 2 записи / 5 записей).
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60 * 1000) return 'только что'
  const min = Math.floor(diff / (60 * 1000))
  if (min < 60) return `${min} ${plural(min, 'минуту', 'минуты', 'минут')} назад`
  const hours = Math.floor(diff / (60 * 60 * 1000))
  if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')} назад`
  const days = Math.floor(diff / (24 * 60 * 60 * 1000))
  if (days < 30) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function isRecent(m: Memory): boolean {
  return Date.now() - m.created_at < RECENT_MS
}

function MemoryCard({ memory, onChanged }: { memory: Memory; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(memory.content)
  const [busy, setBusy] = useState(false)
  const badge = TYPE_BADGE[memory.type]
  const recent = isRecent(memory)

  async function save() {
    const content = draft.trim()
    if (!content || content === memory.content) {
      setEditing(false)
      setDraft(memory.content)
      return
    }
    setBusy(true)
    try {
      // No update IPC — replace: delete old, save new with same type/tags.
      await window.api.memory.delete(memory.id)
      await window.api.memory.save(memory.project_path, memory.type, content, memory.tags)
      setEditing(false)
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  async function reject() {
    setBusy(true)
    try {
      await window.api.memory.delete(memory.id)
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`gg-memgov-card ${recent ? 'is-recent' : ''}`}>
      <div className="gg-memgov-card-head">
        <span className="gg-memgov-badge" title={memory.type}>
          <span aria-hidden>{badge.icon}</span> {badge.label}
        </span>
        {recent && <span className="gg-memgov-new">новое — проверь</span>}
        <span className="gg-memgov-time">{relativeTime(memory.created_at)}</span>
      </div>

      {editing ? (
        <textarea
          className="gg-input gg-memgov-textarea"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          rows={4}
          autoFocus
          spellCheck={false}
        />
      ) : (
        <div className="gg-memgov-content">{memory.content}</div>
      )}

      {memory.tags.length > 0 && (
        <div className="gg-memgov-tags">
          {memory.tags.map(tag => <span key={tag} className="gg-memgov-tag">{tag}</span>)}
        </div>
      )}

      <div className="gg-memgov-actions">
        {editing ? (
          <>
            <button className="gg-btn gg-btn-primary" onClick={() => void save()} disabled={busy}>
              {busy ? 'Сохранение…' : 'Сохранить'}
            </button>
            <button
              className="gg-btn gg-btn-ghost"
              onClick={() => { setEditing(false); setDraft(memory.content) }}
              disabled={busy}
            >Отмена</button>
          </>
        ) : (
          <>
            <button className="gg-btn gg-btn-ghost" onClick={() => setEditing(true)} disabled={busy}>
              Изменить
            </button>
            <button className="gg-btn gg-btn-danger" onClick={() => void reject()} disabled={busy}>
              Удалить
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// Один постоянный блок памяти (MEMORY.md или USER.md) — показ + правка.
// Постоянные заметки инжектятся в промпт КАЖДЫЙ ход (в отличие от архива, который
// ищется раз за сессию), поэтому их надо ВИДЕТЬ и уметь править прямо здесь.
function CoreNoteBlock({ path, block, title, hint, value, onSaved }: {
  path: string
  block: 'memory' | 'user'
  title: string
  hint: string
  value: string
  onSaved: (block: 'memory' | 'user', content: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      await window.api.coreMemory.save(path, block, draft)
      onSaved(block, draft)
      setEditing(false)
    } catch { /* оставляем в режиме правки */ }
    setBusy(false)
  }

  return (
    <div className="gg-corenote">
      <div className="gg-corenote-head">
        <span className="gg-corenote-file">{title}</span>
        <span className="gg-corenote-badge">всегда в промпте</span>
        {!editing && <button className="gg-btn gg-btn-ghost gg-corenote-edit" onClick={() => { setDraft(value); setEditing(true) }}>Изменить</button>}
      </div>
      {editing ? (
        <>
          <textarea className="gg-input gg-corenote-textarea" value={draft} onChange={e => setDraft(e.target.value)} rows={5} autoFocus spellCheck={false} />
          <div className="gg-corenote-actions">
            <button className="gg-btn gg-btn-primary" onClick={() => void save()} disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить'}</button>
            <button className="gg-btn gg-btn-ghost" onClick={() => { setEditing(false); setDraft(value) }} disabled={busy}>Отмена</button>
          </div>
        </>
      ) : (
        <div className={`gg-corenote-body ${value.trim() ? '' : 'is-empty'}`}>{value.trim() || hint}</div>
      )}
    </div>
  )
}

// «Постоянные заметки» — core-файлы .verstak/MEMORY.md (о проекте) + USER.md (о вас).
function CoreNotes({ path }: { path: string }) {
  const [blocks, setBlocks] = useState<{ memory: string; user: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.coreMemory.load(path).then(b => { if (!cancelled) setBlocks(b) }).catch(() => { if (!cancelled) setBlocks({ memory: '', user: '' }) })
    return () => { cancelled = true }
  }, [path])

  if (!blocks) return null
  const onSaved = (block: 'memory' | 'user', content: string) => setBlocks(b => b ? { ...b, [block]: content } : b)
  return (
    <div className="gg-corenotes">
      <CoreNoteBlock path={path} block="memory" title="📄 О проекте (MEMORY.md)" hint="Пусто — агент допишет сам, или добавьте конвенции и контекст проекта." value={blocks.memory} onSaved={onSaved} />
      <CoreNoteBlock path={path} block="user" title="📄 О вас (USER.md)" hint="Пусто — как с вами общаться, ваши предпочтения и правила." value={blocks.user} onSaved={onSaved} />
    </div>
  )
}

export function MemoryGovernance() {
  const { path } = useProject()
  const setActiveView = useProject(s => s.setActiveView)
  const [memories, setMemories] = useState<Memory[]>([])
  const [loading, setLoading] = useState(false)

  async function refresh() {
    if (!path) return
    setLoading(true)
    try {
      const list = await window.api.memory.list(path)
      setMemories(list)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [path])

  // Newest first, with recently-captured memories grouped on top.
  const sorted = useMemo(() => {
    return [...memories].sort((a, b) => {
      const ra = isRecent(a) ? 1 : 0
      const rb = isRecent(b) ? 1 : 0
      if (ra !== rb) return rb - ra
      return b.created_at - a.created_at
    })
  }, [memories])

  const recentCount = useMemo(() => memories.filter(isRecent).length, [memories])

  if (!path) {
    return (
      <div className="gg-panel">
        <div className="gg-panel-empty" style={{ marginTop: 80 }}>Открой проект чтобы управлять памятью агента</div>
      </div>
    )
  }

  return (
    <div className="gg-panel">
      <div className="gg-panel-header">
        <h2 className="gg-panel-title">Память ИИ</h2>
        <div className="gg-panel-meta">
          что агент помнит о проекте и о вас
        </div>
      </div>

      <div className="gg-panel-body">
        {/* Задача 5: указатель на откат. Откат — это НЕ память: память привязана к
            ЗНАНИЮ (что агент помнит), откат — к ДЕЙСТВИЮ (что агент сделал с файлами).
            Слить их под «Памятью» удвоило бы ту же ложь, из-за которой Павел искал
            откат здесь и не нашёл. Поэтому — не переносим откат сюда, а показываем,
            где он живёт: у прогона (История работы → Диагностика) и у сообщения в чате. */}
        <div className="gg-memgov-undo-hint">
          <span aria-hidden>↩︎</span>
          <span>Нужно <b>вернуть правки назад</b>? Это не память, а откат — он у каждого прогона в разделе{' '}
            <button type="button" className="gg-memgov-undo-link" onClick={() => setActiveView('tasks-manager')}>«История работы» → Диагностика</button>{' '}
            (откат к git-якорю прогона), и кнопкой <span className="gg-memgov-undo-key">↶</span> «Откатить последнюю правку» внизу чата.
          </span>
        </div>

        <div className="gg-memgov-section">
          <div className="gg-memgov-section-title">Постоянные заметки</div>
          <div className="gg-memgov-section-hint">Агент читает их каждый ход. Правьте прямо здесь; агент дописывает их сам.</div>
          <CoreNotes path={path} />
        </div>

        <div className="gg-memgov-section">
          <div className="gg-memgov-section-title">
            Архив запомненного
            <span className="gg-memgov-section-count">{memories.length} {plural(memories.length, 'запись', 'записи', 'записей')}{recentCount > 0 ? ` · ${recentCount} новых` : ''}</span>
            <button className="gg-btn gg-btn-ghost gg-memgov-refresh" onClick={() => void refresh()} disabled={loading}>{loading ? '…' : '↻'}</button>
          </div>
          <div className="gg-memgov-section-hint">Факты и решения, которые агент запомнил по ходу. Ищутся, когда относятся к задаче.</div>
          {memories.length === 0 ? (
            <div className="gg-memgov-section-empty">
              Пока пусто — здесь появится то, что агент запомнил, и вы сможете это проверить и поправить.
            </div>
          ) : (
            <div className="gg-memgov-list">
              {sorted.map(m => <MemoryCard key={m.id} memory={m} onChanged={() => void refresh()} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
