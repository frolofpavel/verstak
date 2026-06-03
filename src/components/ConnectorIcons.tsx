// Inline SVG icons for connectors — monochrome, currentColor, 18×18

interface IconProps {
  size?: number
}

export function IconClaude({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="9" r="7" />
      <path d="M6 9c0-1.66 1.34-3 3-3s3 1.34 3 3-1.34 3-3 3" />
      <circle cx="9" cy="9" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function Icon1C({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="14" height="14" rx="2" />
      <path d="M6 13V7l-1.5 1.5" strokeLinecap="round" />
      <path d="M9.5 13h3M9.5 7h3M11 7v6" />
    </svg>
  )
}

export function IconGoogleSheets({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="14" height="14" rx="1.5" />
      <line x1="2" y1="7" x2="16" y2="7" />
      <line x1="2" y1="11" x2="16" y2="11" />
      <line x1="7" y1="2" x2="7" y2="16" />
      <line x1="11" y1="2" x2="11" y2="16" />
    </svg>
  )
}

export function IconTelegram({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 9l13-6-5 14-3-5-5-3z" />
      <path d="M10 7l-3 5" />
    </svg>
  )
}

export function IconSSH({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="14" height="12" rx="1.5" />
      <path d="M5 8l2.5 2.5L5 13" />
      <line x1="10" y1="13" x2="13" y2="13" />
    </svg>
  )
}

export function IconBitrix({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 13c0 1.1.9 2 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v8z" />
      <path d="M6 7h3.5a1.5 1.5 0 0 1 0 3H6v3" />
      <path d="M6 7v3" />
    </svg>
  )
}

export function IconYandexDirect({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="10" width="3" height="5" rx="0.5" />
      <rect x="7.5" y="7" width="3" height="8" rx="0.5" />
      <rect x="12" y="3" width="3" height="12" rx="0.5" />
    </svg>
  )
}

export function IconYandexDisk({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 12a4 4 0 0 0-1-7.87A5 5 0 0 0 3 9a3 3 0 1 0 1 5.83" />
      <polyline points="9 12 9 16" />
      <polyline points="7 14 9 16 11 14" />
    </svg>
  )
}

export function IconSkillsServer({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 2l1.8 3.6L15 6.3l-3 2.9.7 4.1L9 11.3l-3.7 1.9.7-4.1-3-2.9 4.2-.7L9 2z" />
    </svg>
  )
}

export function IconHTTP({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="9" r="7" />
      <line x1="2" y1="9" x2="16" y2="9" />
      <path d="M9 2a11.5 11.5 0 0 1 3 7 11.5 11.5 0 0 1-3 7 11.5 11.5 0 0 1-3-7 11.5 11.5 0 0 1 3-7z" />
    </svg>
  )
}

export function IconGitHub({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="currentColor">
      <path d="M9 1C4.58 1 1 4.58 1 9c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0017 9c0-4.42-3.58-8-8-8z"/>
    </svg>
  )
}

export function IconSocialPublish({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12c0 .55.45 1 1 1h10c.55 0 1-.45 1-1V6c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v6z" />
      <path d="M7 9l2.5-2 2.5 2" />
      <line x1="9.5" y1="7" x2="9.5" y2="13" />
    </svg>
  )
}

export function IconPlug({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2v4M12 2v4" />
      <path d="M5 6h8a1 1 0 0 1 1 1v2a5 5 0 0 1-10 0V7a1 1 0 0 1 1-1z" />
      <line x1="9" y1="13" x2="9" y2="16" />
    </svg>
  )
}
