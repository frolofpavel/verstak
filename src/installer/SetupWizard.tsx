import { useEffect, useMemo, useState } from 'react'
import type { InstallDefaults, InstallProgress } from '../../electron/installer/types'
import iconUrl from '../assets/icon.png'
import { MODEL_PROVIDER_COUNT } from './constants'

type Step = 'welcome' | 'directory' | 'installing' | 'finish'

const FEATURES = [
  `${MODEL_PROVIDER_COUNT} провайдеров AI-моделей`,
  'Проекты и память',
  'Skills и артефакты',
]

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`
}

function stepIndex(step: Step): number {
  switch (step) {
    case 'welcome': return 0
    case 'directory': return 1
    case 'installing': return 2
    case 'finish': return 3
  }
}

export function SetupWizard() {
  const [defaults, setDefaults] = useState<InstallDefaults | null>(null)
  const [step, setStep] = useState<Step>('welcome')
  const [installDir, setInstallDir] = useState('')
  const [runAfter, setRunAfter] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<InstallProgress | null>(null)
  const [installedDir, setInstalledDir] = useState('')

  useEffect(() => {
    void window.installer.getDefaults().then((d) => {
      setDefaults(d)
      setInstallDir(d.defaultInstallDir)
    })
  }, [])

  useEffect(() => {
    return window.installer.onProgress((p) => setProgress(p))
  }, [])

  const activeStep = stepIndex(step)

  const phaseLabel = useMemo(() => {
    if (!progress) return 'Подготовка…'
    switch (progress.phase) {
      case 'preparing': return 'Подготовка…'
      case 'copying': return 'Копирование файлов…'
      case 'shortcuts': return 'Создание ярлыков…'
      case 'registry': return 'Регистрация в системе…'
      case 'done': return 'Готово'
    }
  }, [progress])

  async function browse() {
    const picked = await window.installer.browseDirectory(installDir)
    if (picked) setInstallDir(picked)
  }

  async function startInstall() {
    setError('')
    setBusy(true)
    setStep('installing')
    const result = await window.installer.install(installDir)
    setBusy(false)
    if (!result.ok) {
      setError(result.error || 'Не удалось установить Verstak.')
      setStep('directory')
      return
    }
    setInstalledDir(result.installDir || installDir)
    setStep('finish')
  }

  function renderContent() {
    if (!defaults) {
      return (
        <div className="gg-installer-boot">
          <div className="gg-installer-boot-spinner" aria-hidden="true" />
          <p className="gg-installer-boot-title">Загрузка установщика…</p>
          <p className="gg-installer-text">Сканирование пакета приложения.</p>
        </div>
      )
    }

    if (step === 'welcome') {
      return (
        <>
          <h1 className="gg-installer-title">Добро пожаловать в Verstak</h1>
          <p className="gg-installer-lead">
            IDE для AI-агентов с {MODEL_PROVIDER_COUNT} провайдерами моделей
          </p>
          <p className="gg-installer-text">
            Мастер установит Verstak на ваш компьютер.{'\n\n'}
            Рекомендуется закрыть другие приложения перед продолжением.
          </p>
        </>
      )
    }

    if (step === 'directory') {
      return (
        <>
          <h1 className="gg-installer-title">Папка установки</h1>
          <p className="gg-installer-text">
            Укажите папку, в которую будет установлен Verstak. Требуется около {formatBytes(defaults.payloadBytes)} на диске.
          </p>
          <div className="gg-installer-field">
            <label className="gg-installer-label" htmlFor="install-dir">Папка установки</label>
            <div className="gg-installer-path-row">
              <input
                id="install-dir"
                className="gg-input"
                value={installDir}
                onChange={(e) => setInstallDir(e.target.value)}
              />
              <button type="button" className="gg-btn" onClick={() => void browse()}>Обзор…</button>
            </div>
          </div>
          {error ? <div className="gg-installer-error">{error}</div> : null}
        </>
      )
    }

    if (step === 'installing') {
      const percent = progress?.percent ?? 0
      return (
        <>
          <h1 className="gg-installer-title">Установка Verstak</h1>
          <p className="gg-installer-text">Копирование файлов на диск. Не закрывайте окно до завершения.</p>
          <div className="gg-installer-progress">
            <div className="gg-installer-progress-track">
              <div className="gg-installer-progress-fill" style={{ width: `${percent}%` }} />
            </div>
            <div className="gg-installer-progress-meta">
              {phaseLabel} {percent}%
              {progress?.currentFile ? ` — ${progress.currentFile}` : ''}
            </div>
          </div>
        </>
      )
    }

    return (
      <>
        <h1 className="gg-installer-title">Verstak установлен</h1>
        <p className="gg-installer-lead">
          {MODEL_PROVIDER_COUNT} провайдеров моделей готовы к подключению
        </p>
        <p className="gg-installer-text">
          Ярлык появится в меню «Пуск» и на рабочем столе.
        </p>
        <label className="gg-installer-check">
          <input type="checkbox" checked={runAfter} onChange={(e) => setRunAfter(e.target.checked)} />
          Запустить Verstak
        </label>
      </>
    )
  }

  function renderFooter() {
    if (step === 'welcome') {
      return (
        <>
          <button type="button" className="gg-btn" onClick={() => void window.installer.window.close()}>Отмена</button>
          <button type="button" className="gg-btn gg-btn-primary" onClick={() => setStep('directory')}>Далее</button>
        </>
      )
    }

    if (step === 'directory') {
      return (
        <>
          <button type="button" className="gg-btn" disabled={busy} onClick={() => setStep('welcome')}>Назад</button>
          <button type="button" className="gg-btn" disabled={busy} onClick={() => void window.installer.window.close()}>Отмена</button>
          <button type="button" className="gg-btn gg-btn-primary" disabled={busy || !installDir.trim()} onClick={() => void startInstall()}>
            Установить
          </button>
        </>
      )
    }

    if (step === 'installing') {
      return (
        <button type="button" className="gg-btn" disabled>
          Отмена
        </button>
      )
    }

    return (
      <button
        type="button"
        className="gg-btn gg-btn-primary"
        onClick={async () => {
          if (runAfter && installedDir) await window.installer.launchApp(installedDir)
          void window.installer.window.close()
        }}
      >
        Готово
      </button>
    )
  }

  return (
    <div className="gg-installer-body">
      <aside className="gg-installer-sidebar">
        <div className="gg-installer-brand">VERSTAK</div>
        <div className="gg-installer-logo-wrap">
          <img src={iconUrl} alt="" className="gg-installer-logo" />
        </div>
        <div className="gg-installer-mode">
          <div className="gg-installer-mode-title">УСТАНОВКА</div>
          <div className="gg-installer-mode-stat">{MODEL_PROVIDER_COUNT}</div>
          <div className="gg-installer-mode-sub">провайдеров AI-моделей</div>
        </div>
        <div className="gg-installer-features">
          {FEATURES.map((text) => (
            <div key={text} className="gg-installer-feature">
              <span className="gg-installer-feature-dot" />
              <span>{text}</span>
            </div>
          ))}
        </div>
        <div className="gg-installer-steps">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={`gg-installer-step${i <= activeStep ? ' is-active' : ''}`} />
          ))}
        </div>
      </aside>

      <section className="gg-installer-main">
        <div className="gg-installer-content">{renderContent()}</div>
        <footer className="gg-installer-footer">{renderFooter()}</footer>
      </section>
    </div>
  )
}