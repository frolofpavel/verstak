// Ранний маршрутный стоп Computer Use приходит из main машинным кодом
// (`COMPUTER_USE_AUTHORIZATION_FAILED: <code>`): main не знает язык интерфейса, а
// сам код — контракт, который стережёт tests/ai/computer/runner-wiring. Человеку
// код не говорит ничего: живой тупик 19.09 — блокировка снималась кнопкой в
// настройках, а в чате стояло `uncertain-reconciliation-required`. Перевод живёт
// здесь, на границе показа, и незнакомый код отдаёт сообщение как есть.

const AUTHORIZATION_PREFIX = 'COMPUTER_USE_AUTHORIZATION_FAILED: '

export function computerUseStopCode(message: string): string | null {
  if (!message.startsWith(AUTHORIZATION_PREFIX)) return null
  const code = message.slice(AUTHORIZATION_PREFIX.length).trim()
  return code.length > 0 ? code : null
}

export function describeComputerUseStop(
  message: string,
  reasons: Readonly<Record<string, string>>,
): string {
  const code = computerUseStopCode(message)
  if (code == null) return message
  return reasons[code] ?? message
}
