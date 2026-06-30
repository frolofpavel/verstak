import { useEffect, useMemo, useState } from 'react'
import { useSkills } from '../store/skillStore'
import { HELP_SKILL_ID } from '../lib/help-scope'
import type { UserCommand } from '../types/api'

/**
 * Slash command popup — появляется когда в композере набрано "/" в начале.
 *
 * Источники команд:
 *  1. Все скиллы с заполненным frontmatter.slash (главное).
 *  2. Built-in системные команды (/clear, /mode auto, /new).
 *  3. User/project команды из ~/.verstak/commands/ и {project}/.verstak/commands/.
 *
 * Поведение:
 *  - Фильтрация по подстроке после /.
 *  - ↑↓ — навигация, Enter — выбор, Esc — закрыть.
 *  - При выборе скилла: активируется skill + текст композера очищается.
 *  - Системные команды дёргают callback.
 *  - User/project команды: если есть $VARIABLES — window.prompt для каждой,
 *    затем инжектируют resolved body в composer через onInject.
 */

export type SlashCommand =
  | { kind: 'skill'; skillId: string; trigger: string; label: string; description?: string; icon?: string }
  | { kind: 'system'; trigger: string; label: string; description: string; icon: string; action: () => void }
  | { kind: 'user-command'; command: UserCommand; trigger: string; label: string; description?: string; icon?: string }

interface Props {
  /** Текущий текст композера. Если начинается с "/", popup открыт. */
  text: string
  /** Вызывается когда нужно очистить композер (после выбора скилла или /clear). */
  onClear: () => void
  /** Вызывается когда нужно вставить текст команды в композер. */
  onInject?: (text: string) => void
  /** Опционально — системные команды от родителя (/clear messages и т.п.). */
  systemCommands?: SlashCommand[]
  /** Путь к текущему проекту (для загрузки project-scope команд). */
  projectPath?: string | null
  /** Справка: только verstak-guide, без системных и пользовательских команд. */
  helpScope?: boolean
}

