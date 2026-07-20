/**
 * Срез 2.1.3-B (R1): Subscription Doctor — безопасная диагностика подписочного аккаунта.
 *
 * Отвечает на вопросы пользователя: работает ли аккаунт, требует ли входа, почему
 * недоступен и что делать дальше. Результат — renderer-safe SubscriptionDoctorReportDTO.
 *
 * ИНВАРИАНТЫ БЕЗОПАСНОСТИ (покрыты tests/ai/subscription-doctor.test.ts):
 *  - значения access/refresh токенов НЕ выходят из probe (в отчёт — только booleans
 *    и срок в ms); ни credRef, ни configDir, ни имени файла авторизации в label'ах;
 *  - пустой/битый auth.json — это «нужен вход», а не «готов»: credential = непустой
 *    tokens.access_token, ровно как требует рантайм (codex-oauth/credential-store);
 *  - срок действия читается из JWT exp access_token (tokenExpiresAtMs — та же функция,
 *    что использует рантайм), а не из произвольных полей файла;
 *  - неизвестное честно помечается, ложного «готов» нет: Doctor НЕ делает live-probe
 *    и прямо говорит об этом в итоговой формулировке.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { SubscriptionAccount } from '../storage/subscription-accounts'
import { tokenExpiresAtMs } from './codex-oauth/auth'
import type {
  SubscriptionDoctorCheckDTO,
  SubscriptionDoctorReportDTO,
  SubscriptionState,
} from '../../shared/contracts/subscription'
import type { ProviderId } from '../../shared/contracts/provider'

export interface SubscriptionDoctorDeps {
  /** Есть ли секрет в SafeStorage по credRef (только для token-аккаунтов). */
  hasCredential: (credRef: string) => boolean
  now?: number
}

/** Доступ считается «скоро истекающим», если до конца меньше этого окна. */
const EXPIRING_SOON_MS = 10 * 60_000

/** Минимальный известный каталог: doctor не тянет реестр провайдеров (тяжёлый импорт),
 *  полный список моделей живёт в electron/ai/registry.ts и Model Catalog. */
const KNOWN_MODEL_HINT: Record<string, string> = {
  'claude-cli': 'Claude (Sonnet/Opus/Haiku)',
  'codex-cli': 'GPT Codex (gpt-5-codex и др.)',
  'openai-codex-oauth': 'GPT Codex (gpt-5-codex и др.)',
}

const CLI_NAME: Record<string, string> = {
  'claude-cli': 'Claude Code',
  'codex-cli': 'Codex',
  'openai-codex-oauth': 'Codex',
}

const COOLDOWN_REASON_LABEL: Record<string, string> = {
  quota: 'квота исчерпана',
  'rate-limit': 'лимит частоты',
  auth: 'ошибка авторизации',
  'provider-unavailable': 'провайдер недоступен',
  unknown: 'причина неизвестна',
}

/**
 * ЕДИНЫЙ безопасный probe config-dir аккаунта (R1 БЛОКЕР 1): используется и в
 * subscription-accounts:list, и в Doctor — двух разных проверок «вошёл ли аккаунт»
 * в коде нет. Значения токенов из функции НЕ выходят: наружу — booleans + срок в ms.
 *
 * Семантика совпадает с рантаймом (codex-oauth/credential-store.readAuth):
 * кред есть ⟺ файл читается, JSON валиден, tokens.access_token — непустая строка.
 */
export interface ConfigDirAuthProbe {
  /** непустой tokens.access_token присутствует (значение не покидает main) */
  credentialPresent: boolean
  /** exp access_token (JWT) в ms epoch; null — не читается/нет claim */
  accessExpiresAtMs: number | null
  /** непустой tokens.refresh_token присутствует */
  hasRefreshToken: boolean
}

