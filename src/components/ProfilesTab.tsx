export function ProfilesTab() {
  return (
    <div className="gg-settings-extra gg-profile-soon-page">
      <section className="gg-profile-soon-card">
        <div className="gg-profile-soon-kicker">Скоро</div>
        <h3>Профиль и организация</h3>
        <p>
          Здесь появятся аккаунт пользователя, команда, роли и доступы к проектам
        </p>
        <div className="gg-profile-soon-grid">
          <div>
            <span>Профиль</span>
            <p>Имя, почта, аватар и личные настройки</p>
          </div>
          <div>
            <span>Организация</span>
            <p>Компания, участники, группы и роли</p>
          </div>
          <div>
            <span>Доступы</span>
            <p>Какие проекты видит каждый сотрудник</p>
          </div>
        </div>
      </section>
    </div>
  )
}
