/**
 * Привести project-relative путь (как его отдают tool-события: `./src/foo.ts`,
 * `src\foo.ts`) к абсолютному внутри projectRoot. Сепаратор берём по корню
 * (Windows `\` vs posix `/`). Пуре, без fs.
 */
export function toProjectAbsPath(projectRoot: string, rel: string): string {
  const clean = rel.replace(/^\.[\\/]/, '')
  const sep = projectRoot.includes('\\') ? '\\' : '/'
  return `${projectRoot}${sep}${clean.replace(/[\\/]/g, sep)}`
}
