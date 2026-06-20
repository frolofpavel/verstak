import { useEffect, useState } from 'react'

/**
 * Тумблер интенсивности — Простой / Турбо. Ось ОРТОГОНАЛЬНА режимам безопасности
 * (ModePicker): та про «сколько спрашивать», эта — про «сколько машинерии».
 *
 * Хранится в settings под ключом 'intensity'. Main читает его в ai:send через
 * getSecret('intensity') → intensityConfig: Турбо наслаивает <intensity>-подсказку
 * (рой/делегирование/глубокий контекст/LSP) + поднимает effort до deep; Простой =
 * прямой предсказуемый путь (сегодняшнее поведение). Самодостаточен: сам поллит
 * и пишет настройку.
 */

export type Intensity = 'simple' | 'turbo'

const META: Record<Intensity, { icon: string; label: string; title: string }> = {
  simple: { icon: '○', label: 'Простой', title: 'Простой: прямо и предсказуемо, экономно. Клик → Турбо.' },
  turbo: { icon: '🔥', label: 'Турбо', title: 'Турбо: вся машинерия под капотом — рой/делегирование, глубокий контекст, LSP, строгая проверка. Дороже. Клик → Простой.' }
}

export function IntensityToggle() {
  const [intensity, setIntensity] = useState<Intensity>('simple')

  useEffect(() => {
    void window.api.settings.getKey('intensity').then(v => setIntensity(v === 'turbo' ? 'turbo' : 'simple'))
  }, [])

  function flip() {
    const next: Intensity = intensity === 'turbo' ? 'simple' : 'turbo'
    setIntensity(next)
    void window.api.settings.setKey('intensity', next)
  }

  const m = META[intensity]
  return (
    <button
      type="button"
      className={`gg-intensity-pill is-${intensity}`}
      onClick={flip}
      title={m.title}
    >
      <span className="gg-intensity-icon">{m.icon}</span>
      <span className="gg-intensity-label">{m.label}</span>
    </button>
  )
}
