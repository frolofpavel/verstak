// Срез 2.0.7-E: живое обнаружение моделей провайдера. Первый адаптер — grok-cli
// (`grok models`). Формат plain-text, разобран по РЕАЛЬНОМУ обезличенному выводу
// (scratchpad/grok-models-real-output.txt), НЕ угадан. JSON grok models не отдаёт.
//
// Безопасность: наружу отдаём только id-строки + код причины (UPPER_SNAKE). Ни токенов,
// ни путей, ни сырого окружения (secret-scanner тут не нужен — мы не пробрасываем stdout).

import { spawn } from 'child_process'

export type DiscoveryStatus = 'available' | 'empty' | 'error'

export interface DiscoveryResult {
  status: DiscoveryStatus
  /** Обнаруженные id моделей (пусто при empty/error). */
  models: string[]
  /** Дефолтная модель провайдера, если сообщена. */
  defaultModel: string | null
  /**
   * Был ли пользователь аутентифицирован в момент обнаружения. КРИТИЧНО для гейта:
   * НЕзалогиненный `grok models` всё равно отдаёт СТАТИЧЕСКИЙ каталог, но он может быть
   * НЕПОЛНЫМ («залогиненный вывод может отличаться — больше моделей», факт от Павла).
   * Блокировать модель по неаутентифицированному каталогу нельзя — можно ложно отсечь
   * модель, доступную в реальном аккаунте.
   */
  authenticated: boolean
  /** Машинный код причины для empty/error. Без секретов/путей — только UPPER_SNAKE. */
  reasonCode?: string
}

/**
 * Разбирает stdout `grok models`. Чистая функция — сверена с ФАКТИЧЕСКИМ выводом в ДВУХ
 * состояниях (захвачено 15.07 на машине Павла, grok 0.2.101):
 *
 *   [auth]   You are logged in with grok.com.
 *   [unauth] You are not authenticated.
 *            Default model: grok-4.5
 *            Available models:
 *              * grok-4.5 (default)
 *              - grok-composer-2.5-fast
 *
 * ВАЖНО: unauth-состояние отдаёт каталог и exit 0 БЕЗ ошибки — баннер «not authenticated»
 * НЕ ошибка, парсер его переживает. Маркер строки модели — `*` (дефолт) или `-`; id =
 * токен после маркера (суффикс «(default)» отделён пробелом и в id не попадает).
 * Ошибочными считаем только машинно-достоверные случаи: ненулевой exit и неразбираемый
 * вывод. Grok-специфичные строки ошибок НЕ выдумываем (карточка: «не угадывать формат»).
 */
export function parseGrokModels(stdout: string, exitCode: number): DiscoveryResult {
  const text = stdout ?? ''
  // «logged in» → аутентифицирован; «not authenticated»/«not logged in» → нет.
  const authenticated = /you are logged in/i.test(text) && !/not authenticated|not logged in/i.test(text)
  const fail = (reasonCode: string, defaultModel: string | null = null): DiscoveryResult =>
    ({ status: 'error', models: [], defaultModel, authenticated, reasonCode })

  if (exitCode !== 0) return fail('EXIT_NONZERO')

  const defaultMatch = text.match(/Default model:\s*(\S+)/)
  const defaultModel = defaultMatch ? defaultMatch[1] : null

  const markerIdx = text.search(/Available models:/i)
  if (markerIdx === -1) return fail('PARSE_FAILED', defaultModel)

  const models: string[] = []
  // Строки ПОСЛЕ строки-маркера "Available models:". id — строгий шаблон
  // (word/точка/дефис/слэш): ревью F4 — stdout+stderr слиты, «- warning: …» не должен
  // попасть фантомной моделью; двоеточие/пробел/скобка в id невозможны.
  for (const line of text.slice(markerIdx).split(/\r?\n/).slice(1)) {
    const m = line.match(/^\s*[*-]\s+([\w.\-/]+)(?:\s|$)/)
    if (m) models.push(m[1])
  }
  // Структурно-защитный случай (секция есть, строк нет) — не заявляем как подтверждённый
  // grok-вывод, но обрабатываем корректно.
  if (models.length === 0) return { status: 'empty', models: [], defaultModel, authenticated, reasonCode: 'EMPTY_CATALOG' }
  return { status: 'available', models, defaultModel, authenticated }
}

/**
 * Запускает `grok models` (одноразово, read-only, без стоимости) и разбирает вывод.
 * Таймаут, чтобы не подвесить doctor. Ошибку спавна отдаём как error/SPAWN_FAILED —
 * без деталей окружения. Инъекция бинаря/спавна — для теста.
 */
export async function runGrokDiscovery(opts: {
  binary: string
  timeoutMs?: number
  spawnFn?: typeof spawn
  signal?: AbortSignal
}): Promise<DiscoveryResult> {
  const spawnImpl = opts.spawnFn ?? spawn
  const timeoutMs = opts.timeoutMs ?? 20000
  return await new Promise<DiscoveryResult>(resolve => {
    let out = ''
    let settled = false
    const done = (r: DiscoveryResult) => { if (!settled) { settled = true; resolve(r) } }
    let child: ReturnType<typeof spawn>
    try {
      child = spawnImpl(opts.binary, ['models'], {
        shell: opts.binary.endsWith('.cmd') || opts.binary.endsWith('.ps1'),
        signal: opts.signal,
      })
    } catch {
      done({ status: 'error', models: [], defaultModel: null, authenticated: false, reasonCode: 'SPAWN_FAILED' })
      return
    }
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } done({ status: 'error', models: [], defaultModel: null, authenticated: false, reasonCode: 'TIMEOUT' }) }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { out += d.toString() })
    child.on('error', () => { clearTimeout(timer); done({ status: 'error', models: [], defaultModel: null, authenticated: false, reasonCode: 'SPAWN_FAILED' }) })
    child.on('close', (code: number | null) => { clearTimeout(timer); done(parseGrokModels(out, code ?? 0)) })
  })
}
