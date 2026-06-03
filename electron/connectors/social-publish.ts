/**
 * Social Publish connector — постинг текста в Telegram-каналы, VK-группу, webhook.
 *
 * Операции: publish_text, list_channels.
 *
 * Credentials (settings keys):
 *   telegram_bot_token              — переиспользуем ключ от telegram-коннектора
 *   social_publish_telegram_channels — JSON array chat_id'ов (строки)
 *   social_publish_vk_token          — VK API user token (scope: wall)
 *   social_publish_vk_group_id       — числовой ID группы (без знака минус)
 *   social_publish_webhooks          — JSON array URL'ов для generic webhook
 *
 * Безопасность:
 *   - Все тексты проходят secret-scanner перед отправкой.
 *   - Credentials читаются через getSecret — AI их никогда не видит.
 */

import type { Connector, ConnectorInfo, ConnectorContext } from './types'
import { scanText } from '../ai/secret-scanner'

const TG_API = 'https://api.telegram.org'
const VK_API = 'https://api.vk.com/method'
const VK_VERSION = '5.199'

export function createSocialPublishConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'social-publish',
        label: 'Social Publish',
        kind: 'social-publish',
        status: 'ready',
        detail: 'Постинг в Telegram-каналы, VK-группу, generic webhooks'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')

      try {
        switch (op) {
          case 'publish_text':  return await publishText(args, ctx)
          case 'list_channels': return listChannels(ctx)
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная операция «${op}». Доступно: publish_text, list_channels.`
            }
        }
      } catch (err) {
        return {
          error: 'request-failed',
          message: err instanceof Error ? err.message : String(err),
          op
        }
      }
    }
  }
}

// ─── операции ────────────────────────────────────────────────────────────────

async function publishText(
  args: Record<string, unknown>,
  ctx: ConnectorContext
): Promise<unknown> {
  const rawText = String(args.text ?? '')
  if (!rawText) return { error: 'bad-args', message: 'publish_text требует поле text' }

  // Прогоняем через secret-scanner: модель могла случайно вставить токен
  const scan = scanText(rawText)
  const safeText = scan.hits.length > 0
    ? `[social-publish: redacted ${scan.hits.join(', ')}]\n${scan.redacted}`
    : rawText

  // Если platforms не передан — публикуем во всё что настроено
  const requestedPlatforms = Array.isArray(args.platforms)
    ? (args.platforms as unknown[]).map(String)
    : null // null = все настроенные

  const results: Record<string, { ok: boolean; error?: string }> = {}

  // Telegram
  const tgToken = ctx.getSecret('telegram_bot_token')
  const tgChannelsRaw = ctx.getSecret('social_publish_telegram_channels')
  const tgChannels = parseSocialJsonArray(tgChannelsRaw)
  if (tgToken && tgChannels.length > 0 && wantsPlatform(requestedPlatforms, 'telegram')) {
    for (const chatId of tgChannels) {
      const key = `telegram:${chatId}`
      try {
        await tgSendMessage(tgToken, chatId, safeText, ctx.signal)
        results[key] = { ok: true }
      } catch (err) {
        results[key] = { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  }

  // VK
  const vkToken = ctx.getSecret('social_publish_vk_token')
  const vkGroupId = ctx.getSecret('social_publish_vk_group_id')
  if (vkToken && vkGroupId && wantsPlatform(requestedPlatforms, 'vk')) {
    try {
      await vkWallPost(vkToken, vkGroupId, safeText, ctx.signal)
      results['vk'] = { ok: true }
    } catch (err) {
      results['vk'] = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // Generic webhooks
  const webhooksRaw = ctx.getSecret('social_publish_webhooks')
  const webhooks = parseSocialJsonArray(webhooksRaw)
  if (webhooks.length > 0 && wantsPlatform(requestedPlatforms, 'webhook')) {
    for (const url of webhooks) {
      const key = `webhook:${url.slice(0, 40)}`
      try {
        await webhookPost(url, { text: safeText, timestamp: Date.now() }, ctx.signal)
        results[key] = { ok: true }
      } catch (err) {
        results[key] = { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  }

  if (Object.keys(results).length === 0) {
    return {
      error: 'not-configured',
      message: 'Ни один канал не настроен. Задай telegram/vk/webhooks в Settings → Social Publish.'
    }
  }

  return results
}

function listChannels(ctx: ConnectorContext): unknown {
  const tgChannels = parseSocialJsonArray(ctx.getSecret('social_publish_telegram_channels'))
  const vkGroupId = ctx.getSecret('social_publish_vk_group_id')
  const webhooks = parseSocialJsonArray(ctx.getSecret('social_publish_webhooks'))
  return {
    telegram: tgChannels,
    vk: vkGroupId ? [vkGroupId] : [],
    webhooks: webhooks.length
  }
}

// ─── HTTP-хелперы ─────────────────────────────────────────────────────────────

async function tgSendMessage(
  token: string,
  chatId: string,
  text: string,
  signal: AbortSignal
): Promise<void> {
  const url = `${TG_API}/bot${token}/sendMessage`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal
  })
  const json = await res.json() as { ok: boolean; description?: string; error_code?: number }
  if (!json.ok) {
    throw new Error(`Telegram sendMessage failed: ${json.error_code} ${json.description}`)
  }
}

async function vkWallPost(
  token: string,
  groupId: string,
  text: string,
  signal: AbortSignal
): Promise<void> {
  // owner_id для группы = отрицательный ID
  const params = new URLSearchParams({
    owner_id: `-${groupId}`,
    message: text,
    access_token: token,
    v: VK_VERSION
  })
  const url = `${VK_API}/wall.post?${params.toString()}`
  const res = await fetch(url, { method: 'POST', signal })
  const json = await res.json() as { response?: { post_id: number }; error?: { error_msg: string; error_code: number } }
  if (json.error) {
    throw new Error(`VK wall.post error ${json.error.error_code}: ${json.error.error_msg}`)
  }
}

async function webhookPost(
  url: string,
  payload: Record<string, unknown>,
  signal: AbortSignal
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal
  })
  if (!res.ok) {
    throw new Error(`Webhook POST failed: ${res.status} ${res.statusText}`)
  }
}

// ─── утилиты ─────────────────────────────────────────────────────────────────

/** Парсит JSON array из settings-строки. Ошибки — тихо, возвращает []. */
function parseSocialJsonArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.map(String)
  } catch {
    return []
  }
}

/** null → хотим всё что настроено; иначе проверяем вхождение. */
function wantsPlatform(platforms: string[] | null, name: string): boolean {
  return platforms === null || platforms.includes(name)
}
