/**
 * Ключи провайдеров из переменных окружения.
 *
 * Повод (враждебное ревью 2.6.4 §2): в свежем профиле не было сохранено ни
 * одного ключа, индикатор честно горел «не подключён» — а первая же задача ушла
 * в Google и вернула настоящий 403. Ключ брался из `GEMINI_API_KEY` молча. У
 * любого разработчика с Claude Code в окружении лежит `ANTHROPIC_API_KEY`:
 * продукт начинал бы платить чужими деньгами, не показав ни строки. README при
 * этом обещает «nothing leaves your machine except calls to the providers you
 * configure».
 *
 * Решение штаба: подхват ВЫКЛЮЧЕН по умолчанию. Разработке и headless он
 * по-прежнему нужен — остаётся за явным флагом окружения, и тогда интерфейс
 * обязан показывать, откуда взят ключ.
 */

/** Ключ настроек → переменная окружения. */
export const ENV_SECRET_MAP: Record<string, string> = {
  gemini_api_key: 'GEMINI_API_KEY',
  anthropic_api_key: 'ANTHROPIC_API_KEY',
  openai_api_key: 'OPENAI_API_KEY',
  groq_api_key: 'GROQ_API_KEY',
  xai_api_key: 'XAI_API_KEY',
}

/** Флаг, который включает подхват. Без него окружение не читается вовсе. */
export const ENV_KEYS_FLAG = 'VERSTAK_ALLOW_ENV_KEYS'

export type SecretSource = 'stored' | 'env' | null

export function envKeysAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[ENV_KEYS_FLAG] ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

/**
 * Откуда взят секрет. Сохранённое значение всегда сильнее окружения —
 * человек, который ввёл ключ в настройках, платит именно им.
 */
export function resolveSecret(
  key: string,
  stored: string | null,
  env: NodeJS.ProcessEnv = process.env,
): { value: string | null; source: SecretSource } {
  if (stored) return { value: stored, source: 'stored' }
  if (!envKeysAllowed(env)) return { value: null, source: null }
  const envName = ENV_SECRET_MAP[key]
  if (!envName) return { value: null, source: null }
  const fromEnv = env[envName]
  if (!fromEnv) return { value: null, source: null }
  return { value: fromEnv, source: 'env' }
}

/**
 * Ключи настроек, которые прямо сейчас питаются окружением, — для интерфейса.
 * Наружу уходят ТОЛЬКО имена, никогда значения.
 */
export function envSecretKeys(
  getStored: (key: string) => string | null,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!envKeysAllowed(env)) return []
  return Object.keys(ENV_SECRET_MAP).filter(key => resolveSecret(key, getStored(key), env).source === 'env')
}