export function probeConfigDirAuth(configDir: string): ConfigDirAuthProbe {
  const absent: ConfigDirAuthProbe = { credentialPresent: false, accessExpiresAtMs: null, hasRefreshToken: false }
  const file = join(configDir, 'auth.json')
  if (!existsSync(file)) return absent
  let parsed: unknown = null
  try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch { return absent }
  if (typeof parsed !== 'object' || parsed === null) return absent
  const root = parsed as Record<string, unknown>
  const tokens = (typeof root.tokens === 'object' && root.tokens !== null ? root.tokens : {}) as Record<string, unknown>
  const access = typeof tokens.access_token === 'string' ? tokens.access_token : ''
  if (!access) return { ...absent, hasRefreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0 }
  return {
    credentialPresent: true,
    accessExpiresAtMs: tokenExpiresAtMs(access),
    hasRefreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0,
  }
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Собранные заранее факты, от которых зависят все проверки. */
interface DoctorFacts {
  now: number
  isConfigDir: boolean
  cliName: string
  /** null для token-аккаунтов (папки нет по построению) */
  dirExists: boolean | null
  /** null для token-аккаунтов и при отсутствии папки */
  auth: ConfigDirAuthProbe | null
  credPresent: boolean
  cooling: boolean
  /** access истёк (exp прочитан и <= now) */
  accessExpired: boolean
  state: SubscriptionState
}

/** Итоговое состояние: приоритет invalid → login-required → cooling → ready. */
function resolveState(account: SubscriptionAccount, f: Omit<DoctorFacts, 'state'>): SubscriptionState {
  if (account.state === 'invalid') return 'invalid'
  if (!f.credPresent) return 'login-required'
  // Истёкший access БЕЗ refresh — вход нужен заново; С refresh — автообновление
  // при следующем запросе, аккаунт остаётся ready (expiry-check скажет warn).
  if (f.accessExpired && !f.auth?.hasRefreshToken) return 'login-required'
  if (f.cooling) return 'cooling'
  return 'ready'
}

function collectFacts(account: SubscriptionAccount, deps: SubscriptionDoctorDeps): DoctorFacts {
  const now = deps.now ?? Date.now()
  const isConfigDir = Boolean(account.configDir)
  const dirExists = isConfigDir ? existsSync(account.configDir!) : null
  const auth = isConfigDir && dirExists ? probeConfigDirAuth(account.configDir!) : null
  // Кред: token-аккаунт → секрет в SafeStorage; config-dir → единый probe (НЕ
  // deps.hasCredential: у config-dir credRef пуст по построению).
  const credPresent = isConfigDir ? Boolean(auth?.credentialPresent) : deps.hasCredential(account.credRef)
  const cooling = typeof account.coolingUntil === 'number' && account.coolingUntil > now
  const accessExpired = auth?.credentialPresent === true && auth.accessExpiresAtMs !== null && auth.accessExpiresAtMs <= now
  const base = { now, isConfigDir, cliName: CLI_NAME[account.providerId] ?? 'CLI-провайдер', dirExists, auth, credPresent, cooling, accessExpired }
  return { ...base, state: resolveState(account, base) }
}

function configDirCheck(f: DoctorFacts): SubscriptionDoctorCheckDTO {
  if (!f.isConfigDir) return { id: 'config-dir', status: 'info', label: 'Аккаунт с токеном — папка стейта не используется.' }
  if (f.dirExists) return { id: 'config-dir', status: 'ok', label: 'Изолированная папка аккаунта на месте.' }
  return { id: 'config-dir', status: 'fail', label: 'Папка аккаунта не найдена — удалена или недоступна.' }
}

function credentialCheck(f: DoctorFacts): SubscriptionDoctorCheckDTO {
  if (f.credPresent) {
    return {
      id: 'credential', status: 'ok',
      label: f.isConfigDir ? 'Вход выполнен: авторизация на месте.' : 'Токен сохранён в защищённом хранилище.',
    }
  }
  return {
    id: 'credential', status: 'fail',
    label: f.isConfigDir ? 'Вход не пройден: действующей авторизации нет.' : 'Токен не найден в хранилище.',
  }
}

function expiryCheck(f: DoctorFacts): SubscriptionDoctorCheckDTO {
  if (!f.isConfigDir) {
    return { id: 'oauth-expiry', status: 'info', label: 'Токен статический — срок действия не проверяется.' }
  }
  if (!f.credPresent) {
    return { id: 'oauth-expiry', status: 'info', label: 'Вход не пройден — срок действия проверять нечего.' }
  }
  const exp = f.auth!.accessExpiresAtMs
  if (exp === null) {
    // exp не читается: срок не выдумываем. Refresh покрывает неизвестность → info,
    // без refresh — честный warn (обновлять нечем).
    return f.auth!.hasRefreshToken
      ? { id: 'oauth-expiry', status: 'info', label: 'Срок действия неизвестен (не читается из токена); refresh есть — обновится при необходимости.' }
      : { id: 'oauth-expiry', status: 'warn', label: 'Срок действия неизвестен (не читается из токена), refresh-токена нет.' }
  }
  if (exp <= f.now) {
    return f.auth!.hasRefreshToken
      ? { id: 'oauth-expiry', status: 'warn', label: 'Срок доступа истёк — обновится автоматически при следующем запросе.' }
      : { id: 'oauth-expiry', status: 'fail', label: 'Срок доступа истёк, refresh-токена нет — нужен новый вход.' }
  }
  if (exp - f.now < EXPIRING_SOON_MS) {
    return { id: 'oauth-expiry', status: 'warn', label: `Доступ скоро истечёт (в ${fmtTime(exp)}).` }
  }
  return { id: 'oauth-expiry', status: 'ok', label: `Доступ действует до ${fmtTime(exp)}.` }
}

function refreshCheck(f: DoctorFacts): SubscriptionDoctorCheckDTO {
  if (!f.isConfigDir) {
    return { id: 'refresh', status: 'info', label: 'Автообновление не требуется (статический токен).' }
  }
  if (!f.credPresent) {
    return { id: 'refresh', status: 'info', label: 'Вход не пройден — refresh-токена нет.' }
  }
  return f.auth!.hasRefreshToken
    ? { id: 'refresh', status: 'ok', label: 'Refresh-токен есть — доступ обновится автоматически.' }
    : { id: 'refresh', status: 'warn', label: 'Refresh-токена нет — после истечения доступа нужен новый вход.' }
}

function modelsCheck(account: SubscriptionAccount): SubscriptionDoctorCheckDTO {
  const hint = KNOWN_MODEL_HINT[account.providerId]
  return hint
    ? { id: 'models', status: 'ok', label: `Каталог моделей известен (справочно, без запроса к провайдеру): ${hint}.` }
    : { id: 'models', status: 'info', label: 'Каталог моделей для этого провайдера не задан (без запроса).' }
}

function cooldownCheck(account: SubscriptionAccount, f: DoctorFacts): SubscriptionDoctorCheckDTO {
  if (!f.cooling) return { id: 'cooldown', status: 'ok', label: 'Активного остывания нет.' }
  const reason = COOLDOWN_REASON_LABEL[account.cooldownReason ?? ''] ?? COOLDOWN_REASON_LABEL.unknown
  const scope = account.cooldownScope === 'model' && account.cooldownModel
    ? ` · модель ${account.cooldownModel}`
    : account.cooldownScope === 'provider' ? ' · весь провайдер' : ''
  const until = account.coolingUntil ? ` · до ${fmtTime(account.coolingUntil)}` : ''
  return { id: 'cooldown', status: 'warn', label: `Остывает: ${reason}${scope}${until}.` }
}

// R1 БЛОКЕР 3: lastUsedAt пишется при ВЫБОРЕ аккаунта, до результата запроса — это
// попытка использования, а не успех. Настоящий lastSuccessAt — осознанный долг
// (нужен touch в runner после успешного ответа; здесь не делаем).
function lastUseCheck(account: SubscriptionAccount): SubscriptionDoctorCheckDTO {
  return account.lastUsedAt
    ? { id: 'last-use', status: 'info', label: `Последняя попытка использования: ${new Date(account.lastUsedAt).toLocaleString()}.` }
    : { id: 'last-use', status: 'info', label: 'Аккаунт ещё не использовался.' }
}

function routeCheck(f: DoctorFacts): SubscriptionDoctorCheckDTO {
  return {
    id: 'route', status: 'info',
    label: f.isConfigDir
      ? `Маршрут: ${f.cliName} CLI с изолированной папкой аккаунта (конфигурация, запуск не выполнялся).`
      : `Маршрут: ${f.cliName} CLI, токен подставляется в окружение процесса (конфигурация, запуск не выполнялся).`,
  }
}

/** Итоговая строка + следующий шаг человеку (null — ничего делать не нужно). */
function verdict(f: DoctorFacts, overall: SubscriptionDoctorReportDTO['overall']): { summary: string; nextStep: string | null } {
  // Честная формулировка (R1): Doctor не делает live-probe — не утверждаем, что
  // сеть/CLI/модель реально отвечают.
  if (overall === 'ok') {
    return { summary: 'Локальная конфигурация выглядит готовой. Реальный запрос не выполнялся.', nextStep: null }
  }
  if (f.state === 'cooling') {
    return {
      summary: 'Аккаунт временно остывает после лимита.',
      nextStep: 'Переключись на другой аккаунт этого провайдера или дождись конца остывания.',
    }
  }
  if (f.state === 'login-required') {
    return {
      summary: 'Аккаунт недоступен: требуется вход.',
      nextStep: f.isConfigDir
        ? 'Пройди вход: нажми «Войти» на строке аккаунта и заверши авторизацию в открывшемся терминале.'
        : 'Токен не найден. Удали аккаунт и добавь его заново с актуальным токеном.',
    }
  }
  if (f.dirExists === false) {
    return {
      summary: 'Аккаунт недоступен: папка конфигурации не найдена.',
      nextStep: 'Удали аккаунт и добавь его заново — папка стейта будет создана снова.',
    }
  }
  if (overall === 'warn') {
    return { summary: 'Конфигурация в порядке, но есть замечания ниже. Реальный запрос не выполнялся.', nextStep: null }
  }
  return { summary: 'Аккаунт недоступен.', nextStep: null }
}

export function runSubscriptionDoctor(
  account: SubscriptionAccount,
  deps: SubscriptionDoctorDeps,
): SubscriptionDoctorReportDTO {
  const f = collectFacts(account, deps)
  // Всегда все 8 проверок; неприменимое — честный 'info' (на итог не влияет).
  const checks: SubscriptionDoctorCheckDTO[] = [
    configDirCheck(f),
    credentialCheck(f),
    expiryCheck(f),
    refreshCheck(f),
    modelsCheck(account),
    cooldownCheck(account, f),
    lastUseCheck(account),
    routeCheck(f),
  ]
  const overall: SubscriptionDoctorReportDTO['overall'] =
    checks.some(c => c.status === 'fail') ? 'fail'
      : checks.some(c => c.status === 'warn') ? 'warn'
        : 'ok'
  const { summary, nextStep } = verdict(f, overall)
  return {
    accountId: account.id,
    providerId: account.providerId as ProviderId,
    state: f.state,
    overall,
    checks,
    summary,
    nextStep,
    checkedAt: f.now,
  }
}
