/**
 * Срез 2.1.3-A/B: управление подписочными аккаунтами ПЕРЕЕХАЛО в единый центр
 * «Настройки → Подписки». Эта панель больше не второе место управления (был дубль:
 * свои списки/состояние в карточке провайдера) — осталась только карточка-переход,
 * чтобы человек, привыкший искать аккаунты здесь, попал в правильный раздел одним кликом.
 */
export function SubscriptionAccountsPanel({ onOpenSubscriptions }: {
  onOpenSubscriptions?: () => void
}) {
  return (
    <div className="gg-subacct">
      <div className="gg-subacct-head">
        <span className="gg-subacct-title">Аккаунты подписки</span>
      </div>
      <div className="gg-subacct-empty">
        Управление аккаунтами подписки переехало в раздел «Подписки» — там весь парк
        аккаунтов одним списком, с состояниями и диагностикой.
      </div>
      <div style={{ marginTop: 8 }}>
        <button type="button" className="gg-btn gg-btn-ghost" onClick={() => onOpenSubscriptions?.()}>
          Открыть «Подписки»
        </button>
      </div>
    </div>
  )
}
