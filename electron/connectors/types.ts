/**
 * Connectors framework — pluggable adapters for external systems.
 *
 * A connector is a named service that lives outside the project filesystem
 * (a SaaS API, an internal database, a vendor system like 1C). The AI can
 * `list_connectors`, `connector_query` over them inside the conversation;
 * the user manages credentials and which connectors are enabled in Settings.
 *
 * Design notes:
 * - Credentials never leave the main process. Adapters get a `getSecret`
 *   callback so they can fetch their auth material on demand.
 * - All network IO goes through Node's fetch with a strict timeout.
 * - Responses are size-capped before being returned to the AI to avoid
 *   blowing the context window.
 * - The secret scanner is applied to every response before it leaves the
 *   adapter — even adapters can't accidentally leak a token.
 */

import { scanText } from '../ai/secret-scanner'

export interface ConnectorInfo {
  id: string
  label: string
  /** Stable kind identifier (one of the built-in adapters). */
  kind: string
  /**
   * Готовность источника. ВАЖНО: сам адаптер этот флаг не вычисляет — у `info()`
   * нет доступа к хранилищу. Честный статус проставляет реестр, сверяя `requires`
   * / `requiresAnyOf` с настройками (см. `registry.ts`). Адаптер объявляет
   * 'ready' как «код готов», реестр превращает это в «и ключи на месте».
   */
  status: 'ready' | 'needs-config' | 'error'
  detail?: string
  /**
   * Ключи настроек, без которых источник работать не может — ВСЕ обязательны.
   * Пусто = источнику хранилище не нужно (например SSH: хост можно передать
   * прямо в аргументах).
   */
  requires?: string[]
  /** Ключи, из которых достаточно ЛЮБОГО одного (несколько каналов/эндпоинтов). */
  requiresAnyOf?: string[]
}

export interface ConnectorContext {
  /** Read a secret from the encrypted settings store. */
  getSecret: (key: string) => string | null
  /** Get the abort signal so a long-running query can be cancelled. */
  signal: AbortSignal
}

export interface Connector {
  info(): ConnectorInfo
  /** Generic free-form query. Each adapter interprets the args its own way. */
  query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown>
}

const MAX_BODY_BYTES = 256 * 1024  // 256 KB cap before redaction + return

/**
 * Read a fetch Response body with a size cap, then run secret-scanner on it.
 * Returns the scanned string. Never throws — failures become annotated text.
 */
export async function readBodyWithLimit(res: Response): Promise<string> {
  try {
    const reader = res.body?.getReader()
    if (!reader) return await res.text().then(t => scanText(t).redacted).catch(() => '')
    let received = 0
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > MAX_BODY_BYTES) {
        try { await reader.cancel() } catch { /* already done */ }
        chunks.push(value)
        break
      }
      chunks.push(value)
    }
    const buf = Buffer.concat(chunks.map(c => Buffer.from(c)))
    const text = buf.toString('utf8').slice(0, MAX_BODY_BYTES)
    const scan = scanText(text)
    const suffix = received > MAX_BODY_BYTES ? '\n…[truncated]' : ''
    return scan.hits.length > 0
      ? `[secret-scanner: redacted ${scan.hits.join(', ')}]\n${scan.redacted}${suffix}`
      : scan.redacted + suffix
  } catch (err) {
    return `[read error: ${err instanceof Error ? err.message : String(err)}]`
  }
}
