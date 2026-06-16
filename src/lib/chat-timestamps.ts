const DAY_MS = 86_400_000

export function startOfLocalDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function isSameLocalDay(a: number | undefined, b: number | undefined): boolean {
  if (a == null || b == null) return a === b
  return startOfLocalDay(a) === startOfLocalDay(b)
}

export function formatMessageClock(ts: number): string {
  const d = new Date(ts)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

export function formatMessageDateTitle(ts: number): string {
  return new Date(ts).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** «15 июня» — для разделителя в ленте чата. */
export function formatChatDateDivider(ts: number): string {
  const now = new Date()
  const d = new Date(ts)
  const todayStart = startOfLocalDay(now.getTime())
  const msgStart = startOfLocalDay(ts)
  if (msgStart === todayStart) return 'Сегодня'
  if (msgStart === todayStart - DAY_MS) return 'Вчера'
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}