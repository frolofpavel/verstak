import { useEffect, useMemo, useState, type CSSProperties } from 'react'

export interface HomeAgent {
  id: string
  name: string
  category: string
  blurb: string
  prompt: string
  accent: string
  glyph: string
}

export const HOME_AGENTS: HomeAgent[] = [
  {
    id: 'marketing',
    name: 'Marketing Agent',
    category: 'Marketing',
    blurb: 'Позиционирование, офферы, кампании и тексты под канал.',
    prompt: 'Ты Marketing Agent. Помоги с маркетинговой задачей: ',
    accent: '#f59e0b',
    glyph: '📣',
  },
  {
    id: 'design',
    name: 'Design Agent',
    category: 'Design',
    blurb: 'UI/UX, визуальный язык, макеты и проверка консистентности.',
    prompt: 'Ты Design Agent. Помоги с дизайн-задачей: ',
    accent: '#a78bfa',
    glyph: '✦',
  },
  {
    id: 'writing',
    name: 'Writing Agent',
    category: 'Writing',
    blurb: 'Редактура, тон, структура и ясность текста.',
    prompt: 'Ты Writing Agent. Помоги с текстом: ',
    accent: '#34d399',
    glyph: '✎',
  },
  {
    id: 'research',
    name: 'Research Agent',
    category: 'Research',
    blurb: 'Сбор фактов, сравнение вариантов, выжимка выводов.',
    prompt: 'Ты Research Agent. Исследуй и кратко ответь: ',
    accent: '#60a5fa',
    glyph: '⌕',
  },
  {
    id: 'code',
    name: 'Code Agent',
    category: 'Code',
    blurb: 'Разбор кода, правки, ревью и план реализации.',
    prompt: 'Ты Code Agent. Помоги с кодом: ',
    accent: '#fb7185',
    glyph: '{ }',
  },
  {
    id: 'ops',
    name: 'Ops Agent',
    category: 'Ops',
    blurb: 'Процессы, чеклисты, риски и операционный план.',
    prompt: 'Ты Ops Agent. Помоги с операционной задачей: ',
    accent: '#94a3b8',
    glyph: '⚙',
  },
]

const RECENT_KEY = 'gg.home.recentAgents'

function readRecentIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    return []
  }
}

function pushRecentId(id: string): void {
  const next = [id, ...readRecentIds().filter(x => x !== id)].slice(0, 6)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
}

function agentById(id: string | null): HomeAgent | null {
  if (!id) return null
  return HOME_AGENTS.find(a => a.id === id) ?? null
}

interface ChatHomeProps {
  selectedId: string | null
  onSelect: (agent: HomeAgent | null) => void
  recentTitle: string
  suggestedTitle: string
}

export function ChatHome({ selectedId, onSelect, recentTitle, suggestedTitle }: ChatHomeProps) {
  const [recentIds, setRecentIds] = useState<string[]>(() => readRecentIds())

  useEffect(() => {
    setRecentIds(readRecentIds())
  }, [selectedId])

  const recent = useMemo(() => {
    // дедуп на чтении: store правится только через pushRecentId, но ручная/битая
    // правка localStorage может принести дубли → дубли React-ключей
    const fromStore = Array.from(new Set(recentIds)).map(id => agentById(id)).filter((a): a is HomeAgent => !!a)
    if (fromStore.length > 0) return fromStore.slice(0, 4)
    return HOME_AGENTS.slice(0, 3)
  }, [recentIds])

  function selectAgent(agent: HomeAgent) {
    pushRecentId(agent.id)
    setRecentIds(readRecentIds())
    onSelect(agent)
  }

  return (
    <div className="gg-chat-home">
      <section className="gg-chat-home-section" aria-label={recentTitle}>
        <div className="gg-chat-home-section-title">{recentTitle}</div>
        <div className="gg-chat-home-recent">
          {recent.map(agent => (
            <button
              key={agent.id}
              type="button"
              className={`gg-chat-home-recent-card ${selectedId === agent.id ? 'is-selected' : ''}`}
              onClick={() => selectAgent(agent)}
            >
              <span
                className="gg-chat-home-avatar"
                style={{ '--home-accent': agent.accent } as CSSProperties}
                aria-hidden
              >
                {agent.glyph}
              </span>
              <span className="gg-chat-home-recent-name">{agent.name}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="gg-chat-home-section" aria-label={suggestedTitle}>
        <div className="gg-chat-home-section-title">{suggestedTitle}</div>
        <div className="gg-chat-home-suggested">
          {HOME_AGENTS.map(agent => (
            <button
              key={agent.id}
              type="button"
              className={`gg-chat-home-suggested-card ${selectedId === agent.id ? 'is-selected' : ''}`}
              onClick={() => selectAgent(agent)}
            >
              <span
                className="gg-chat-home-suggested-icon"
                style={{ '--home-accent': agent.accent } as CSSProperties}
                aria-hidden
              >
                {agent.glyph}
              </span>
              <span className="gg-chat-home-suggested-label">{agent.category}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

interface ChatHomeAsideProps {
  selectedId: string | null
  onUsePrompt: (prompt: string) => void
  asideEmpty: string
  asideStart: string
}

export function ChatHomeAside({ selectedId, onUsePrompt, asideEmpty, asideStart }: ChatHomeAsideProps) {
  const selected = agentById(selectedId)

  return (
    <aside className="gg-chat-home-aside" aria-live="polite">
      {selected ? (
        <div className="gg-chat-home-aside-body">
          <span
            className="gg-chat-home-avatar is-lg"
            style={{ '--home-accent': selected.accent } as CSSProperties}
            aria-hidden
          >
            {selected.glyph}
          </span>
          <div className="gg-chat-home-aside-name">{selected.name}</div>
          <div className="gg-chat-home-aside-blurb">{selected.blurb}</div>
          <button
            type="button"
            className="gg-btn gg-btn-primary gg-chat-home-aside-start"
            onClick={() => onUsePrompt(selected.prompt)}
          >
            {asideStart}
          </button>
        </div>
      ) : (
        <div className="gg-chat-home-aside-empty">{asideEmpty}</div>
      )}
    </aside>
  )
}
