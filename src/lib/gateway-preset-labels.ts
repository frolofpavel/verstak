// Русские метки пресетов Verstak Gateway для ПИКЕРА (renderer). В API уходит id
// (verstak/...), пользователю в списке моделей показываем человекочитаемое.
//
// ЭТО НЕ ЗЕРКАЛО electron/ai/extra-providers.ts → GATEWAY_PRESET_LABELS. Наборы
// сознательно РАСХОДЯТСЯ: renderer-варианты информативнее (напр. «Эконом · DeepSeek»
// против main «Эконом»). Единственное жёсткое требование к этой карте — у КАЖДОГО
// gateway-пресета есть метка, иначе в пикере покажется сырой id (страж —
// tests/lib/gateway-preset-labels.test.ts сверяет с EXTRA_PROVIDERS).
export const GATEWAY_PRESET_LABELS: Record<string, string> = {
  'kimi-k2.7-code': 'Kimi K2.7 Code',
  'deepseek-chat': 'DeepSeek Chat',
  'qwen3-coder': 'Qwen3 Coder',
  'verstak/free': '🎁 Бесплатно — проба', // значение дословно из main-копии (устранение расхождения, не новый текст)
  'verstak/economy': 'Эконом · DeepSeek',
  'verstak/balanced': 'Баланс · Kimi',
  'verstak/coder': 'Кодинг · Kimi',
  'verstak/long': 'Длинный контекст',
  'verstak/fast': 'Быстро · DeepSeek',
  'verstak/private': 'Приватно',
}

/** Короткая метка модели для пикера: пресет gateway → русская метка, датированный
 *  id → без даты, иначе сырой id. */
export function shortModel(m: string): string {
  if (m === 'auto') return 'auto'
  if (GATEWAY_PRESET_LABELS[m]) return GATEWAY_PRESET_LABELS[m]
  const dateMatch = m.match(/(.*)-\d{8}$/)
  if (dateMatch) return dateMatch[1]
  return m
}
