import type { CSSProperties } from 'react'

/**
 * Стили буквенных аватарок — переключатель AVATAR_LETTER_STYLE:
 *
 * | Ключ       | Как выглядит |
 * |------------|--------------|
 * | original   | Яркая плоская заливка project.color, буква чёрная |
 * | variant1   | Приглушённый hue per-path (color-mix 20%), Nord-палитра |
 * | unified    | Один цвет из темы Verstak (текущий) |
 */
export type AvatarLetterStyle = 'original' | 'variant1' | 'unified'

/** Активный стиль отрисовки буквенных аватарок. */
export const AVATAR_LETTER_STYLE: AvatarLetterStyle = 'unified'

/** variant1 — Nord-палитра для per-path оттенка (19.06.2026). */
export const VARIANT1_PROJECT_AVATAR_PALETTE = [
  '#5e81ac',
  '#81a1c1',
  '#88c0d0',
  '#8fbcbb',
  '#a3be8c',
  '#b48ead',
  '#d08770',
  '#4c566a'
] as const

/** Палитра для записи color в БД (новые проекты). При unified на отрисовку не влияет. */
export const PROJECT_AVATAR_PALETTE = VARIANT1_PROJECT_AVATAR_PALETTE

function pickFromPalette(path: string, palette: readonly string[]): string {
  let hash = 0
  for (let i = 0; i < path.length; i++) hash = (hash * 31 + path.charCodeAt(i)) | 0
  return palette[Math.abs(hash) % palette.length]
}

/** Stable per-path tint in DB (для variant1/original при переключении стиля). */
export function pickProjectColor(path: string): string {
  return pickFromPalette(path, PROJECT_AVATAR_PALETTE)
}

function withSize(style: CSSProperties, size?: number): CSSProperties {
  if (!size) return style
  return { ...style, width: size, height: size }
}

/** original — яркая заливка project.color. */
export function projectAvatarLetterStyleOriginal(color: string, size?: number): CSSProperties {
  return withSize({
    background: color,
    color: 'rgba(0, 0, 0, 0.82)'
  }, size)
}

/** variant1 — приглушённый per-path hue. */
export function projectAvatarLetterStyleVariant1(color: string, size?: number): CSSProperties {
  return withSize({
    '--avatar-tint': color,
    background: `color-mix(in srgb, ${color} 20%, var(--bg-overlay))`,
    color: 'var(--text-secondary)'
  } as CSSProperties & { '--avatar-tint'?: string }, size)
}

/** unified — один цвет shell, без различия по проектам. */
export function projectAvatarLetterStyleUnified(size?: number): CSSProperties {
  return withSize({
    background: 'color-mix(in srgb, var(--bg-elevated) 55%, var(--bg-overlay))',
    color: 'var(--text-secondary)',
    borderColor: 'var(--border-default)'
  }, size)
}

/** Активный стиль буквенного аватара. */
export function projectAvatarLetterStyle(color: string, size?: number): CSSProperties {
  switch (AVATAR_LETTER_STYLE) {
    case 'original':
      return projectAvatarLetterStyleOriginal(color, size)
    case 'variant1':
      return projectAvatarLetterStyleVariant1(color, size)
    case 'unified':
      return projectAvatarLetterStyleUnified(size)
  }
}
