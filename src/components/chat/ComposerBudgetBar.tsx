// Декомпозиция Chat.tsx (2.1.11 срез B): полоса исчерпанного бюджета ходов.
//
// Вынесено дословно. Показывается, когда agent-loop упёрся в лимит ходов и задача
// осталась незавершённой: пользователь либо докидывает ходы тем же контекстом,
// либо закрывает полосу. Условие показа (в т.ч. «не во время стрима») осталось
// на вызывающей стороне — компонент только рисует.

export interface ComposerBudgetBarProps {
  /** Сколько ходов израсходовано. */
  used: number
  /** Сколько предлагается добавить. */
  suggestedAdd: number
  onContinue: () => void
  onClose: () => void
}

export function ComposerBudgetBar({ used, suggestedAdd, onContinue, onClose }: ComposerBudgetBarProps) {
  return (
    <div className="gg-budget-bar">
      <span>⏸ Бюджет {used} ходов исчерпан — задача не завершена.</span>
      <div className="gg-budget-actions">
        <button
          className="gg-btn gg-btn-primary"
          onClick={onContinue}
          title={`Продолжить с тем же контекстом, +${suggestedAdd} ходов`}
        >+{suggestedAdd} ходов</button>
        <button
          className="gg-btn gg-btn-ghost"
          onClick={onClose}
        >Закрыть</button>
      </div>
    </div>
  )
}
