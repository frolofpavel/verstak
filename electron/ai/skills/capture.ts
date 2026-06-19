/**
 * Skill Capture (Hermes-lite, controlled) — превращает успешный прогон в скилл.
 * Чистый генератор markdown скилла из метаданных прогона; запись на диск и
 * human-approve — в IPC/UI. Захваченный скилл — это СКАФФОЛД: человек правит и
 * подтверждает перед использованием (по дизайну «save run as skill + approve»).
 */

/** id скилла из заголовка: ascii-slug (для имени файла и slash). Кириллица
 *  отбрасывается → fallback 'captured-skill' (IPC дедупит коллизии). */
export function deriveSkillId(title: string): string {
  const ascii = (title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\x00-\x7f]/g, '')        // отбросить не-ascii (кириллицу)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
    .slice(0, 32)
  return ascii || 'captured-skill'
}

export interface CaptureSkillInput {
  /** Заголовок/задача прогона. */
  title: string
  /** Краткое summary прогона (что было сделано) — в описание + тело. */
  summary?: string
  /** Инструменты, замеченные в прогоне → tools_allow. */
  toolsAllow?: string[]
  /** ISO-дата захвата (передаётся снаружи — для детерминизма/тестов). */
  capturedAt: string
  /** Явный id (иначе из title). IPC передаёт дедуплицированный. */
  id?: string
}

/** Собрать markdown скилла (frontmatter + тело). Чистая, без side-effects. */
export function buildCapturedSkill(input: CaptureSkillInput): { id: string; filename: string; markdown: string } {
  const id = (input.id && input.id.trim()) || deriveSkillId(input.title)
  const name = (input.title ?? '').trim().slice(0, 60) || 'Захваченный скилл'
  const summary = (input.summary ?? '').trim()
  const description = (summary.slice(0, 140)) || `Скилл, захваченный из успешного прогона: ${name}`
  const tools = (input.toolsAllow ?? []).filter(Boolean)

  const fm = [
    '---',
    `id: ${id}`,
    `name: ${name}`,
    `description: ${description}`,
    'icon: ⭐',
    `slash: ${id}`,
    ...(tools.length ? ['tools_allow:', ...tools.map(t => `  - ${t}`)] : []),
    '---',
  ].join('\n')

  const body = [
    `Ты — скилл «${name}», захваченный из успешного прогона (${input.capturedAt}).`,
    '',
    '## Что делает',
    summary || '(опиши задачу, под которую этот скилл — поправь перед использованием)',
    '',
    '## Подход',
    'Воспроизведи успешный подход прошлого прогона: действуй по шагам, проверяй результат после изменений, не расширяй scope без необходимости.',
  ].join('\n')

  return { id, filename: `${id}.md`, markdown: `${fm}\n\n${body}\n` }
}
