// Декомпозиция Chat.tsx (2.1.11 срез B): системные слэш-команды композера.
//
// Вынесено дословно из JSX-пропа SlashCommandPopup. Раньше это был литерал массива
// прямо в разметке — 45 строк между текстовым полем и попапом, из-за которых сама
// разметка композера не читалась.
//
// Состав и порядок команд сохранены: они определяют порядок в попапе.

import { MULTI_AGENT_TEMPLATES } from '../../lib/multi-agent-templates'
import type { SlashCommand } from '../SlashCommandPopup'

export interface SystemSlashCommandDeps {
  /** Создать новый чат в проекте. */
  newChatSession: () => void
  /** Снять активный скилл (сообщения остаются). */
  clearActiveSkill: () => void
  /**
   * Вставить шаблон мультиагента в композер. Важно: execute() попапа после action()
   * зовёт onClear() (= setInput('')), поэтому сам injectTemplate обязан ставить
   * значение в следующий тик — иначе очистка перетрёт шаблон. Эта механика живёт в
   * Chat.tsx и здесь не меняется.
   */
  injectTemplate: (template: string) => void
}

export function buildSystemSlashCommands(deps: SystemSlashCommandDeps): SlashCommand[] {
  return [
    {
      kind: 'system',
      trigger: 'new',
      label: 'Новый чат',
      description: 'Создать новый чат в проекте',
      icon: '➕',
      action: deps.newChatSession,
    },
    {
      kind: 'system',
      trigger: 'clear',
      label: 'Очистить контекст',
      description: 'Снять активный скилл (сообщения остаются)',
      icon: '∅',
      action: deps.clearActiveSkill,
    },
    // Цель 2.7.0 (пункт 2): мультиагентные шаблоны сняты с витрины. Они ничего
    // не запускали — вставляли в поле текст, ПРОСЯЩИЙ агента вызвать orchestrate/
    // swarm/delegate_parallel. Инструменты живут у агента, и он вызывает их сам,
    // как это делает Claude Code. Здесь остаётся отладочный путь: команда
    // работает, но не предлагается (hidden — см. SlashCommandPopup).
    {
      kind: 'system',
      hidden: true,
      trigger: MULTI_AGENT_TEMPLATES.orchestrate.trigger,
      label: MULTI_AGENT_TEMPLATES.orchestrate.label,
      description: 'Оркестратор — разбить цель на подзадачи по ролям',
      icon: MULTI_AGENT_TEMPLATES.orchestrate.icon,
      action: () => deps.injectTemplate(MULTI_AGENT_TEMPLATES.orchestrate.template),
    },
    {
      kind: 'system',
      hidden: true,
      trigger: MULTI_AGENT_TEMPLATES.swarm.trigger,
      label: MULTI_AGENT_TEMPLATES.swarm.label,
      description: 'Рой — N агентов разными стратегиями + арбитр',
      icon: MULTI_AGENT_TEMPLATES.swarm.icon,
      action: () => deps.injectTemplate(MULTI_AGENT_TEMPLATES.swarm.template),
    },
    {
      kind: 'system',
      hidden: true,
      trigger: MULTI_AGENT_TEMPLATES.parallel.trigger,
      label: MULTI_AGENT_TEMPLATES.parallel.label,
      description: 'Параллельно — пакет независимых задач суб-агентам',
      icon: MULTI_AGENT_TEMPLATES.parallel.icon,
      action: () => deps.injectTemplate(MULTI_AGENT_TEMPLATES.parallel.template),
    },
  ]
}
