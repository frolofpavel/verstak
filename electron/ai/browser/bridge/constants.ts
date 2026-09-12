// constants.ts — стабильные идентификаторы Connected Eyes (EXT-B1).
//
// Extension ID вычислен из публичного RSA-ключа (manifest.key). Приватный ключ
// в репозиторий НЕ входит. Смена key ломает allowed_origins и HKCU — только
// осознанно, с миграцией.

/** Chrome extension id = first 128 bits of sha256(SPKI) encoded a-p. */
export const EXTENSION_ID = 'jbhddmgcngdchlgmilphmbbcccfigadb'

/** Публичный SPKI (base64) — единственный key в manifest.json. */
export const EXTENSION_PUBLIC_KEY_B64 =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoQwehRHbRAo1R/m4zqMkD2tXkp0GaAvw1c01Peqc2Biv4YaI+knqjuWUCjo8tFzMozKcIbzzlWk/OtfntnEdVJYkY5kKqzrZvd8pUyTJ/yhhiPxH7U7AqqDsaEpwWY2ImU7vn305SQu317Hfdt5HCoigHx+IzKKogl6cs2Ng51Y/H3kJk2w9HVgPjjDRzNQZslzeBrpmPlP8ZcXmBlRdmQu+9ebfNf/F6g959/K2FlAaVICkDpTVf9NwdojXWqZCIgBD6yIm49xHoRZKVcaJdZnGXbAUuzH1FIu8Ham/4JAwJzipUJe5Ux5i4sd5IvB36pHEA9LR5Sbbdo5M4FYgMwIDAQAB'

export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`

/** Имя Native Messaging host (реестр + JSON manifest). */
export const NATIVE_HOST_NAME = 'ru.verstak.browser_bridge'

/** Версия wire-протокола bridge. */
export const BRIDGE_PROTOCOL_VERSION = 1 as const

/**
 * Максимальный размер одного NM-сообщения (байт JSON UTF-8).
 * Chrome hard-limit ≈ 1 MiB; fail-closed раньше — 256 KiB.
 */
export const MAX_MESSAGE_BYTES = 256 * 1024

/** Named pipe / socket basename (user-scoped path собирается в server). */
export const BRIDGE_PIPE_BASENAME = 'verstak-browser-bridge'

/** Состояния UI side panel + desktop (план §7). */
export type BridgeUiState =
  | 'offline'
  | 'connecting'
  | 'paired'
  | 'attached'
  | 'error'

export const BRIDGE_UI_STATES: readonly BridgeUiState[] = [
  'offline',
  'connecting',
  'paired',
  'attached',
  'error',
] as const
