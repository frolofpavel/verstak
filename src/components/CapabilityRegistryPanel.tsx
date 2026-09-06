/**
 * Реестр возможностей — единый паспорт скиллов, MCP-серверов, коннекторов и
 * ролей агента.
 *
 * Живёт вкладкой на экране «Скиллы», а не отдельным пунктом меню: в боковой
 * панели уже семнадцать пунктов, и восемнадцатый ухудшил бы её сильнее, чем
 * помог бы реестр.
 */
import { useEffect, useMemo, useState } from 'react'
import type { Capability, CapabilityType } from '../../shared/contracts/capability'

const TYPE_LABEL: Record<CapabilityType, string> = {
  agent: 'Роль',
  skill: 'Скилл',
  mcp: 'MCP',
  connector: 'Коннектор',
}

const RISK_LABEL: Record<Capability['riskTier'], string> = {
  low: 'низкий',
  medium: 'средний',
  high: 'высокий',
}

/** Что уровень доверия РЕАЛЬНО разрешает. Человек должен читать смысл, а не код. */
const TRUST_LABEL: Record<Capability['trustLevel'], string> = {
  T0: 'T0 · песочница',
  T1: 'T1 · только чтение',
  T2: 'T2 · запись с подтверждением',
  T3: 'T3 · выполнение в рамках политики',
  T4: 'T4 · самостоятельно в пределах бюджета',
}

const STATUS_LABEL: Record<Capability['status'], string> = {
  ready: 'готов',
  'needs-config': 'нужна настройка',
  error: 'ошибка',
  disabled: 'выключен',
}

type TypeFilter = 'all' | CapabilityType

export function CapabilityRegistryPanel() {
  const [items, setItems] = useState<Capability[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  const [reason, setReason] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.capabilities
      .list()
      .then(list => { if (alive) setItems(list) })
      // Пустой реестр и несобравшийся реестр — разные вещи, и путать их нельзя:
      // «ничего не подключено» человек прочитал бы как норму.
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!openId) { setReason(null); return }
    let alive = true
    void window.api.capabilities.reason(openId).then(r => { if (alive) setReason(r) }).catch(() => {})
    return () => { alive = false }
  }, [openId])

  const counts = useMemo(() => {
    const by = new Map<CapabilityType, number>()
    for (const c of items ?? []) by.set(c.type, (by.get(c.type) ?? 0) + 1)
    return by
  }, [items])

  const listed = useMemo(
    () => (items ?? []).filter(c => typeFilter === 'all' || c.type === typeFilter),
    [items, typeFilter]
  )

  if (failed) return <div className="gg-skills-empty">Реестр не собрался. Открой журнал — причина там.</div>
  if (items === null) return <div className="gg-skills-empty">Собираю реестр…</div>

  return (
    <div className="gg-capabilities">
      <div className="gg-skills-chips" role="tablist">
        {(['all', 'skill', 'mcp', 'connector', 'agent'] as const).map(key => (
          <button
            key={key}
            type="button"
            className={`gg-skills-chip ${typeFilter === key ? 'is-on' : ''}`}
            onClick={() => setTypeFilter(key)}
          >
            {key === 'all' ? `Все ${items.length}` : `${TYPE_LABEL[key]} ${counts.get(key) ?? 0}`}
          </button>
        ))}
      </div>

      {listed.length === 0 ? (
        <div className="gg-skills-empty">Возможностей этого типа не подключено.</div>
      ) : (
        <div className="gg-skills-list">
          {listed.map(c => (
            <div key={c.id} className={`gg-cap-row${openId === c.id ? ' is-selected' : ''}`}>
              <button
                type="button"
                className="gg-cap-row-main"
                onClick={() => setOpenId(openId === c.id ? null : c.id)}
                title="Показать паспорт целиком"
              >
                <span className="gg-cap-type">{TYPE_LABEL[c.type]}</span>
                <span className="gg-cap-name">{c.name}</span>
                <span className="gg-cap-owner">{c.owner}</span>
                <span className={`gg-cap-risk is-${c.riskTier}`}>риск {RISK_LABEL[c.riskTier]}</span>
                <span className="gg-cap-trust">{TRUST_LABEL[c.trustLevel]}</span>
                <span className={`gg-cap-status is-${c.status}`}>{STATUS_LABEL[c.status]}</span>
              </button>

              {openId === c.id && (
                <dl className="gg-cap-details">
                  <dt>Происхождение</dt><dd>{c.source}</dd>
                  <dt>Версия</dt><dd><code>{c.version}</code></dd>
                  <dt>Инструменты</dt>
                  <dd>{c.allowedTools === null ? 'не ограничены этим слоем' : c.allowedTools.join(', ') || 'нет'}</dd>
                  <dt>Зависимости</dt>
                  <dd>{c.dependencies.length ? c.dependencies.join(', ') : 'нет'}</dd>
                  <dt>Проверка</dt>
                  <dd>
                    {c.evalScore === null
                      ? 'не проверялась'
                      : `оценка ${c.evalScore.toFixed(2)}${c.lastVerifiedAt ? `, ${new Date(c.lastVerifiedAt).toLocaleDateString('ru-RU')}` : ''}`}
                  </dd>
                  <dt>Основание уровня</dt>
                  <dd>{reason ?? 'доверие по умолчанию — ничем ещё не подтверждено'}</dd>
                </dl>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
