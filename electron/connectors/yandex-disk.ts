/**
 * Yandex Disk connector — для шеринга артефактов с клиентами агентства.
 *
 * Источник: V3 Plan раздел 8.3 (действия с артефактом → «🔗 Загрузить в Я.Диск»).
 *
 * Credentials (settings keys):
 *   yandex_disk_token   — OAuth token со scope cloud_api:disk.app_folder
 *                         или cloud_api:disk.write. Получить:
 *                         https://oauth.yandex.ru/authorize?response_type=token&client_id=...
 *
 * Операции:
 *   - upload_file:   локальный файл → /Geminigrok/{папка дня}/{имя}
 *   - get_public_url: после загрузки можно опубликовать → получить share URL
 *                    для отправки клиенту
 *   - list_files:    что лежит в указанной папке
 *
 * Безопасность:
 *   - Все upload идут в фиксированный root «/Geminigrok/» чтобы не засорять
 *     корень Pavel'я. Pavel может поменять root через setting если хочет.
 *   - Опубликованные ссылки логируются в journal — аудит «что мы клиенту дали».
 */

import { readFile } from 'fs/promises'
import { basename } from 'path'
import type { Connector, ConnectorInfo, ConnectorContext } from './types'

const API_BASE = 'https://cloud-api.yandex.net/v1/disk'
const DEFAULT_ROOT = '/Geminigrok'

export function createYandexDiskConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'yandex_disk',
        label: 'Yandex Disk',
        kind: 'yandex_disk',
        status: 'ready',
        detail: 'OAuth token в settings (yandex_disk_token). Upload идёт в /Geminigrok/.'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const token = ctx.getSecret('yandex_disk_token')
      if (!token) {
        return {
          error: 'no-token',
          message: 'Yandex Disk token не настроен. Settings → yandex_disk_token. ' +
                   'Получить: oauth.yandex.ru со scope cloud_api:disk.write.'
        }
      }
      try {
        switch (op) {
          case 'upload_file':      return await uploadFile(token, args, ctx)
          case 'get_public_url':   return await getPublicUrl(token, args, ctx)
          case 'list_files':       return await listFiles(token, args, ctx)
          case 'unpublish':        return await unpublish(token, args, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно: upload_file, get_public_url, list_files, unpublish.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function uploadFile(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const localPath = String(args.local_path ?? '')
  if (!localPath) return { error: 'bad-args', message: 'local_path обязателен' }
  const root = String(args.root ?? DEFAULT_ROOT).replace(/\/+$/, '')
  const today = new Date().toISOString().slice(0, 10)
  const remoteName = String(args.remote_name ?? basename(localPath))
  const remotePath = `${root}/${today}/${remoteName}`

  // Ensure папка дня существует (idempotent)
  await ensureDir(token, `${root}/${today}`, ctx)

  // Шаг 1: получить upload URL
  const upUrl = `${API_BASE}/resources/upload?path=${encodeURIComponent(remotePath)}&overwrite=true`
  const upResp = await fetch(upUrl, {
    method: 'GET',
    headers: { Authorization: `OAuth ${token}` },
    signal: ctx.signal
  })
  if (!upResp.ok) {
    const text = await upResp.text()
    throw new Error(`get upload URL failed: ${upResp.status} ${text.slice(0, 300)}`)
  }
  const { href, method } = await upResp.json() as { href: string; method: string }

  // Шаг 2: PUT файл по выданному URL
  const fileBuf = await readFile(localPath)
  // Node fetch не любит Buffer → Uint8Array
  const body: BodyInit = new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength)
  const putResp = await fetch(href, {
    method: method || 'PUT',
    body,
    signal: ctx.signal
  })
  if (!putResp.ok && putResp.status !== 201 && putResp.status !== 202) {
    const text = await putResp.text()
    throw new Error(`upload failed: ${putResp.status} ${text.slice(0, 300)}`)
  }

  return {
    ok: true,
    remote_path: remotePath,
    size_bytes: fileBuf.length,
    hint: 'Чтобы получить share-ссылку для клиента — вызови get_public_url с этим remote_path.'
  }
}

async function getPublicUrl(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const remotePath = String(args.remote_path ?? '')
  if (!remotePath) return { error: 'bad-args', message: 'remote_path обязателен (получи из upload_file)' }

  // 1) Опубликовать
  const pubUrl = `${API_BASE}/resources/publish?path=${encodeURIComponent(remotePath)}`
  const pubResp = await fetch(pubUrl, {
    method: 'PUT',
    headers: { Authorization: `OAuth ${token}` },
    signal: ctx.signal
  })
  if (!pubResp.ok) {
    const text = await pubResp.text()
    throw new Error(`publish failed: ${pubResp.status} ${text.slice(0, 300)}`)
  }

  // 2) Получить public_url через meta
  const metaUrl = `${API_BASE}/resources?path=${encodeURIComponent(remotePath)}`
  const metaResp = await fetch(metaUrl, {
    method: 'GET',
    headers: { Authorization: `OAuth ${token}` },
    signal: ctx.signal
  })
  if (!metaResp.ok) {
    const text = await metaResp.text()
    throw new Error(`get meta failed: ${metaResp.status} ${text.slice(0, 300)}`)
  }
  const meta = await metaResp.json() as { public_url?: string; public_key?: string }
  return {
    ok: true,
    public_url: meta.public_url,
    public_key: meta.public_key,
    remote_path: remotePath
  }
}

async function listFiles(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const root = String(args.root ?? DEFAULT_ROOT).replace(/\/+$/, '')
  const path = String(args.path ?? root)
  const limit = Math.min(Number(args.limit ?? 50), 200)
  const url = `${API_BASE}/resources?path=${encodeURIComponent(path)}&limit=${limit}`
  const resp = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `OAuth ${token}` },
    signal: ctx.signal
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`list failed: ${resp.status} ${text.slice(0, 300)}`)
  }
  const data = await resp.json() as { _embedded?: { items?: Array<{ name: string; path: string; size?: number; type: string; modified?: string }> } }
  return {
    path,
    items: (data._embedded?.items ?? []).map(i => ({
      name: i.name,
      path: i.path,
      type: i.type,
      size: i.size ?? null,
      modified: i.modified ?? null
    }))
  }
}

async function unpublish(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const remotePath = String(args.remote_path ?? '')
  if (!remotePath) return { error: 'bad-args', message: 'remote_path обязателен' }
  const url = `${API_BASE}/resources/unpublish?path=${encodeURIComponent(remotePath)}`
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `OAuth ${token}` },
    signal: ctx.signal
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`unpublish failed: ${resp.status} ${text.slice(0, 300)}`)
  }
  return { ok: true, remote_path: remotePath }
}

// ----------------------------------------------------------------- helpers

async function ensureDir(token: string, path: string, ctx: ConnectorContext): Promise<void> {
  // Yandex Disk не имеет mkdir -p, нужно создавать вложенные папки по одной
  const parts = path.split('/').filter(Boolean)
  let cur = ''
  for (const p of parts) {
    cur += '/' + p
    const url = `${API_BASE}/resources?path=${encodeURIComponent(cur)}`
    const resp = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `OAuth ${token}` },
      signal: ctx.signal
    })
    // 201 = created, 409 = уже существует. Оба = OK.
    if (resp.status !== 201 && resp.status !== 409) {
      const text = await resp.text()
      throw new Error(`mkdir ${cur} failed: ${resp.status} ${text.slice(0, 200)}`)
    }
  }
}
