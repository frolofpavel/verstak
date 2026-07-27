// Вкладка «Поведение агента» — пять рантайм-флагов, которые до 27.07 жили только
// в БД и не были видны человеку.
//
// Почему вкладка, а не тумблер рядом с памятью: флаги решаются РАЗОМ. Отдельный UI
// только для памяти был бы непоследователен — это записано в аудите ещё при
// закрытии 2.1.13.
//
// Значения пишутся в те же настройки, откуда их читает main (`settings:set-key` →
// `settings.setSecret`, main читает `getSecret` живьём на каждом прогоне, без кеша),
// поэтому переключение действует со следующего сообщения — перезапуск не нужен.
//
// Полярность флагов разная и объявлена в src/lib/runtime-flags.ts; здесь её не
// дублируем. Соответствие с main стережёт tests/lib/runtime-flags.test.ts.

import { useCallback, useEffect, useState } from 'react'
import {
  RUNTIME_FLAGS,
  isRuntimeFlagOn,
  runtimeFlagValue,
  type RuntimeFlagKey,
} from '../lib/runtime-flags'

type FlagState = Partial<Record<RuntimeFlagKey, boolean>>

export function RuntimeFlagsTab() {
  const [state, setState] = useState<FlagState>({})
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const entries = await Promise.all(RUNTIME_FLAGS.map(async f => {
          const stored = await window.api.settings.getKey(f.key)
          return [f.key, isRuntimeFlagOn(f, stored)] as const
        }))
        if (!cancelled) {
          setState(Object.fromEntries(entries) as FlagState)
          setLoaded(true)
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Не удалось прочитать настройки.')
          setLoaded(true)
        }
      }
    })()
    return () => { cancelled = true }
  }, [])

  const toggle = useCallback(async (key: RuntimeFlagKey, next: boolean) => {
    // Оптимистично: тумблер должен отзываться сразу. При ошибке возвращаем назад,
    // иначе UI покажет состояние, которого в настройках нет.
    setState(prev => ({ ...prev, [key]: next }))
    setError(null)
    try {
      await window.api.settings.setKey(key, runtimeFlagValue(next))
    } catch (cause) {
      setState(prev => ({ ...prev, [key]: !next }))
      setError(cause instanceof Error ? cause.message : 'Не удалось сохранить настройку.')
    }
  }, [])

  return (
    <div className="gg-settings-extra gg-runtime-flags">
      <div className="gg-settings-section-title">Поведение агента</div>
      <div className="gg-settings-hint">
        Переключение действует со следующего сообщения — перезапускать приложение не нужно.
      </div>
      {error && <div className="gg-settings-hint is-error">{error}</div>}
      <div className="gg-runtime-flags-list">
        {RUNTIME_FLAGS.map(f => {
          const on = state[f.key] ?? f.defaultOn
          return (
            <div key={f.key} className="gg-runtime-flag-row" data-flag={f.key}>
              <div className="gg-runtime-flag-copy">
                <div className="gg-runtime-flag-title">
                  {f.title}
                  {!f.defaultOn && (
                    <span className="gg-runtime-flag-tag" title="По умолчанию выключено — включается осознанно">
                      по умолчанию выключено
                    </span>
                  )}
                </div>
                <div className="gg-runtime-flag-what">{f.what}</div>
                <div className="gg-runtime-flag-off">Если выключить: {f.whenOff}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={f.title}
                className={`gg-toggle ${on ? 'is-on' : ''}`}
                disabled={!loaded}
                onClick={() => void toggle(f.key, !on)}
                title={on ? 'Выключить' : 'Включить'}
              >
                <span className="gg-toggle-knob" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
