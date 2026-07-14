import { projectAvatarLetterStyle } from '../lib/project-avatar'
import { projectIconSrc } from '../lib/project-icon'
import type { ProjectMeta } from '../types/api'

function initial(name: string): string {
  const trimmed = name.trim()
  return trimmed ? trimmed.charAt(0).toUpperCase() : '·'
}

export function ProjectAvatar({
  project,
  className = 'gg-rail-square',
  size
}: {
  project: Pick<ProjectMeta, 'name' | 'color' | 'iconPath'> & { accentColor?: string | null }
  className?: string
  size?: number
}) {
  const iconSrc = projectIconSrc(project.iconPath)
  const color = project.accentColor || project.color
  const style = iconSrc
    ? size
      ? { width: size, height: size }
      : undefined
    : projectAvatarLetterStyle(color, size)

  if (iconSrc) {
    return (
      <img
        src={iconSrc}
        alt=""
        className={`${className} gg-project-avatar-img`}
        style={style}
        draggable={false}
      />
    )
  }

  return (
    <span className={className} style={style} aria-hidden>
      {initial(project.name)}
    </span>
  )
}
