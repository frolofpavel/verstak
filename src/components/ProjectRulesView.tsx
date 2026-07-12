import { useCallback, useEffect, useMemo, useState } from 'react'
import { useProject } from '../store/projectStore'
import type { RuleSourceStatus, UserLayerStatus } from '../types/api'

const DEFAULT_SOURCE_ID = '.verstak/RULES.md'

type TemplateId = 'base' | 'marketing' | 'development' | 'support' | 'reports' | 'operations'

const TEMPLATE_BLOCKS: Record<TemplateId, {
  title: string
  subtitle: string
  action: string
  impact: string
  risk: string
  recommended?: boolean
  content: string
}> = {
  base: {
    title: 'Базовый проект',
    subtitle: 'Общие правила, формат ответа и запреты',
    action: 'Добавить основу',
    impact: 'AI будет аккуратнее: меньше додумываний, больше уточнений, понятнее ответы',
    risk: 'Безопасно: не даёт AI новых прав и не запускает действия',
    recommended: true,
    content: `# Инструкции проекта

## О проекте

- Кратко опиши, чем занимается проект или клиент
- Укажи важные продукты, услуги, регионы, роли и ограничения
- Зафиксируй ссылки, системы и источники данных, которые часто нужны в работе

## Как AI должен работать

- Отвечать по делу и не додумывать факты без данных
- Если данных не хватает, сначала уточнить или явно написать, чего не хватает
- Учитывать историю проекта, подключённые источники, скиллы и правила пользователя

## Формат ответов

- Писать понятным языком для пользователя проекта
- Отделять выводы от действий
- Если задача сложная, кратко показывать план и результат

## Что нельзя делать

- Не удалять и не менять важные данные без явного подтверждения
- Не трогать секреты, токены, платежи и доступы без прямой задачи
- Не выдавать предположения за проверенные факты
`
  },
  marketing: {
    title: 'Маркетинг',
    subtitle: 'Реклама, контент, отчёты, площадки',
    action: 'Добавить маркетинг',
    impact: 'AI будет учитывать рекламные каналы, отчёты, правки кампаний и контент',
    risk: 'Безопасно, если проект связан с маркетингом',
    content: `## Маркетинг и реклама

- Перед выводами смотреть цель задачи: аудит, правки, отчёт, стратегия, контент или проверка гипотез
- Для рекламных задач учитывать площадку: Яндекс Директ, VK, Telegram, Авито, Google, CRM или другой источник
- Не менять кампании, бюджеты, аудитории, ставки и объявления без явной задачи или подтверждения
- В отчётах писать, что изменилось, почему это важно и что делать дальше
- Если изменения одинаковые в нескольких кампаниях или каналах, объединять их в один понятный пункт
`
  },
  development: {
    title: 'Разработка',
    subtitle: 'Код, вёрстка, проверки, деплой',
    action: 'Добавить разработку',
    impact: 'AI будет внимательнее к структуре кода, проверкам и границам задачи',
    risk: 'Безопасно для кодовых проектов',
    content: `## Разработка и вёрстка

- Сначала понять существующую структуру проекта и локальный стиль кода
- Делать только запрошенные изменения, без лишних рефакторингов
- Перед крупными правками кратко описывать план
- После изменений запускать доступные проверки и писать результат
- Не запускать деплой, миграции и destructive-команды без подтверждения
`
  },
  support: {
    title: 'Клиенты и поддержка',
    subtitle: 'CRM, задачи, коммуникации, сервис',
    action: 'Добавить поддержку',
    impact: 'AI будет разделять факты, договорённости, задачи и клиентские сообщения',
    risk: 'Безопасно для CRM, поддержки и командной работы',
    content: `## Клиенты, CRM и поддержка

- Разделять факты, договорённости, задачи и открытые вопросы
- В клиентских коммуникациях писать спокойно, понятно и без лишней внутренней кухни
- Если задача связана с CRM, проверять сущность: лид, сделка, задача, контакт, компания или комментарий
- Не менять статусы, ответственных и сроки без явной задачи пользователя
`
  },
  reports: {
    title: 'Отчёты',
    subtitle: 'Краткая выжимка для людей без погружения в детали',
    action: 'Добавить отчёты',
    impact: 'AI будет писать отчёты короче, понятнее и без лишней технической каши',
    risk: 'Безопасно, если в проекте часто нужны сводки',
    content: `## Формат отчётов

- Писать кратко, человеческим языком и без перегруза терминами
- Показывать только важные изменения, выводы и следующие действия
- Не перечислять однотипные правки по каждой сущности отдельно, если их можно объединить
- Указывать период, источник данных и ограничения, если они важны для понимания отчёта
`
  },
  operations: {
    title: 'Операционная работа',
    subtitle: 'Процессы, задачи, документы, контроль',
    action: 'Добавить процессы',
    impact: 'AI будет фиксировать этапы, риски, остаток работы и повторяемые процессы',
    risk: 'Безопасно для внутренних рабочих процессов',
    content: `## Операционная работа

- Фиксировать, что уже сделано, что осталось и где есть риск
- Для повторяющихся процессов давать короткий чеклист действий
- Не менять документы, таблицы, файлы и задачи без понятной причины
- Если действие затрагивает других людей, сначала показать, что именно будет изменено
`
  }
}

