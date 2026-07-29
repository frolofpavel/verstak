import React, { useEffect, useState } from 'react'
import type { PolicyDecision, PolicyMatrixDTO } from '../../types/api'

// === Policy Center ===
// Read-only экран «что разрешено агенту»: матрица decide(tool, mode) по 5 режимам
// + опасные команды. Логика НЕ дублируется — данные приходят из policy:matrix.

const POLICY_CATEGORY_LABELS: Record<string, string> = {
  read: 'Чтение',
  edit: 'Правка файлов',
  command: 'Команды',
  connector: 'Коннекторы'
}

const POLICY_TOOL_LABELS: Record<string, string> = {
  read_file: 'Чтение файлов',
  write_file: 'Запись файлов',
  apply_patch: 'Патчи',
  run_command: 'Команды',
  connector_query: 'Коннекторы'
}

const POLICY_DECISION_META: Record<PolicyDecision, { label: string; cls: string; description: string }> = {
  'auto-accept': { label: 'Без подтверждения', cls: 'auto', description: 'Модель выполнит действие сразу' },
  'confirm':     { label: 'Нужно подтверждение', cls: 'confirm', description: 'Verstak спросит перед действием' },
  'block':       { label: 'Заблокировано', cls: 'block', description: 'Действие выполнить нельзя' }
}

const POLICY_MODE_TABLE_LABELS: Record<string, string> = {
  ask: 'Запрос разрешений',
  'accept-edits': 'Правки',
  plan: 'Планирование',
  auto: 'Авто',
  bypass: 'Без подтверждения'
}