export function SlashCommandPopup({ text, onClear, onInject, systemCommands = [], projectPath = null, helpScope = false }: Props) {
  const skills = useSkills(s => s.skills)
  const setActiveSkill = useSkills(s => s.setActiveSkill)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [userCommands, setUserCommands] = useState<UserCommand[]>([])

  // Активируется при тексте начинающемся с "/"
  const slashState = parseSlash(text)
  const isOpen = slashState !== null

  // Загружаем команды когда popup открывается
  useEffect(() => {
    if (!isOpen || helpScope) return
    window.api.commands.list(projectPath).then(cmds => {
      setUserCommands(cmds)
    }).catch(err => {
      console.error('[SlashCommandPopup] commands:list failed:', err)
    })
  }, [isOpen, projectPath, helpScope])

  // Собрать все команды: skill slashes + user-commands + system
  const allCommands: SlashCommand[] = useMemo(() => {
    const skillCommands: SlashCommand[] = skills
      .filter(s => s.slash && (!helpScope || s.id === HELP_SKILL_ID))
      .map(s => ({
        kind: 'skill' as const,
        skillId: s.id,
        trigger: s.slash!,
        label: s.name ?? s.id,
        description: s.description,
        icon: s.icon
      }))
    if (helpScope) return skillCommands
    const cmdCommands: SlashCommand[] = userCommands.map(cmd => ({
      kind: 'user-command' as const,
      command: cmd,
      trigger: cmd.name,
      label: cmd.name,
      description: cmd.description || undefined,
      icon: cmd.scope === 'project' ? '📁' : '📝'
    }))
    return [...skillCommands, ...cmdCommands, ...systemCommands]
  }, [skills, userCommands, systemCommands, helpScope])

  // Фильтр по введённому query
  const filtered = useMemo(() => {
    if (!slashState) return []
    const q = slashState.query.toLowerCase()
    if (!q) return allCommands
    return allCommands.filter(c =>
      c.trigger.toLowerCase().includes(q) ||
      c.label.toLowerCase().includes(q)
    )
  }, [allCommands, slashState])

  // Reset selection at filter change
  useEffect(() => {
    setSelectedIdx(0)
  }, [text])

  // Keyboard handler — global while popup open
  useEffect(() => {
    if (!isOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIdx(i => Math.min(filtered.length - 1, i + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIdx(i => Math.max(0, i - 1))
      } else if (e.key === 'Enter' && filtered[selectedIdx]) {
        e.preventDefault()
        execute(filtered[selectedIdx])
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClear()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, filtered, selectedIdx])

  if (!isOpen) return null

  function execute(cmd: SlashCommand) {
    if (cmd.kind === 'skill') {
      setActiveSkill(cmd.skillId)
      onClear()
    } else if (cmd.kind === 'system') {
      cmd.action()
      onClear()
    } else {
      // user-command: сначала backend-раскрытие ($1/$ARGUMENTS + инъекция !`bash`),
      // затем промпт остаточных $VARIABLE, затем инжект. argString = текст после триггера.
      const userCmd = cmd.command
      const sp = text.indexOf(' ')
      const argString = sp >= 0 ? text.slice(sp + 1).trim() : ''
      void window.api.commands.expand(userCmd.name, argString, projectPath)
        .then(expanded => {
          let body = expanded || userCmd.body
          for (const varName of userCmd.variables) {
            // $VARIABLE мог уже быть подставлен из $ARGUMENTS — промптим только оставшиеся
            if (!body.includes(`$${varName}`)) continue
            // eslint-disable-next-line no-alert
            const val = window.prompt(`Введи значение для $${varName}:`) ?? ''
            body = body.replaceAll(`$${varName}`, val)
          }
          if (onInject) onInject(body); else onClear()
        })
        .catch(err => {
          console.error('[SlashCommandPopup] expand failed:', err)
          if (onInject) onInject(userCmd.body); else onClear()
        })
    }
  }

  // Разделитель между скиллами и командами (user-command) — показываем если обе группы есть
  const hasSkillsInFiltered = filtered.some(c => c.kind === 'skill')
  const hasCommandsInFiltered = filtered.some(c => c.kind === 'user-command')
  const firstCommandIdx = filtered.findIndex(c => c.kind === 'user-command')

  if (filtered.length === 0) {
    return (
      <div className="gg-slash-popup">
        <div className="gg-slash-empty">Нет команд по запросу «/{slashState.query}»</div>
      </div>
    )
  }

  return (
    <div className="gg-slash-popup">
      <div className="gg-slash-header">Команды агента — Enter для выбора, Esc закрыть</div>
      {filtered.map((c, i) => {
        const key = c.kind === 'skill' ? `skill:${c.skillId}` : c.kind === 'user-command' ? `cmd:${c.command.id}` : `sys:${c.trigger}`
        const showSeparator = c.kind === 'user-command' && i === firstCommandIdx && hasSkillsInFiltered && hasCommandsInFiltered
        return (
          <div key={key}>
            {showSeparator && (
              <div className="gg-slash-separator">Команды</div>
            )}
            <div
              className={`gg-slash-item ${i === selectedIdx ? 'is-selected' : ''}`}
              onMouseEnter={() => setSelectedIdx(i)}
              onClick={() => execute(c)}
            >
              <span className="gg-slash-icon">{c.icon ?? '🎭'}</span>
              <span className="gg-slash-body">
                <span className="gg-slash-name">
                  /{c.trigger}
                  <span className="gg-slash-label">— {c.label}</span>
                  {c.kind === 'user-command' && (
                    <span className="gg-slash-scope-badge">{c.command.scope}</span>
                  )}
                </span>
                {c.description && <span className="gg-slash-desc">{c.description}</span>}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

interface SlashState { query: string }
function parseSlash(text: string): SlashState | null {
  // Активируется только если ВЕСЬ текст начинается с "/" (не где-то в середине)
  // и не содержит пробелов после слэша (иначе это уже args)
  if (!text.startsWith('/')) return null
  const afterSlash = text.slice(1)
  if (afterSlash.includes('\n')) return null
  // Allow space-separated args eventually; for V1 — show popup as long as
  // single-word slash without space
  const spaceIdx = afterSlash.indexOf(' ')
  const query = spaceIdx >= 0 ? afterSlash.slice(0, spaceIdx) : afterSlash
  return { query }
}
