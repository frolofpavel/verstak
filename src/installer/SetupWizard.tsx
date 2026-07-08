import { useEffect, useMemo, useState } from 'react'
import type { InstallDefaults, InstallProgress } from '../../electron/installer/types'
import iconUrl from '../assets/icon.png'
import { INSTALLER_VALUE_PROPS, INSTALLER_WIZARD_STEPS, MODEL_PROVIDER_COUNT } from './constants'
import { InstallerLoader } from './InstallerLoader'

type Step = 'welcome' | 'directory' | 'installing' | 'finish'

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
  const [defaultsError, setDefaultsError] = useState('')
  const [step, setStep] = useState<Step>('welcome')
  const [installDir, setInstallDir] = useState('')
  const [runAfter, setRunAfter] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<InstallProgress | null>(null)
  const [installedDir, setInstalledDir] = useState('')

  useEffect(() => {
    let cancelled = false
    void window.installer.getDefaults()
      .then((d) => {
        if (cancelled) return
        setDefaults(d)
        setInstallDir(d.defaultInstallDir)
      })
      .catch((err) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setDefaultsError(message || 'Не удалось подготовить мастер установки.')
      })
    return () => { cancelled = true }
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
    if (defaultsError) {
      return (
        <>
          <h1 className="gg-installer-title">Не удалось запустить установщик</h1>
          <p className="gg-installer-text">
            Verstak Setup не смог прочитать пакет приложения. Перезапустите установщик или скачайте файл заново.
          </p>
          <div className="gg-installer-error">{defaultsError}</div>
        </>
      )
    }

    if (!defaults) {
      return (
        <InstallerLoader
          title="Загрузка мастера установки"
          hint="Секунду — проверяем пакет приложения на диске."
        />
      )
    }

    if (step === 'welcome') {
      return (
        <>
          <h1 className="gg-installer-title">Добро пожаловать</h1>
          <p className="gg-installer-lead">
            Verstak — IDE для разработки с AI-агентами
          </p>
          <ul className="gg-installer-value-list">
            {INSTALLER_VALUE_PROPS.map((item) => (
              <li key={item.title} className="gg-installer-value-item">
                <span className="gg-installer-value-title">{item.title}</span>
                <span className="gg-installer-value-text">{item.text}</span>
              </li>
            ))}
          </ul>
          <p className="gg-installer-text gg-installer-text-muted">
            Мастер скопирует программу в выбранную папку и создаст ярлыки.
            Перед установкой лучше закрыть другие тяжёлые приложения.
          </p>
        </>
      )
    }

    if (step === 'directory') {
      return (
        <>
          <h1 className="gg-installer-title">Папка установки</h1>
          <p className="gg-installer-text">
            Укажите, куда установить Verstak. Понадобится около {formatBytes(defaults.payloadBytes)} свободного места.
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
          <p className="gg-installer-text">Копируем файлы на диск. Не закрывайте окно до завершения.</p>
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
        <h1 className="gg-installer-title">Готово</h1>
        <p className="gg-installer-lead">Verstak установлен</p>
        <p className="gg-installer-text">
          Ярлык появится в меню «Пуск» и на рабочем столе.
          Подключите провайдеры в настройках — доступно {MODEL_PROVIDER_COUNT} вариантов.
        </p>
        <label className="gg-installer-check">
          <input type="checkbox" checked={runAfter} onChange={(e) => setRunAfter(e.target.checked)} />
          Запустить Verstak
        </label>
      </>
    )
  }

  function renderFooter() {
    if (defaultsError) {
      return (
        <button type="button" className="gg-btn gg-btn-primary" onClick={() => void window.installer.window.close()}>
          Закрыть
        </button>
      )
    }

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
        <div className="gg-installer-sidebar-caption">Мастер установки</div>
        <nav className="gg-installer-stepper" aria-label="Шаги установки">
          {INSTALLER_WIZARD_STEPS.map((item, index) => {
            const state = index < activeStep ? 'done' : index === activeStep ? 'current' : 'todo'
            return (
              <div key={item.key} className={`gg-installer-stepper-item is-${state}`}>
                <span className="gg-installer-stepper-index">{index + 1}</span>
                <span className="gg-installer-stepper-body">
                  <span className="gg-installer-stepper-label">{item.label}</span>
                  <span className="gg-installer-stepper-hint">{item.hint}</span>
                </span>
              </div>
            )
          })}
        </nav>
        {defaults ? (
          <div className="gg-installer-sidebar-meta">
            <span>Версия {defaults.version}</span>
            <span>{formatBytes(defaults.payloadBytes)}</span>
          </div>
        ) : null}
      </aside>

      <section className="gg-installer-main">
        <div className="gg-installer-content">{renderContent()}</div>
        <footer className="gg-installer-footer">{renderFooter()}</footer>
      </section>
    </div>
  )
}