export function PolicyTab() {
  const [matrix, setMatrix] = useState<PolicyMatrixDTO | null>(null)
  const [dodMode, setDodMode] = useState<string>('warn')
  const [allowlist, setAllowlist] = useState<string>('')
  const [allowedWriteRoots, setAllowedWriteRoots] = useState<string>('')
  const [autoEdits, setAutoEdits] = useState(false)
  const [autoCommands, setAutoCommands] = useState(false)
  const [hooksOn, setHooksOn] = useState(false)
  const [hooksProjectOn, setHooksProjectOn] = useState(false)
  const [webAccess, setWebAccess] = useState(false)
  const [outputStyle, setOutputStyle] = useState('default')
  const [outputStyleList, setOutputStyleList] = useState<Array<{ id: string; name: string; scope: string }>>([])

  useEffect(() => {
    void (async () => {
      const m = await window.api.policy.matrix()
      setMatrix(m)
      const dm = await window.api.settings.getKey('dod_mode')
      setDodMode(dm || 'warn')
      const al = await window.api.settings.getKey('bash_allowlist')
      setAllowlist(al || '')
      const awr = await window.api.settings.getKey('allowed_write_roots')
      setAllowedWriteRoots(awr || '')
      setAutoEdits((await window.api.settings.getKey('auto_approve_edits')) === 'true')
      setAutoCommands((await window.api.settings.getKey('auto_approve_commands')) === 'true')
      setHooksOn((await window.api.settings.getKey('hooks_enabled')) === 'true')
      setHooksProjectOn((await window.api.settings.getKey('hooks_project_enabled')) === 'true')
      setWebAccess((await window.api.settings.getKey('web_access')) === 'true')
      setOutputStyle((await window.api.settings.getKey('output_style')) || 'default')
      try { setOutputStyleList(await window.api.settings.outputStyles(null)) } catch { /* список стилей — best-effort */ }
    })()
  }, [])

  const changeAutoEdits = async (v: boolean) => { setAutoEdits(v); await window.api.settings.setKey('auto_approve_edits', v ? 'true' : 'false') }
  const changeAutoCommands = async (v: boolean) => { setAutoCommands(v); await window.api.settings.setKey('auto_approve_commands', v ? 'true' : 'false') }
  const changeHooks = async (v: boolean) => { setHooksOn(v); await window.api.settings.setKey('hooks_enabled', v ? 'true' : 'false') }
  const changeHooksProject = async (v: boolean) => { setHooksProjectOn(v); await window.api.settings.setKey('hooks_project_enabled', v ? 'true' : 'false') }
  const changeWebAccess = async (v: boolean) => { setWebAccess(v); await window.api.settings.setKey('web_access', v ? 'true' : 'false') }
  const changeOutputStyle = async (v: string) => { setOutputStyle(v); await window.api.settings.setKey('output_style', v) }

  const changeDod = async (v: string) => {
    setDodMode(v)
    await window.api.settings.setKey('dod_mode', v)
  }

  const changeAllowlist = async (v: string) => {
    setAllowlist(v)
    await window.api.settings.setKey('bash_allowlist', v)
  }

  const changeAllowedWriteRoots = async (v: string) => {
    setAllowedWriteRoots(v)
    await window.api.settings.setKey('allowed_write_roots', v)
  }

  if (!matrix) {
    return <div className="gg-settings-extra"><div className="gg-settings-hint">Загрузка политики…</div></div>
  }

  const trustedCommandCount = allowlist.split(/\r?\n/).map(line => line.trim()).filter(Boolean).length
  const writeRootCount = allowedWriteRoots.split(/\r?\n/).map(line => line.trim()).filter(Boolean).length
  const policyGridStyle = {
    gridTemplateColumns: `minmax(108px, 1.05fr) repeat(${matrix.modes.length}, minmax(0, 0.72fr))`
  } as React.CSSProperties
  const policyTableRows = matrix.rows.map(row => ({
    ...row,
    label: POLICY_TOOL_LABELS[row.tool] || POLICY_CATEGORY_LABELS[row.category] || row.tool
  }))

  return (
    <div className="gg-settings-extra gg-policy">
      <section className="gg-policy-block gg-policy-matrix-block">
        <div className="gg-policy-block-head">
          <div>
            <div className="gg-settings-section-title">Карта режимов</div>
            <p>Показывает, какие действия модель выполнит сама, где спросит подтверждение, а что будет заблокировано</p>
          </div>
        </div>
        <div className="gg-policy-led-legend" aria-label="Обозначения прав">
          {(['auto-accept', 'confirm', 'block'] as PolicyDecision[]).map(decision => {
            const meta = POLICY_DECISION_META[decision]
            return (
              <span key={decision} className={`gg-policy-led-legend-item is-${meta.cls}`}>
                <i aria-hidden="true" />
                <b>{meta.label}</b>
              </span>
            )
          })}
        </div>
        <div className="gg-policy-permission-table" role="table" aria-label="Карта режимов">
          <div className="gg-policy-permission-row is-head" role="row" style={policyGridStyle}>
            <div className="gg-policy-permission-action-head" role="columnheader">Действие</div>
            {matrix.modes.map(mode => (
              <div
                key={mode.id}
                className="gg-policy-permission-mode-head"
                role="columnheader"
                title={`${mode.label}: ${mode.description}`}
              >
                {POLICY_MODE_TABLE_LABELS[mode.id] || mode.label}
              </div>
            ))}
          </div>
          {policyTableRows.map(row => (
            <div key={row.tool} className="gg-policy-permission-row" role="row" style={policyGridStyle}>
              <div className="gg-policy-permission-action" role="rowheader" title={row.tool}>
                <span>{row.label}</span>
              </div>
              {matrix.modes.map(mode => {
                const decision = row.decisions[mode.id]
                const meta = POLICY_DECISION_META[decision]
                return (
                  <div
                    key={`${row.tool}-${mode.id}`}
                    className="gg-policy-permission-cell"
                    role="cell"
                    title={`${mode.label}: ${row.label} - ${meta.label}. ${meta.description}`}
                    aria-label={`${mode.label}: ${row.label} - ${meta.label}`}
                  >
                    <span className={`gg-policy-led is-${meta.cls}`} aria-hidden="true" />
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </section>

      <section className="gg-policy-disclaimer">
        <div className="gg-policy-disclaimer-mark" aria-hidden="true" />
        <div>
          <strong>Важно про внешние модели</strong>
          <p>API-модели и встроенные инструменты контролируются Verstak. Внешние CLI-модели могут воспринимать режим только как инструкцию, поэтому для них задачи лучше формулировать явно</p>
        </div>
      </section>

      <details className="gg-policy-danger-details">
        <summary>
          <span>Всегда запрещено</span>
          <small>Действия, которые Verstak блокирует в любом режиме</small>
        </summary>
        <div className="gg-policy-danger-list">
          {matrix.commandDanger.map((d, i) => (
            <span key={i}>{d}</span>
          ))}
        </div>
      </details>

      <details className="gg-policy-advanced">
        <summary>
          <span>Дополнительные настройки</span>
          <small>Внешние папки, авто-одобрение, web-доступ и хуки</small>
        </summary>

        <div className="gg-policy-advanced-note">
          Эти настройки применяются к работе Verstak в целом. Проектные файлы правил могут уточнять поведение внутри конкретного проекта
        </div>

        <div className="gg-policy-advanced-grid">
          <section className="gg-policy-advanced-card">
            <div className="gg-settings-section-title">Внешние папки для записи</div>
            <p>Дополнительные рабочие зоны за пределами проекта</p>
            <span className="gg-policy-count">{writeRootCount ? `${writeRootCount} добавлено` : 'Пусто'}</span>
            <textarea
              className="gg-input"
              value={allowedWriteRoots}
              onChange={e => void changeAllowedWriteRoots(e.target.value)}
              placeholder={'C:\\Users\\User\\Downloads\\verstak-exports\nC:\\Projects\\Client\\_artifacts'}
              spellCheck={false}
              rows={4}
              style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
            />
          </section>

          <section className="gg-policy-advanced-card">
            <div className="gg-settings-section-title">Доказательство выполнения</div>
            <p>Поведение при не-зелёных проверках перед коммитом</p>
            <select className="gg-input" value={dodMode} onChange={e => void changeDod(e.target.value)}>
              <option value="warn">Предупреждать</option>
              <option value="block">Обязательно</option>
              <option value="off">Выключено</option>
            </select>
          </section>

          {/* «Одобрение плана» переехало во вкладку «Поведение агента» (29.07).
              Здесь оно жило внутри свёрнутого блока и на живой приёмке его не нашли.
              Второй переключатель рядом не оставлен сознательно: два контрола на один
              ключ не имеют общего состояния и начинают показывать разное. */}
          <section className="gg-policy-advanced-card">
            <div className="gg-settings-section-title">Авто-одобрение</div>
            <p>Тонкая настройка поверх выбранного режима</p>
            <label className="gg-theme-square">
              <input type="checkbox" checked={autoEdits} onChange={e => void changeAutoEdits(e.target.checked)} />
              <span>Авто-принимать правки файлов</span>
            </label>
            <label className="gg-theme-square">
              <input type="checkbox" checked={autoCommands} onChange={e => void changeAutoCommands(e.target.checked)} />
              <span>Авто-принимать команды</span>
            </label>
          </section>

          <section className="gg-policy-advanced-card">
            <div className="gg-settings-section-title">Подача ответа</div>
            <p>Стиль форматирования ответа агента</p>
            <select className="gg-input" value={outputStyle} onChange={e => void changeOutputStyle(e.target.value)}>
              {outputStyleList.map(s => (
                <option key={s.id} value={s.id}>{s.name}{s.scope !== 'built-in' ? ` (${s.scope})` : ''}</option>
              ))}
              {outputStyle && !outputStyleList.some(s => s.id === outputStyle) && (
                <option value={outputStyle}>{outputStyle} (не найден)</option>
              )}
            </select>
          </section>

          <section className="gg-policy-advanced-card">
            <div className="gg-settings-section-title">Веб-доступ</div>
            <p>Поиск в интернете и чтение публичных страниц по URL</p>
            <label className="gg-theme-square">
              <input type="checkbox" checked={webAccess} onChange={e => void changeWebAccess(e.target.checked)} />
              <span>Разрешить веб-доступ</span>
            </label>
          </section>

          <section className="gg-policy-advanced-card">
            <div className="gg-settings-section-title">Хуки</div>
            <p>Скрипты на события агента. Включай только для доверенных проектов</p>
            <label className="gg-theme-square">
              <input type="checkbox" checked={hooksOn} onChange={e => void changeHooks(e.target.checked)} />
              <span>Глобальные хуки</span>
            </label>
            <label className="gg-theme-square">
              <input type="checkbox" checked={hooksProjectOn} disabled={!hooksOn} onChange={e => void changeHooksProject(e.target.checked)} />
              <span>Хуки проекта</span>
            </label>
          </section>

          <section className="gg-policy-advanced-card is-wide">
            <div className="gg-settings-section-title">Правила доступа</div>
            <p>Файл <code>.verstak/permissions.json</code> в проекте или <code>~/.verstak/permissions.json</code> глобально. Приоритет: deny, ask, allow</p>
            <pre className="gg-policy-code">{`{
  "allow": ["Bash(npm:*)", "Read(src/**)"],
  "ask":   ["Bash(git push:*)"],
  "deny":  ["Bash(rm:*)", "Read(*.env)"]
}`}</pre>
          </section>

          <section className="gg-policy-advanced-card is-wide">
            <div className="gg-settings-section-title">Web-policy</div>
            <p>Ограничивает домены, которые агенту разрешено читать. Без файла доступны публичные адреса</p>
            <pre className="gg-policy-code">{`{
  "allow": ["python.org", "*.mozilla.org", "github.com"],
  "deny":  ["*.internal"]
}`}</pre>
          </section>

          <section className="gg-policy-advanced-card is-wide">
            <div className="gg-settings-section-title">Hooks.json</div>
            <p>Сценарии, которые выполняются до или после действий агента</p>
            <pre className="gg-policy-code">{`{
  "PreToolUse": [{ "matcher": "run_command", "command": "node guard.js" }],
  "PostToolUse": [{ "matcher": "write_file", "command": "npm run lint" }]
}`}</pre>
          </section>
        </div>
      </details>

      <details className="gg-policy-trusted-details">
        <summary>
          <span>Доверенные действия</span>
          <small>Команды, которые можно выполнять без повторного подтверждения</small>
          <em>{trustedCommandCount ? `${trustedCommandCount} добавлено` : 'Пусто'}</em>
        </summary>
        <div className="gg-policy-trusted-panel">
          <div className="gg-policy-trusted-copy">
            <strong>Что сюда писать</strong>
            <p>Безопасные команды, которые ты часто разрешаешь вручную. Одна команда на строку, лучше точная команда без широких масок</p>
          </div>
          <div className="gg-policy-trusted-examples" aria-label="Примеры доверенных действий">
            <span>git status</span>
            <span>npm test</span>
            <span>npm run build</span>
          </div>
          <p className="gg-policy-trusted-warning">
            Не добавляй удаление файлов, отправку в git, установку пакетов и команды с доступом к ключам
          </p>
        </div>
        <textarea
          className="gg-input"
          value={allowlist}
          onChange={e => void changeAllowlist(e.target.value)}
          placeholder={'git status\nnpm test\nls'}
          spellCheck={false}
          rows={4}
          style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
        />
      </details>
    </div>
  )
}
