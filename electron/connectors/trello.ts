/**
 * Trello connector — доски, списки, карточки (Trello REST API).
 *
 * Своя реализация поверх официального Trello REST API v1. Чужой код не
 * используется — только публично документированные GET-эндпоинты (read-only).
 *
 * Зачем агентству: задачи клиентов и внутренние процессы часто ведутся в Trello —
 * быстрый срез досок/списков/карточек прямо из чата без переключения в браузер.
 *
 * Credentials (settings keys):
 *   trello_api_key — API key приложения (trello.com/app-key).
 *   trello_token   — token авторизации (там же, кнопка Token). Нужны ОБА.
 *
 * API:
 *   Base: https://api.trello.com/1
 *   Auth: query-параметры ?key={api_key}&token={token} на каждом запросе.
 *
 * Операции (args.op):
 *   list_boards — доски текущего члена (/members/me/boards).
 *   list_lists  — списки доски (board_id обязателен).
 *   list_cards  — карточки списка (list_id обязателен).
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'

const API = 'https://api.trello.com/1'

export function createTrelloConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'trello',
        label: 'Trello',
        kind: 'trello',
        requires: ['trello_api_key', 'trello_token'],
        status: 'ready',
        detail: 'Доски, списки, карточки. API key + token в settings (trello_api_key / trello_token).'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const apiKey = ctx.getSecret('trello_api_key')
      const token = ctx.getSecret('trello_token')
      if (!apiKey || !token) {
        return {
          error: 'no-credentials',
          message: 'Trello API key/token не настроены. Settings → Trello. ' +
                   'Получить: trello.com/app-key (key + кнопка Token).'
        }
      }
      try {
        switch (op) {
          case 'list_boards': return await listBoards(apiKey, token, ctx)
          case 'list_lists':  return await listLists(apiKey, token, args, ctx)
          case 'list_cards':  return await listCards(apiKey, token, args, ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op «${op}». Доступно: list_boards, list_lists, list_cards.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

async function listBoards(apiKey: string, token: string, ctx: ConnectorContext): Promise<unknown> {
  const params = auth(apiKey, token, { fields: 'name,url,closed' })
  const json = await get(`${API}/members/me/boards?${params}`, ctx) as Array<Record<string, any>>
  const boards = (Array.isArray(json) ? json : []).map(formatBoard)
  return { count: boards.length, boards }
}

async function listLists(apiKey: string, token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const boardId = String(args.board_id ?? '').trim()
  if (!boardId) return { error: 'bad-args', message: 'list_lists требует board_id (id доски из list_boards).' }
  const params = auth(apiKey, token)
  const json = await get(`${API}/boards/${encodeURIComponent(boardId)}/lists?${params}`, ctx) as Array<Record<string, any>>
  const lists = (Array.isArray(json) ? json : []).map(formatList)
  return { count: lists.length, lists }
}

async function listCards(apiKey: string, token: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const listId = String(args.list_id ?? '').trim()
  if (!listId) return { error: 'bad-args', message: 'list_cards требует list_id (id списка из list_lists).' }
  const params = auth(apiKey, token)
  const json = await get(`${API}/lists/${encodeURIComponent(listId)}/cards?${params}`, ctx) as Array<Record<string, any>>
  const cards = (Array.isArray(json) ? json : []).map(formatCard)
  return { count: cards.length, cards }
}

// ----------------------------------------------------------------- helpers

function auth(apiKey: string, token: string, extra?: Record<string, string>): URLSearchParams {
  return new URLSearchParams({ key: apiKey, token, ...(extra ?? {}) })
}

async function get(url: string, ctx: ConnectorContext): Promise<unknown> {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: ctx.signal })
  const text = await res.text()
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? ' (проверь trello_api_key / trello_token)'
      : res.status === 429 ? ' (превышен лимит запросов Trello)' : ''
    throw new Error(`Trello ${res.status}${hint}: ${text.slice(0, 300)}`)
  }
  try { return JSON.parse(text) } catch { throw new Error('Trello вернул не-JSON ответ') }
}

// Извлекаем только нужные плоские поля — компактный предсказуемый ответ
// вместо громоздкого объекта Trello (защита контекста + удобство для модели).

function formatBoard(b: Record<string, any>): unknown {
  return {
    id: b.id ?? null,
    name: b.name ?? null,
    url: b.url ?? null,
    closed: b.closed ?? null
  }
}

function formatList(l: Record<string, any>): unknown {
  return {
    id: l.id ?? null,
    name: l.name ?? null
  }
}

function formatCard(c: Record<string, any>): unknown {
  return {
    id: c.id ?? null,
    name: c.name ?? null,
    due: c.due ?? null,
    closed: c.closed ?? null,
    idMembers: c.idMembers ?? []
  }
}
