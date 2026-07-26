// Декомпозиция Chat.tsx (2.1.11 срез B): скилл-полосы композера.
//
// Вынесено из Chat.tsx БЕЗ изменения разметки, классов и порядка блоков. Один
// связный узел «что скиллы говорят про следующее сообщение»:
//  · применённые к сообщению скиллы (чипы со снятием);
//  · активный скилл чата (полоса со «Снять»);
//  · тост о скрытых рекомендациях;
//  · рекомендованный workflow (recipe) и рекомендованные скиллы.
//
// Компонент чисто презентационный: своего состояния нет, в стор не ходит —
// все решения остаются в Chat.tsx. Порядок блоков в разметке сохранён дословно:
// он определяет вертикальный порядок полос над полем ввода.

import { skillDisplayName } from './skill-prompts'
import type { AppliedSkillRef, Skill } from '../../types/api'

export interface ComposerSkillBarProps {
  /** Скиллы, применённые к текущему (ещё не отправленному) сообщению. */
  appliedSkills: AppliedSkillRef[]
  onRemoveApplied: (id: string) => void
  /** Активный скилл чата — null, если не выбран или это чат справки. */
  activeSkill: Skill | null
  onClearActiveSkill: () => void
  /** Показывать тост «рекомендации скрыты». */
  showSuggestionsHiddenToast: boolean
  suggestedRecipe: Skill | null
  suggestedSkills: Skill[]
  onApplySkill: (skill: Skill) => void
  /** Выключить рекомендации скиллов в этом проекте. */
  onDisableSuggestions: () => void
  onDismissRecipe: (id: string) => void
  onDismissSkills: (skills: Skill[]) => void
  /** Чат справки: активный скилл и рекомендации в нём не показываются. */
  isHelpChat: boolean
}

export function ComposerSkillBar(props: ComposerSkillBarProps) {
  const {
    appliedSkills, onRemoveApplied, activeSkill, onClearActiveSkill,
    showSuggestionsHiddenToast, suggestedRecipe, suggestedSkills,
    onApplySkill, onDisableSuggestions, onDismissRecipe, onDismissSkills, isHelpChat,
  } = props
  return (
    <>
      {appliedSkills.length > 0 && (
        <div className="gg-applied-skills-draft" aria-label="Скиллы, применённые к текущему сообщению">
          <span className="gg-applied-skills-draft-label">К сообщению применено</span>
          <div className="gg-applied-skills-draft-list">
            {appliedSkills.map(skill => (
              <span key={skill.id} className="gg-applied-skill-chip">
                {skill.icon && <span aria-hidden>{skill.icon}</span>}
                <span>{skillDisplayName(skill)}</span>
                <button
                  type="button"
                  onClick={() => onRemoveApplied(skill.id)}
                  title={`Убрать скилл ${skillDisplayName(skill)} из этого сообщения`}
                  aria-label={`Убрать скилл ${skillDisplayName(skill)} из этого сообщения`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
      {!isHelpChat && activeSkill && (
        <div className="gg-active-skill-bar">
          <div className="gg-active-skill-main">
            <span className="gg-active-skill-dot" aria-hidden />
            <span className="gg-active-skill-kicker">Активен скилл</span>
            <strong>{skillDisplayName(activeSkill)}</strong>
            <span className="gg-active-skill-detail">следующее сообщение пойдёт по его инструкции</span>
          </div>
          <button
            type="button"
            className="gg-active-skill-clear"
            onClick={onClearActiveSkill}
          >
            Снять
          </button>
        </div>
      )}
      {!isHelpChat && showSuggestionsHiddenToast && (
        <div className="gg-skill-suggest-toast" role="status" aria-live="polite">
          Рекомендации скиллов скрыты. Вернуть их можно в «Инструментах чата».
        </div>
      )}
      {suggestedRecipe && (
        <div className="gg-skill-suggest is-recipe">
          <div className="gg-skill-suggest-icon" aria-hidden>{suggestedRecipe.icon ?? '◎'}</div>
          <div className="gg-skill-suggest-main">
            <div className="gg-skill-suggest-kicker">Рекомендованный workflow</div>
            <div className="gg-skill-suggest-title">{skillDisplayName(suggestedRecipe)}</div>
            <div className="gg-skill-suggest-detail">
              Применится только к этому сообщению и даст модели строгий порядок работы.
            </div>
          </div>
          <button
            type="button"
            className="gg-skill-suggest-accept"
            onClick={() => onApplySkill(suggestedRecipe)}
          >Применить</button>
          <button
            type="button"
            className="gg-skill-suggest-project-off"
            onClick={onDisableSuggestions}
            title="Отключить рекомендации скиллов в этом проекте"
          >Не показывать</button>
          <button
            type="button"
            className="gg-skill-suggest-dismiss"
            onClick={() => onDismissRecipe(suggestedRecipe.id)}
            title="Скрыть предложение"
          >×</button>
        </div>
      )}
      {suggestedSkills.length > 0 && !suggestedRecipe && (
        <div className="gg-skill-suggest">
          <div className="gg-skill-suggest-icon" aria-hidden>{suggestedSkills.length === 1 ? (suggestedSkills[0].icon ?? '◎') : '＋'}</div>
          <div className="gg-skill-suggest-main">
            <div className="gg-skill-suggest-kicker">
              {suggestedSkills.length === 1 ? 'Рекомендованный скилл' : 'Рекомендованные скиллы'}
            </div>
            <div className="gg-skill-suggest-title">
              {suggestedSkills.length === 1 ? skillDisplayName(suggestedSkills[0]) : `${suggestedSkills.length} регламента под задачу`}
            </div>
            <div className="gg-skill-suggest-detail">
              Подключаются только к текущему сообщению и передаются модели как прямое указание.
            </div>
            <div className="gg-skill-suggest-chips" aria-label="Подходящие скиллы">
              {suggestedSkills.map(skill => (
                <span key={skill.id} className="gg-skill-suggest-chip">
                  {skill.icon && <span aria-hidden>{skill.icon}</span>}
                  <span>{skillDisplayName(skill)}</span>
                  <button
                    type="button"
                    onClick={() => onApplySkill(skill)}
                    title={`Применить ${skillDisplayName(skill)} к текущему сообщению`}
                  >+</button>
                </span>
              ))}
            </div>
          </div>
          <button
            type="button"
            className="gg-skill-suggest-accept"
            onClick={() => suggestedSkills.forEach(skill => onApplySkill(skill))}
          >{suggestedSkills.length === 1 ? 'Применить' : 'Применить все'}</button>
          <button
            type="button"
            className="gg-skill-suggest-project-off"
            onClick={onDisableSuggestions}
            title="Отключить рекомендации скиллов в этом проекте"
          >Не показывать</button>
          <button
            type="button"
            className="gg-skill-suggest-dismiss"
            onClick={() => onDismissSkills(suggestedSkills)}
            title="Скрыть предложение"
          >×</button>
        </div>
      )}
    </>
  )
}