const EDITOR_HINTS = [
  {
    title: 'Паспорт проекта',
    text: 'Кто клиент или команда, чем занимается проект, какие ссылки, продукты и ограничения важны',
    insert: `## Паспорт проекта

- Проект:
- Клиент или команда:
- Что важно учитывать:
- Основные ссылки и системы:
- Ограничения:
`
  },
  {
    title: 'Поведение AI',
    text: 'Как отвечать, что проверять перед выводами, когда уточнять и когда просить подтверждение',
    insert: `## Поведение AI

- Перед выводами проверять:
- Если данных не хватает:
- Перед важными изменениями:
- Стиль работы:
`
  },
  {
    title: 'Формат результата',
    text: 'Как оформлять ответы, отчёты, планы, клиентские сообщения и технические разборы',
    insert: `## Формат результата

- Отвечать в формате:
- Уровень детализации:
- Что обязательно показывать:
- Что не писать:
`
  },
  {
    title: 'Запреты',
    text: 'Что нельзя менять, удалять, публиковать или делать без прямой команды пользователя',
    insert: `## Запреты

- Нельзя без подтверждения:
- Нельзя менять:
- Нельзя удалять:
- Нельзя публиковать или отправлять:
`
  }
]

const START_STEPS = [
  {
    title: 'Начни с основы',
    text: 'Если не знаешь, что выбрать, добавь “Базовый проект”. Это безопасная заготовка для любого проекта'
  },
  {
    title: 'Добавь специализацию',
    text: 'Если проект про рекламу, код, CRM, отчёты или процессы, добавь один или несколько подходящих блоков'
  },
  {
    title: 'Проверь предпросмотр',
    text: 'В блоке “Что получит AI” видно, какой текст будет добавляться к новым задачам'
  }
]

function formatRuleSize(size: number | null): string {
  if (size == null) return 'нет файла'
  if (size < 1024) return `${size} Б`
  return `${(size / 1024).toFixed(1)} КБ`
}

function pickEditableSource(status: UserLayerStatus | null): RuleSourceStatus | null {
  if (!status) return null
  return status.project.find(s => s.active && s.exists && !s.tooLarge)
    ?? status.project.find(s => s.id === DEFAULT_SOURCE_ID)
    ?? status.project[0]
    ?? null
}

function buildChecklist(content: string) {
  const text = content.toLowerCase()
  return [
    {
      ok: /о проекте|о клиенте|паспорт|клиент|проект|продукт|услуг/.test(text),
      title: 'Есть описание проекта',
      detail: 'AI понимает контекст бизнеса, продукта или рабочей среды'
    },
    {
      ok: /как ai должен работать|как работать|поведение|учитывать|проверять/.test(text),
      title: 'Есть правила работы',
      detail: 'Понятно, как действовать в этом проекте'
    },
    {
      ok: /формат|отч[её]т|ответ|структура|писать/.test(text),
      title: 'Есть формат ответа',
      detail: 'AI знает, как оформлять результат'
    },
    {
      ok: /нельзя|запрещено|без подтверждения|не удалять|не менять/.test(text),
      title: 'Есть ограничения',
      detail: 'Опасные действия явно отделены от обычной работы'
    },
    {
      ok: /источник|система|crm|директ|vk|telegram|авито|github|таблиц|метрик|api|файл|ссылка/.test(text),
      title: 'Есть источники данных',
      detail: 'Понятно, где брать факты и что можно подключать к задаче'
    }
  ]
}

function previewText(content: string): string {
  const trimmed = content.trim()
  if (!trimmed) {
    return 'Инструкции пока пустые. Добавь базовый шаблон или опиши правила проекта вручную'
  }
  if (trimmed.length <= 900) return trimmed
  return `${trimmed.slice(0, 900).trim()}…`
}

