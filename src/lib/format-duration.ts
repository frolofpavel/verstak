/** Человекочитаемая длительность для UI чата и инспектора. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} мс`
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec} с`
  const min = Math.floor(sec / 60)
  const rem = sec % 60
  return rem > 0 ? `${min} м ${rem} с` : `${min} м`
}