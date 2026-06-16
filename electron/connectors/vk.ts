/**
 * VK connector — данные сообществ и пользователей ВКонтакте.
 *
 * Своя реализация поверх официального VK API (метод в пути, параметры в query).
 * Зачем агентству: срез по сообществу клиента (подписчики, описание), выгрузка
 * постов со стены с метриками (лайки/репосты/просмотры/комментарии) для отчётов,
 * базовые данные пользователей (подписчики, город).
 *
 * Credentials (settings keys):
 *   vk_access_token — access token VK API (oauth/сервисный, иначе no-token).
 *
 * API:
 *   - Base: https://api.vk.com/method/{method}
 *     Auth — query-параметры на каждом запросе: access_token={token} и v=5.199.
 *     Ответ: { response: ... } ИЛИ { error: { error_code, error_msg } }.
 *
 * Операции (args.op):
 *   group_info — сообщество по group_id (groups.getById).
 *   wall_get   — посты со стены (wall.get), owner_id для группы отрицательный.
 *   users_get  — пользователи по user_ids через запятую (users.get).
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'

const API_BASE = 'https://api.vk.com/method'
const API_VERSION = '5.199'

function clampCount(raw: unknown, def = 10): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return def
  return Math.max(1, Math.min(100, Math.trunc(n)))
}

export function createVkConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'vk',
        label: 'VK',
        kind: 'vk',
        status: 'ready',
        detail: 'Сообщества, стена, пользователи ВКонтакте. Access token в settings (vk_access_token).'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const token = ctx.getSecret('vk_access_token')
      if (!token) {
        return {
          error: 'no-token',
          message: 'VK access token не настроен. Settings → коннектор VK → access token. ' +
                   'Получить: oauth/сервисный токен сообщества или приложения VK.'
        }
      }
      try {
        switch (op) {
          case 'group_info': return await groupInfo(token, args, ctx)
          case 'wall_get':   return await wallGet(token, args, ctx)
          case 'users_get':  return await usersGet(token, args, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно: group_info, wall_get, users_get.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function groupInfo(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const groupId = String(args.group_id ?? '').trim()
  if (!groupId) return { error: 'bad-args', message: 'group_info требует group_id — id или короткое имя сообщества.' }
  const json = await call('groups.getById', token, {
    group_id: groupId,
    fields: 'members_count,description,activity'
  }, ctx)
  // Аудит M17: с VK API v5.199 groups.getById отдаёт { groups: [...] }, а не
  // голый массив. Поддерживаем оба формата, иначе любой валидный id → «не найдено».
  const arr = Array.isArray(json)
    ? json
    : (json && Array.isArray((json as { groups?: unknown[] }).groups) ? (json as { groups: unknown[] }).groups : [])
  const group = (arr[0] ?? null) as Record<string, any> | null
  if (!group) return { found: false, message: `Сообщество «${groupId}» не найдено.` }
  return formatGroup(group)
}

async function wallGet(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const ownerId = String(args.owner_id ?? '').trim()
  if (!ownerId) {
    return {
      error: 'bad-args',
      message: 'wall_get требует owner_id. Для сообщества id отрицательный (например -1 для VK Team).'
    }
  }
  const json = await call('wall.get', token, {
    owner_id: ownerId,
    count: String(clampCount(args.count))
  }, ctx) as { items?: Array<Record<string, any>> }
  const posts = (json.items ?? []).map(formatPost)
  return { count: posts.length, posts }
}

async function usersGet(token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const userIds = String(args.user_ids ?? '').trim()
  if (!userIds) return { error: 'bad-args', message: 'users_get требует user_ids — id/screen_name через запятую.' }
  const json = await call('users.get', token, {
    user_ids: userIds,
    fields: 'followers_count,city'
  }, ctx) as Array<Record<string, any>>
  const users = (Array.isArray(json) ? json : []).map(formatUser)
  return { count: users.length, users }
}

// ----------------------------------------------------------------- helpers

/** Вызов VK-метода: метод в пути, токен/версия/params — в query.
 *  Возвращает содержимое response. На { error } — бросает Error. */
async function call(
  method: string,
  token: string,
  params: Record<string, string>,
  ctx: ConnectorContext
): Promise<unknown> {
  const search = new URLSearchParams({ ...params, access_token: token, v: API_VERSION })
  const res = await fetch(`${API_BASE}/${method}?${search}`, {
    headers: { 'Accept': 'application/json' },
    signal: ctx.signal
  })
  const text = await res.text()
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? ' (проверь vk_access_token)' : ''
    throw new Error(`VK ${res.status}${hint}: ${text.slice(0, 300)}`)
  }
  let json: unknown
  try { json = JSON.parse(text) } catch { throw new Error('VK вернул не-JSON ответ') }
  const obj = json as { response?: unknown; error?: { error_code?: number; error_msg?: string } }
  if (obj.error) {
    throw new Error(`VK error ${obj.error.error_code ?? '?'}: ${obj.error.error_msg ?? 'unknown'}`)
  }
  return obj.response
}

// Извлекаем только нужные поля — компактный предсказуемый ответ вместо
// громоздкого VK-объекта (защита контекста + удобство для модели).

function formatGroup(g: Record<string, any>): unknown {
  return {
    id: g.id ?? null,
    name: g.name ?? null,
    screen_name: g.screen_name ?? null,
    members_count: g.members_count ?? null,
    description: g.description ?? null,
    activity: g.activity ?? null
  }
}

function formatPost(p: Record<string, any>): unknown {
  return {
    id: p.id ?? null,
    date: p.date ?? null,
    text: p.text ?? '',
    likes: p.likes?.count ?? null,
    reposts: p.reposts?.count ?? null,
    views: p.views?.count ?? null,
    comments: p.comments?.count ?? null
  }
}

function formatUser(u: Record<string, any>): unknown {
  return {
    id: u.id ?? null,
    first_name: u.first_name ?? null,
    last_name: u.last_name ?? null,
    followers_count: u.followers_count ?? null,
    city: u.city?.title ?? null
  }
}