export function ProjectRulesView() {
  const projectPath = useProject(s => s.path)
  const [status, setStatus] = useState<UserLayerStatus | null>(null)
  const [sourceId, setSourceId] = useState(DEFAULT_SOURCE_ID)
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateId>('base')

  const editableSource = useMemo(() => {
    if (!status) return null
    return status.project.find(s => s.id === sourceId) ?? pickEditableSource(status)
  }, [sourceId, status])

  const activeProjectSource = useMemo(() => {
    if (!status) return null
    return status.project.find(s => s.active) ?? null
  }, [status])

  const checklist = useMemo(() => buildChecklist(content), [content])
  const readyCount = checklist.filter(item => item.ok).length
  const allSources = status ? [status.global, ...status.project] : []
  const dirty = content !== savedContent

  const loadStatus = useCallback(async () => {
    const s = await window.api.projectRules.status(projectPath)
    setStatus(s)
    const next = pickEditableSource(s)
    if (next) setSourceId(next.id)
    return { status: s, source: next }
  }, [projectPath])

  const readSource = useCallback(async (nextSourceId: string) => {
    if (!projectPath) {
      setContent('')
      setSavedContent('')
      return
    }
    const res = await window.api.projectRules.read(projectPath, nextSourceId)
    if (res.ok) {
      setContent(res.content)
      setSavedContent(res.content)
      setMessage(null)
    } else {
      setContent('')
      setSavedContent('')
      setMessage(res.error ?? 'Файл инструкций пока не создан')
    }
  }, [projectPath])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const { source } = await loadStatus()
      if (source) await readSource(source.id)
      else {
        setContent('')
        setSavedContent('')
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Не удалось загрузить инструкции проекта')
    } finally {
      setLoading(false)
    }
  }, [loadStatus, readSource])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function ensureRules() {
    if (!projectPath) return
    setBusy(true)
    setMessage(null)
    try {
      await window.api.projectRules.ensure(projectPath)
      const { source } = await loadStatus()
      const target = source?.id ?? DEFAULT_SOURCE_ID
      setSourceId(target)
      await readSource(target)
      setMessage('Инструкции готовы к редактированию')
    } finally {
      setBusy(false)
    }
  }

  async function saveRules() {
    if (!projectPath || !editableSource) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await window.api.projectRules.save(projectPath, editableSource.id, content)
      if (!res.ok) {
        setMessage(res.error ?? 'Не удалось сохранить инструкции')
        return
      }
      setSavedContent(content)
      await loadStatus()
      setMessage('Инструкции сохранены')
    } finally {
      setBusy(false)
    }
  }

  async function openSource(source: RuleSourceStatus) {
    const res = await window.api.projectRules.open(projectPath, source.id)
    if (!res.ok) setMessage(res.error ?? 'Не удалось открыть файл')
  }

  async function revealSource(source: RuleSourceStatus) {
    const res = await window.api.projectRules.reveal(projectPath, source.id)
    if (!res.ok) setMessage(res.error ?? 'Не удалось открыть папку')
  }

  async function selectSource(source: RuleSourceStatus) {
    if (source.scope !== 'project') return
    setSourceId(source.id)
    await readSource(source.id)
  }

  function applyTemplate(kind: TemplateId) {
    const tpl = TEMPLATE_BLOCKS[kind].content
    setContent(prev => prev.trim() ? `${prev.trim()}\n\n---\n\n${tpl}` : tpl)
  }

  function insertEditorHint(text: string) {
    setContent(prev => prev.trim() ? `${prev.trim()}\n\n${text}` : text)
  }

  if (!projectPath) {
    return (
      <div className="gg-panel gg-project-rules-view">
        <div className="gg-panel-empty" style={{ marginTop: 80 }}>Открой проект, чтобы настроить инструкции AI</div>
      </div>
    )
  }

  return (
    <div className="gg-panel gg-project-rules-view">
      <div className="gg-panel-header">
        <h2 className="gg-panel-title">Инструкции AI</h2>
        <div className="gg-panel-meta">
          Постоянный контекст проекта для любой работы: маркетинг, разработка, CRM, контент, аналитика, документы и внутренние процессы
        </div>
      </div>

      <section className="gg-rules-identity-card">
        <div className="gg-rules-identity-main">
          <div className="gg-rules-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M6 5.5h8.5L18 9v9.5H6z" />
              <path d="M14.5 5.5V9H18" />
              <path d="M8.5 12h7" />
              <path d="M8.5 15h5" />
            </svg>
          </div>
          <div>
            <div className="gg-rules-kicker">Центр поведения AI</div>
            <h3>Настрой, как AI должен работать именно здесь</h3>
            <p>
              Этот раздел не запускает задачу. Он сохраняет постоянные инструкции проекта, которые Verstak будет добавлять к новым сообщениям в этом проекте
            </p>
          </div>
        </div>
        <button className="gg-btn gg-btn-primary" type="button" disabled={busy} onClick={() => void ensureRules()}>
          {busy ? 'Готовлю…' : activeProjectSource ? 'Проверить файл' : 'Создать инструкции'}
        </button>
      </section>

      <section className="gg-rules-section-card gg-rules-onboarding">
        <div className="gg-rules-section-head">
          <div>
            <div className="gg-rules-kicker">Как начать</div>
            <h3>Безопасный сценарий для первого входа</h3>
          </div>
          <button type="button" className="gg-rules-outline-action" onClick={() => applyTemplate('base')}>
            Добавить рекомендуемую основу
          </button>
        </div>
        <div className="gg-rules-start-grid">
          {START_STEPS.map((step, index) => (
            <article className="gg-rules-start-card" key={step.title}>
              <span>{index + 1}</span>
              <div>
                <strong>{step.title}</strong>
                <p>{step.text}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="gg-rules-section-card">
        <div className="gg-rules-section-head">
          <div>
            <div className="gg-rules-kicker">Быстрый старт</div>
            <h3>Выбери готовый блок</h3>
          </div>
          <span className="gg-rules-muted">Сначала можно посмотреть текст, потом добавить его в рабочие инструкции</span>
        </div>
        <div className="gg-rules-template-grid">
          {(Object.keys(TEMPLATE_BLOCKS) as TemplateId[]).map(kind => {
            const template = TEMPLATE_BLOCKS[kind]
            return (
              <article className={`gg-rules-template-card ${selectedTemplate === kind ? 'is-selected' : ''}`} key={kind}>
                <div className="gg-rules-template-top">
                  <span>{template.title}</span>
                  {template.recommended && <mark>рекомендуется</mark>}
                </div>
                <small>{template.subtitle}</small>
                <div className="gg-rules-template-meta">
                  <p><strong>Влияние:</strong> {template.impact}</p>
                  <p><strong>Риск:</strong> {template.risk}</p>
                </div>
                <div className="gg-rules-template-actions">
                  <button type="button" className="gg-rules-outline-action" onClick={() => setSelectedTemplate(kind)}>
                    Посмотреть текст
                  </button>
                  <button type="button" className="gg-rules-outline-action is-primary" onClick={() => applyTemplate(kind)}>
                    {template.action}
                  </button>
                </div>
              </article>
            )
          })}
        </div>
        <div className="gg-rules-template-preview-card">
          <div className="gg-rules-section-head">
            <div>
              <div className="gg-rules-kicker">Предпросмотр шаблона</div>
              <h3>{TEMPLATE_BLOCKS[selectedTemplate].title}</h3>
            </div>
            <button type="button" className="gg-rules-outline-action is-primary" onClick={() => applyTemplate(selectedTemplate)}>
              {TEMPLATE_BLOCKS[selectedTemplate].action}
            </button>
          </div>
          <pre className="gg-rules-preview is-template">{TEMPLATE_BLOCKS[selectedTemplate].content.trim()}</pre>
        </div>
      </section>

      <section className="gg-rules-editor-card">
        <div className="gg-rules-editor-head">
          <div>
            <div className="gg-rules-kicker">Редактор</div>
            <h3>Рабочие инструкции</h3>
            <p>{editableSource ? `${editableSource.path} — всё, что написано в поле ниже, будет добавляться к новым задачам AI` : 'Файл будет создан в проекте'}</p>
          </div>
          <div className="gg-rules-editor-actions">
            <button type="button" className="gg-btn gg-btn-ghost" disabled={busy || loading} onClick={() => void refresh()}>
              Обновить
            </button>
            <button type="button" className="gg-btn gg-btn-primary" disabled={busy || !editableSource || !dirty} onClick={() => void saveRules()}>
              Сохранить
            </button>
          </div>
        </div>

        <div className="gg-rules-editor-help">
          <div className="gg-rules-editor-help-head">
            <div>
              <strong>Что сюда писать</strong>
              <span>Нажми “Добавить раздел”, и заготовка появится в рабочих инструкциях ниже</span>
            </div>
          </div>
          <div className="gg-rules-editor-hints">
            {EDITOR_HINTS.map(hint => (
              <article className="gg-rules-editor-hint" key={hint.title}>
                <div>
                  <strong>{hint.title}</strong>
                  <span>{hint.text}</span>
                </div>
                <button type="button" className="gg-rules-outline-action" onClick={() => insertEditorHint(hint.insert)}>
                  Добавить раздел
                </button>
              </article>
            ))}
          </div>
        </div>

        <div className="gg-rules-editor-label">
          <strong>Рабочий текст</strong>
          <span>Будет добавляться к новым задачам AI после сохранения</span>
        </div>
        <textarea
          className="gg-input gg-rules-editor-text"
          value={content}
          onChange={e => setContent(e.target.value)}
          placeholder="Опиши, как AI должен работать в этом проекте: что учитывать, какие источники смотреть, что запрещено, как оформлять ответы и когда спрашивать подтверждение"
          spellCheck={false}
        />
      </section>

      <div className="gg-rules-review-grid">
        <section className="gg-rules-section-card">
          <div className="gg-rules-section-head">
            <div>
              <div className="gg-rules-kicker">Проверка</div>
              <h3>Насколько инструкции готовы</h3>
            </div>
            <span className="gg-rules-score">{readyCount} из {checklist.length}</span>
          </div>
          <div className="gg-rules-check-list">
            {checklist.map(item => (
              <div className={`gg-rules-check ${item.ok ? 'is-ok' : 'is-missing'}`} key={item.title}>
                <span className="gg-rules-lamp" aria-hidden="true" />
                <div>
                  <strong>{item.title}</strong>
                  <small>{item.detail}</small>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="gg-rules-section-card">
          <div className="gg-rules-section-head">
            <div>
              <div className="gg-rules-kicker">Предпросмотр</div>
              <h3>Что получит AI</h3>
            </div>
            <span className="gg-rules-muted">{activeProjectSource ? 'будет добавлено к задаче' : 'после сохранения'}</span>
          </div>
          <pre className="gg-rules-preview">{previewText(content)}</pre>
        </section>
      </div>

      <section className="gg-rules-section-card">
        <div className="gg-rules-section-head">
          <div>
            <div className="gg-rules-kicker">Как это работает</div>
            <h3>Инструкции применяются автоматически</h3>
          </div>
        </div>
        <div className="gg-rules-flow">
          <div><span>1</span>Ты пишешь задачу в чате проекта</div>
          <div><span>2</span>Verstak добавляет сохранённые инструкции к контексту</div>
          <div><span>3</span>AI учитывает правила, скиллы, источники и ограничения</div>
        </div>
      </section>

      {message && <div className="gg-prov-toast is-ok" role="status">{message}</div>}

      <details className="gg-rules-advanced" open={advancedOpen} onToggle={e => setAdvancedOpen(e.currentTarget.open)}>
        <summary>Расширенные источники инструкций</summary>
        <div className="gg-settings-hint">
          Verstak может использовать глобальные правила и первый найденный файл проекта в порядке: <code>AGENTS.md</code>, <code>CLAUDE.md</code>, <code>GEMINI.md</code>, <code>.verstak/RULES.md</code>
        </div>
        <div className="gg-rules-list">
          {allSources.map(source => (
            <div key={source.id} className={`gg-rules-row ${source.active ? 'is-active' : ''}`}>
              <div className="gg-rules-row-main">
                <div className="gg-rules-row-title">
                  {source.label}
                  {source.active && <span className="gg-rules-badge is-active">активно</span>}
                  {source.tooLarge && <span className="gg-rules-badge is-warn">слишком большой</span>}
                </div>
                <div className="gg-rules-row-meta">
                  <code>{source.path}</code>
                  <span>{source.exists ? formatRuleSize(source.size) : 'не найден'}</span>
                </div>
              </div>
              <div className="gg-rules-row-actions">
                {source.scope === 'project' && (
                  <button type="button" className="gg-btn gg-btn-ghost" onClick={() => void selectSource(source)}>
                    Выбрать
                  </button>
                )}
                <button type="button" className="gg-btn gg-btn-ghost" disabled={!source.exists} onClick={() => void openSource(source)}>
                  Открыть
                </button>
                <button type="button" className="gg-btn gg-btn-ghost" onClick={() => void revealSource(source)}>
                  Папка
                </button>
              </div>
            </div>
          ))}
        </div>
      </details>
    </div>
  )
}
