/**
 * Какой проект открыть на старте.
 *
 * Повод (враждебное ревью 2.6.4 §3): онбординг про проект не спрашивал, а после
 * кнопки «Начать работу» человек оказывался в проекте с корнем `C:\Users\<имя>` —
 * всей домашней папкой. Следствия замерены на стенде: агент получал корнем
 * `Documents`, `Desktop`, `Downloads`, `.ssh` и рабочие репозитории при 83
 * инструментах; открытие проекта ЗАПИСЫВАЛО туда `.verstak/MEMORY.md` и
 * `USER.md`, никого не спросив; панель «Мозг» проиндексировала 5055 файлов и
 * показала «ключевыми» чужие Azure-рецепты.
 *
 * Претензия была не в дыре (path-policy закрывает `.env`, `*.key`, `.ssh`), а в
 * том, что область работы выбрал не человек — и выбрал максимально широкую из
 * возможных. Поэтому домашнего каталога здесь нет вовсе: неизвестно, что
 * открывать → спрашиваем.
 */
export type StartupProject =
  | { kind: 'open'; path: string }
  /** Ничего не открываем — папку выбирает человек. */
  | { kind: 'ask' }

export function chooseStartupProject(input: {
  /** Проект прошлой сессии (`last_project_path`). */
  lastPath: string | null
  /** Пути известных проектов профиля. */
  knownPaths: string[]
}): StartupProject {
  const { lastPath, knownPaths } = input
  if (lastPath && knownPaths.includes(lastPath)) return { kind: 'open', path: lastPath }
  if (knownPaths.length > 0) return { kind: 'open', path: knownPaths[0] }
  return { kind: 'ask' }
}
