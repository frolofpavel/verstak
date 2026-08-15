import { join } from 'path'
import { nativeFsPromises } from './native-fs'

/**
 * Проверка «приложение сейчас запущено из этой папки» ДО первой записи.
 *
 * Повод (враждебное ревью 2.6.4 §1): человек ставит новую версию поверх
 * работающей — ровно так, как учит сайт. Копирование упирается в залоченный
 * `d3dcompiler_47.dll`, установка падает, и «откат» доламывает то, что ещё
 * работало. Проверки запуска не было вовсе.
 *
 * Механика: Windows держит образ работающего .exe/.dll открытым БЕЗ
 * FILE_SHARE_WRITE, поэтому открыть такой файл на запись нельзя —
 * ERROR_SHARING_VIOLATION, который Node отдаёт как EBUSY/EPERM/EACCES.
 * Это точнее, чем `tasklist`: отвечает не «жив ли где-то Verstak вообще»,
 * а «жива ли ИМЕННО эта установка» — установка в другую папку при живом
 * приложении остаётся разрешённой.
 */

/** Что показал зонд по одному файлу. */
export type LockState = 'free' | 'locked' | 'missing'

export type LockProbe = (absPath: string) => Promise<LockState>

/** Файлы, которые Windows держит замапленными всё время жизни приложения. */
export const LOCK_SENTINELS = [
  'Verstak.exe',
  'd3dcompiler_47.dll',
  'libEGL.dll',
  'ffmpeg.dll',
]

/** Текст отказа — человеку, а не стек Node.js на экране выбора папки. */
export const RUNNING_INSTALL_MESSAGE =
  'Verstak сейчас запущен из этой папки. Закройте приложение и запустите установку снова. ' +
  'Ничего не изменено — рабочая версия на месте.'

export const probeLock: LockProbe = async (absPath) => {
  let handle
  try {
    handle = await nativeFsPromises.open(absPath, 'r+')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return 'missing'
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return 'locked'
    // Незнакомая ошибка — не выдаём за «запущено», иначе установка встанет
    // на ровном месте и человек не сможет ничего сделать.
    return 'free'
  }
  await handle.close().catch(() => {})
  return 'free'
}

/**
 * true — в `installDir` стоит копия, которая прямо сейчас работает.
 * Отсутствие файлов (чистая папка, первая установка) — не «запущено».
 */
export async function detectRunningInstall(
  installDir: string,
  probe: LockProbe = probeLock,
): Promise<boolean> {
  for (const name of LOCK_SENTINELS) {
    if (await probe(join(installDir, name)) === 'locked') return true
  }
  return false
}
