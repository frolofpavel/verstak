import { isWithinKnownRoots } from '../ai/path-policy'
import { isForbiddenPath } from '../ai/secret-scanner'
import type { ConnectorContext } from './types'

// Гейт локального чтения для коннекторов, читающих файл по пути ИЗ АРГУМЕНТОВ МОДЕЛИ
// (Этап 1а, блок №6; отчёт docs/headless-core-recon-2026-08-04.md §4 п.6).
//
// На десктопе это терпимо: путь называет пользователь своей машины. На общем сервере
// тот же код — примитив чтения произвольного файла С ОТПРАВКОЙ НАРУЖУ (в Telegram, на
// Я.Диск), то есть готовый канал эксфильтрации после prompt-injection.
//
// Гейт обязан стоять ДО первого сетевого вызова операции: отказ после ensureDir/upload
// означает, что путь наружу уже открыт.

export interface LocalReadDenied {
  error: 'forbidden-path'
  message: string
}

/**
 * Проверяет, можно ли коннектору прочитать локальный файл. Возвращает объект-ошибку
 * (форма, принятая у коннекторов) либо null, если чтение разрешено.
 */
export function checkLocalRead(path: string, ctx: ConnectorContext): LocalReadDenied | null {
  if (!path) return null
  // Секрето-файлы запрещены всегда — и на сервере, и на десктопе: ни один сценарий
  // «отправь мой файл» не оправдывает отправку .env или приватного ключа вовне.
  if (isForbiddenPath(path)) {
    return {
      error: 'forbidden-path',
      message: 'Файл выглядит как хранилище секретов (.env / *.key / creds*.json) — отправка наружу заблокирована.'
    }
  }
  const roots = ctx.allowedReadRoots
  if (!roots || roots.length === 0) return null
  // isWithinKnownRoots резолвит realpath → symlink изнутри корня наружу не проходит.
  if (!isWithinKnownRoots(path, roots)) {
    return {
      error: 'forbidden-path',
      message: 'Путь вне разрешённых корней задачи — чтение локальных файлов ограничено workspace.'
    }
  }
  return null
}
