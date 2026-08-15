/**
 * P3 кусок 3: ЧЕМ запускается изолированная сессия.
 *
 * РЕШЕНИЕ ПО ПОСТАВКЕ (пункт 4 постановки — «тянуть браузеры в установщик или ставить
 * по требованию»): не тянем НИ ТО, НИ ДРУГОЕ. В зависимостях — `playwright-core`
 * (драйвер, 12.8 МБ на диске, БЕЗ postinstall-загрузки браузеров), а сам браузер
 * берётся ТОТ, ЧТО УЖЕ ЕСТЬ НА МАШИНЕ: Edge на Windows 11 стоит всегда, Chrome —
 * почти всегда. Замер на машине Павла: system Edge 151 поднялся за 792 мс, свежий
 * контекст отдал 0 кук.
 *
 * Почему не полный `playwright`: его postinstall тянет ~450 МБ браузеров НА КАЖДУЮ
 * машину — и dev, и CI, — а в установщик они всё равно не попадают (лежат в
 * %LOCALAPPDATA%\ms-playwright, вне node_modules). То есть цена платится, а
 * пользователь всё равно зависит от внешнего кэша. Почему не «ставить по требованию»
 * скачиванием: это сотни мегабайт трафика посреди задачи и молчаливая пауза там, где
 * человек ждал проверки правки.
 *
 * ЧЕГО ЗДЕСЬ НЕТ СОЗНАТЕЛЬНО: тихой деградации. Браузера не нашлось — честный отказ с
 * названной причиной и двумя способами починки. Подменять изолированную сессию
 * встроенной запрещено рамкой волны (§3 п.5: «остановиться с одной понятной причиной,
 * не подменять её молча») и было бы худшим исходом: модель просила чистоту, получила
 * бы куки человека и не узнала бы об этом.
 *
 * ЧУЖОЙ КЭШ НЕ ЗАИМСТВУЕМ. В %LOCALAPPDATA%\ms-playwright могут лежать сборки от
 * других инструментов (на машине Павла — chromium-1208/1223 при ожидаемой 1234).
 * Берём оттуда только то, что вернул сам `playwright-core` для СВОЕЙ версии, и только
 * если файл существует: чужая сборка — это несовпадение протокола, отложенное до
 * первого странного отказа.
 */

import { existsSync } from 'fs'
import { join } from 'path'

/** Откуда взялся исполняемый файл — едет в ответ инструмента как след (не молчим). */
export type BrowserSourceKind = 'override' | 'playwright' | 'system'

export interface ResolvedBrowser {
  executablePath: string
  source: BrowserSourceKind
  /** Человеческое имя для отчёта: «Microsoft Edge», «Google Chrome», «Chromium». */
  label: string
}

export type LaunchResolution =
  | { ok: true; browser: ResolvedBrowser }
  | { ok: false; error: string }

/** Переменная окружения для явного указания браузера (ручной обход авто-поиска). */
export const BROWSER_EXECUTABLE_ENV = 'VERSTAK_BROWSER_EXECUTABLE'

export interface LaunchResolveDeps {
  /** Проверка существования файла (в тестах — подменяется). */
  exists?: (p: string) => boolean
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Путь к браузеру, которым управляет сам playwright-core (может отсутствовать). */
  playwrightExecutablePath?: () => string | null
}

interface Candidate { path: string; label: string }

/** Кандидаты «браузер уже стоит в системе», в порядке предпочтения. */
function systemCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Candidate[] {
  if (platform === 'win32') {
    const pf = env['ProgramFiles'] || 'C:\\Program Files'
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const local = env['LOCALAPPDATA'] || ''
    const out: Candidate[] = [
      // Edge идёт первым: на Windows 11 он есть всегда, значит отказ «нет браузера»
      // на этой платформе практически недостижим.
      { path: join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), label: 'Microsoft Edge' },
      { path: join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), label: 'Microsoft Edge' },
      { path: join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), label: 'Google Chrome' },
      { path: join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), label: 'Google Chrome' },
    ]
    if (local) out.push({ path: join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'), label: 'Google Chrome' })
    return out
  }
  if (platform === 'darwin') {
    return [
      { path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', label: 'Microsoft Edge' },
      { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', label: 'Google Chrome' },
      { path: '/Applications/Chromium.app/Contents/MacOS/Chromium', label: 'Chromium' },
    ]
  }
  return [
    { path: '/usr/bin/microsoft-edge', label: 'Microsoft Edge' },
    { path: '/usr/bin/google-chrome', label: 'Google Chrome' },
    { path: '/usr/bin/chromium', label: 'Chromium' },
    { path: '/usr/bin/chromium-browser', label: 'Chromium' },
  ]
}

/**
 * Найти, чем запускать изолированную сессию. Порядок: явное указание человека →
 * браузер самого playwright (если пользователь ставил его руками) → системный
 * Edge/Chrome. Ничего не нашлось — отказ с причиной, а не с пустым путём.
 */
export function resolveBrowserExecutable(deps: LaunchResolveDeps = {}): LaunchResolution {
  const exists = deps.exists ?? existsSync
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform

  const override = (env[BROWSER_EXECUTABLE_ENV] || '').trim()
  if (override) {
    // Явное указание НЕ молчит при промахе: подставить вместо него что-то своё —
    // ровно тот фолбэк без следа, из-за которого дефекты живут месяцами.
    if (!exists(override)) {
      return { ok: false, error: `${BROWSER_EXECUTABLE_ENV} указывает на несуществующий файл: ${override}` }
    }
    return { ok: true, browser: { executablePath: override, source: 'override', label: 'указанный браузер' } }
  }

  const own = deps.playwrightExecutablePath?.() ?? null
  if (own && exists(own)) {
    return { ok: true, browser: { executablePath: own, source: 'playwright', label: 'Chromium (playwright)' } }
  }

  for (const c of systemCandidates(env, platform)) {
    if (exists(c.path)) {
      return { ok: true, browser: { executablePath: c.path, source: 'system', label: c.label } }
    }
  }

  return {
    ok: false,
    error:
      'Изолированная сессия не запущена: на этой машине не найден браузер на движке Chromium. ' +
      'Verstak сознательно не тянет браузеры в установщик и не докачивает их посреди задачи — ' +
      'он использует уже установленный. Починить можно двумя способами: поставить Microsoft Edge ' +
      'или Google Chrome, либо указать путь к своему браузеру в переменной окружения ' +
      `${BROWSER_EXECUTABLE_ENV}. Встроенным браузером это НЕ подменяется: там живут ваши куки ` +
      'и входы, а вы просили чистую сессию.',
  }
}
