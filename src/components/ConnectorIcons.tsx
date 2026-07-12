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
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.6" y="3" width="12.8" height="12" rx="3" />
      <text x="9" y="11.45" textAnchor="middle" fill="currentColor" stroke="none" fontSize="6.2" fontWeight="700" fontFamily="Inter, Arial, sans-serif">1C</text>
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
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.6" y="2.6" width="12.8" height="12.8" rx="3.2" />
      <path d="M5.1 7.35c.38-.82 1.1-1.22 2.05-1.22 1.12 0 1.82.58 1.82 1.43 0 .62-.34 1.08-1.08 1.62L5.3 11.25h3.72" />
      <path d="M12.75 11.28V6.23L10.15 9.7h3.48" />
    </svg>
  )
}

export function IconYandexDirect({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.6" y="2.8" width="12.8" height="12.4" rx="3.1" />
      <path d="M5.1 12.7 12.9 4.9" strokeWidth="2.35" />
      <path d="M9.25 4.9h3.65v3.65" strokeWidth="2.35" />
    </svg>
  )
}

export function IconYandexDisk({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5.1 13.8h7.4a3.2 3.2 0 0 0 .35-6.38A4.35 4.35 0 0 0 4.5 8.5a2.68 2.68 0 0 0 .6 5.3Z" />
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

export function IconDaData({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.4" y="3" width="10.7" height="12" rx="2" />
      <circle cx="6.2" cy="7" r="1.15" />
      <path d="M4.75 10.45c.4-.9 1.05-1.35 1.95-1.35s1.55.45 1.95 1.35" />
      <path d="M9.9 6.5h1.25M9.9 9h1.25" />
      <circle cx="13.15" cy="12.55" r="2.25" />
      <path d="M14.8 14.2 16 15.4" />
    </svg>
  )
}

export function IconYandexMetrika({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="2.5" width="13" height="13" rx="3" />
      <path d="M5 12.5 7.2 9.7l2.1 1.5 3.7-5.1" />
      <circle cx="13" cy="6.1" r="1.15" fill="currentColor" stroke="none" />
      <path d="M5 13.7h8.5" opacity=".55" />
    </svg>
  )
}

export function IconAvito({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6.1" cy="6.1" r="2.1" />
      <circle cx="11.9" cy="6.1" r="1.65" opacity=".72" />
      <circle cx="5.95" cy="12" r="1.65" opacity=".72" />
      <circle cx="12.05" cy="12.05" r="2.1" />
    </svg>
  )
}

export function IconYandexWebmaster({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.4" y="3.2" width="13.2" height="10.4" rx="2" />
      <path d="M5.2 10.25 7.2 12l4.8-5.5" />
      <path d="M6.2 15h5.6" />
    </svg>
  )
}

export function IconYandexWordstat({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7.6" cy="7.4" r="4" />
      <path d="M10.5 10.35 15 14.8" />
      <path d="M5.8 8.8V6.7M7.8 8.8V5.4M9.8 8.8V7.45" opacity=".72" />
    </svg>
  )
}

export function IconOzon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="4" width="13" height="10.5" rx="2.4" />
      <path d="M5.4 7.9h7.2M5.4 10.7h7.2" />
      <circle cx="6.15" cy="12.8" r=".55" fill="currentColor" stroke="none" />
      <circle cx="11.85" cy="12.8" r=".55" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconWildberries({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.6" y="3.2" width="12.8" height="11.6" rx="3" />
      <path d="M4.8 6.4 6.15 12l2.1-4.25L10.35 12l1.35-5.6" />
      <path d="M12.6 6.4c.65 1.05.65 2.05 0 3" opacity=".55" />
    </svg>
  )
}

export function IconYooKassa({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.4" y="5" width="13.2" height="9.2" rx="2" />
      <path d="M4 5.2 11.3 3.4c.9-.22 1.45.18 1.55 1.05L13 5" />
      <circle cx="12.7" cy="9.6" r="1.15" />
    </svg>
  )
}

export function IconVK({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.3" y="3.2" width="13.4" height="11.6" rx="3.2" />
      <path d="M5.2 7.1c.65 2.25 1.85 4 3.45 4.45V7.2" />
      <path d="M12.9 7.1c-.45.95-1.05 1.8-1.8 2.55.75.55 1.35 1.2 1.8 1.95" />
    </svg>
  )
}

export function IconAmoCrm({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.2 4.5h11.6l-4.4 4.8v3.55L7.6 14V9.3L3.2 4.5Z" />
      <path d="M5.25 4.5c.8-1 2.05-1.5 3.75-1.5s2.95.5 3.75 1.5" opacity=".55" />
    </svg>
  )
}

export function IconMoySklad({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.2 7.1 9 3.9l5.8 3.2v6.05L9 16.1l-5.8-2.95V7.1Z" />
      <path d="M3.5 7.25 9 10.3l5.5-3.05M9 10.3v5.45" />
      <path d="M6.2 5.55 12 8.7" opacity=".55" />
    </svg>
  )
}

export function IconYandexTracker({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="2.6" width="12" height="12.8" rx="2" />
      <path d="M6 6.2h6M6 9h6M6 11.8h3.5" />
      <path d="M4.8 6.2h.05M4.8 9h.05M4.8 11.8h.05" />
    </svg>
  )
}

export function IconSendPulse({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="4.2" width="13" height="9.6" rx="2" />
      <path d="M3.4 5.3 9 9.2l5.6-3.9" />
      <path d="M5.1 11h2l.9-2.1 1.25 3.2 1.05-2.1h2.6" />
    </svg>
  )
}

export function IconUniSender({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6.4h7.4a2 2 0 0 1 2 2v3.2a2 2 0 0 1-2 2H3V6.4Z" />
      <path d="M3.6 7.2 7 10l3.4-2.8" />
      <path d="M13.2 6.2c.9.65 1.35 1.58 1.35 2.8s-.45 2.15-1.35 2.8M15 4.5c1.25 1.08 1.88 2.58 1.88 4.5S16.25 12.42 15 13.5" opacity=".55" />
    </svg>
  )
}

export function IconGA4({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="9.2" width="2.6" height="5.2" rx="1.1" />
      <rect x="7.7" y="5.7" width="2.6" height="8.7" rx="1.1" />
      <rect x="12.4" y="3.2" width="2.6" height="11.2" rx="1.1" />
      <circle cx="4.3" cy="4.2" r="1.15" />
    </svg>
  )
}

export function IconNotion({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4.1 6.1 3h8.25v11.25L11.2 15H3V4.1Z" />
      <path d="M6.1 3v11.1L3 15" opacity=".55" />
      <path d="M8.1 11.7V6.4l3.8 5.3V6.4" />
    </svg>
  )
}

export function IconKonturFocus({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="9" r="5.7" />
      <circle cx="9" cy="9" r="2.1" />
      <path d="M9 1.8v2M9 14.2v2M1.8 9h2M14.2 9h2" />
      <path d="M7.1 14.3h3.8" opacity=".55" />
    </svg>
  )
}

export function IconMpstats({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.6" y="3.2" width="12.8" height="11.6" rx="2.4" />
      <path d="M5 12.2V8.4M9 12.2V5.8M13 12.2v-2.5" />
      <path d="M4.6 13.4h8.8" opacity=".55" />
    </svg>
  )
}

export function IconOzonPerformance({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.3 12.6 6.4 9.5l2.3 1.85 4.9-5.65" />
      <path d="M10.5 5.7h3.1v3.1" />
      <rect x="3" y="3.4" width="12" height="11.2" rx="2.4" opacity=".55" />
    </svg>
  )
}

export function IconJira({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 2.8 15.2 9 9 15.2 2.8 9 9 2.8Z" />
      <path d="M6.25 9 9 6.25 11.75 9 9 11.75 6.25 9Z" opacity=".65" />
    </svg>
  )
}

export function IconTrello({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.6" y="2.8" width="12.8" height="12.4" rx="2.5" />
      <rect x="5" y="5.1" width="2.7" height="6.2" rx=".8" />
      <rect x="10.3" y="5.1" width="2.7" height="4.2" rx=".8" />
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
