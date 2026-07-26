/**
 * SSH-live (Вариант B): файловые операции на удалённом сервере как shell-команды,
 * которые передаются в `ssh host "<cmd>"`. Здесь только ЧИСТОЕ построение команд
 * (+ shell-quoting) — сам запуск ssh переиспользует ssh-коннектор.
 *
 * Запись идёт через stdin: `cat > 'path'`, контент пишется в stdin процесса ssh,
 * чтобы любой контент (кавычки/юникод/бинарь) пережил без экранирования в argv.
 */

/** Bash single-quote: внутри '…' одинарная кавычка экранируется как '\''. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/** Родительский каталог remote-пути (для mkdir -p перед записью). */
export function remoteDirname(path: string): string {
  const p = path.replace(/\/+$/, '')
  const i = p.lastIndexOf('/')
  if (i < 0) return '.'
  return i === 0 ? '/' : p.slice(0, i)
}

/** Прочитать файл: `cat -- <path>`. stdout = содержимое. */
export function buildReadCmd(remotePath: string): string {
  return `cat -- ${shq(remotePath)}`
}

/** Записать файл (контент в stdin): создаём каталог + перезаписываем. */
export function buildWriteCmd(remotePath: string): string {
  return `mkdir -p ${shq(remoteDirname(remotePath))} && cat > ${shq(remotePath)}`
}

/** Список каталога машинно-читаемо: имя + тип (d/f) на строку. */
export function buildListCmd(remotePath: string): string {
  // `-p` добавляет «/» к каталогам — отличаем файлы от папок без stat.
  return `ls -1Ap -- ${shq(remotePath)}`
}


/** Разобрать вывод buildListCmd в записи дерева (имя + isDirectory). */
export function parseListOutput(stdout: string): Array<{ name: string; isDirectory: boolean }> {
  return stdout
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && l !== './' && l !== '../')
    .map(l => l.endsWith('/')
      ? { name: l.slice(0, -1), isDirectory: true }
      : { name: l, isDirectory: false })
}
