import { useState } from 'react'
import { useProviderCatalog } from '../../hooks/useProviderCatalog'
import { useProject } from '../../store/projectStore'
import type { PromptRouteOverride } from '../../types/api'

// Срез 2.0.7-F: маршрут модели на ОДИН запрос. Не меняет дефолт чата (one-shot —
// snap'ается после отправки и при переключении чата, см. projectStore). fallbackPolicy
// по умолчанию strict: пользователь выбрал модель осознанно, молча уезжать на другого
// провайдера нельзя ('allow' возвращает прежний smart-fallback + видимое route-событие).
//
// Логика (catalog/one-shot/strict) покрыта тестами; визуальная приёмка контрола — за
// Павлом на собранной 2.0.7 (Electron не рендерю).

export function PromptRouteControl() {
  const { providers } = useProviderCatalog()
  const override = useProject(s => s.promptRouteOverride)
  const setOverride = useProject(s => s.setPromptRouteOverride)
  const [open, setOpen] = useState(false)

  // Активный override — компактный чип с моделью и режимом fallback + сброс.
  if (override) {
    return (
      <span className="gg-prompt-route is-active" title="Маршрут только для следующего запроса">
        🎯 {override.model}
        <button
          type="button"
          className="gg-prompt-route-policy"
          title={override.fallbackPolicy === 'strict'
            ? 'Строго: при сбое не переезжать на другого провайдера'
            : 'Разрешить запасного провайдера при сбое'}
          onClick={() => setOverride({ ...override, fallbackPolicy: override.fallbackPolicy === 'strict' ? 'allow' : 'strict' })}
        >
          {override.fallbackPolicy === 'strict' ? 'строго' : 'с запасным'}
        </button>
        <button type="button" className="gg-prompt-route-clear" title="Сбросить (вернуть модель чата)" onClick={() => setOverride(null)}>✕</button>
      </span>
    )
  }

  if (!open) {
    return (
      <button type="button" className="gg-prompt-route-trigger" title="Выбрать модель только для следующего запроса" onClick={() => setOpen(true)}>
        🎯 модель на 1 запрос
      </button>
    )
  }

  // Пикер: провайдер → модель. Explicit route по умолчанию strict.
  function apply(providerId: string, model: string) {
    if (!model) return
    setOverride({ providerId: providerId as PromptRouteOverride['providerId'], model, fallbackPolicy: 'strict' })
    setOpen(false)
  }

  return (
    <span className="gg-prompt-route-picker">
      <select
        className="gg-input gg-prompt-route-select"
        defaultValue=""
        onChange={e => {
          const [pid, model] = e.target.value.split('::')
          if (pid && model) apply(pid, model)
        }}
      >
        <option value="" disabled>модель на 1 запрос…</option>
        {providers.map(p => (
          <optgroup key={p.id} label={p.name}>
            {p.models.map(m => (
              <option key={`${p.id}::${m}`} value={`${p.id}::${m}`}>{m}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <button type="button" className="gg-prompt-route-clear" title="Отмена" onClick={() => setOpen(false)}>✕</button>
    </span>
  )
}
