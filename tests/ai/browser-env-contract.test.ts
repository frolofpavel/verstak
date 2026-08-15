// P3 кусок 3 · КОНТРАКТ ВЫБОРА СРЕДЫ и разрешение исполняемого файла браузера.
//
// ЧТО СТЕРЕЖЁТСЯ И ЧЕГО ЗДЕСЬ СОЗНАТЕЛЬНО НЕТ. Правило выбора состоит из двух половин
// разной природы, и смешивать их в одном утверждении нельзя:
//   · РАНТАЙМ — дефолт «встроенный», липкость среды к прогону, честная ошибка на
//     незнакомом значении. Это код, он проверяем, и он ниже.
//   · ПРОСЬБА К МОДЕЛИ — «localhost и повторяемость бери в чистой сессии». Доказать
//     следование модели строке промпта тестом нельзя по построению (урок 30.07:
//     plan-директива была внесена, оказалась инертной и снята). Поэтому здесь
//     проверяется только то, что текст правила ДОШЁЛ до схемы инструмента из
//     единственного источника, а не то, что модель ему следует.
import { describe, it, expect } from 'vitest'
import {
  resolveBrowserEnv, isLocalhostUrl, localhostEnvHint, normalizeAgentUrl,
  BROWSER_ENVS, BROWSER_ENV_RULE, DEFAULT_BROWSER_ENV,
} from '../../shared/browser-env'
import { resolveBrowserExecutable, BROWSER_EXECUTABLE_ENV } from '../../electron/browser/isolated-launch'
import { TOOL_DEFS } from '../../electron/ai/tools'

describe('выбор среды браузера — рантайм-часть правила', () => {
  it('без env остаётся встроенный браузер (дефолт постановки)', () => {
    const r = resolveBrowserEnv(undefined, 'builtin')
    expect(r).toEqual({ ok: true, env: 'builtin', switched: false })
    expect(DEFAULT_BROWSER_ENV).toBe('builtin')
  })

  // ЛИПКОСТЬ — это и есть запрет молчаливой смены среды (рамка волны §4). Без неё
  // прогон, работающий в чистой сессии, на первом же вызове без `env` молча получил
  // бы страницу из браузера с куками человека и не узнал бы об этом.
  it('без env прогон ОСТАЁТСЯ в чистой сессии, а не возвращается в дефолт', () => {
    expect(resolveBrowserEnv(undefined, 'isolated')).toEqual({ ok: true, env: 'isolated', switched: false })
  })

  it('явное указание переключает среду и помечает переключение', () => {
    expect(resolveBrowserEnv('isolated', 'builtin')).toEqual({ ok: true, env: 'isolated', switched: true })
    expect(resolveBrowserEnv('builtin', 'isolated')).toEqual({ ok: true, env: 'builtin', switched: true })
  })

  // ЧЕСТНАЯ ОШИБКА ВМЕСТО ОТКАТА В ДЕФОЛТ. Откат был бы фолбэком без следа: просили
  // изоляцию — получили бы общий браузер и не заметили.
  it('незнакомая среда — ошибка, а не молчаливый откат во встроенный', () => {
    const r = resolveBrowserEnv('playwright', 'builtin')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/playwright/)
      expect(r.error, 'отказ обязан назвать допустимые значения').toMatch(/builtin/)
      expect(r.error).toMatch(/isolated/)
    }
  })

  it('пустая строка трактуется как «не указано», а не как ошибка', () => {
    expect(resolveBrowserEnv('', 'isolated')).toEqual({ ok: true, env: 'isolated', switched: false })
  })
})

describe('признак локального адреса и подсказка о чистой сессии', () => {
  it('локальные адреса опознаются во всех обычных формах', () => {
    for (const u of ['http://localhost:5173', 'localhost:3000', 'http://127.0.0.1:8080/app',
                     'https://app.localhost/x', 'http://0.0.0.0:9000']) {
      expect(isLocalhostUrl(u), `${u} не опознан как локальный`).toBe(true)
    }
  })

  it('публичные адреса локальными не считаются', () => {
    for (const u of ['https://example.com', 'https://localhost.evil.com', 'https://192.168.1.10']) {
      expect(isLocalhostUrl(u), `${u} ошибочно принят за локальный`).toBe(false)
    }
  })

  it('подсказка появляется ровно там, где правило однозначно', () => {
    expect(localhostEnvHint('builtin', 'http://localhost:5173')).toMatch(/isolated/)
  })

  // КОНТРОЛЬ (§3.1): рядом с «подсказка есть» обязан стоять случай, где её НЕТ,
  // иначе утверждение зелено и у функции, возвращающей подсказку всегда.
  it('КОНТРОЛЬ: подсказки нет ни на публичном адресе, ни уже в чистой сессии', () => {
    expect(localhostEnvHint('builtin', 'https://example.com')).toBeUndefined()
    expect(localhostEnvHint('isolated', 'http://localhost:5173')).toBeUndefined()
  })
})

describe('нормализация адреса для инструмента', () => {
  it('голый хост достраивается схемой', () => {
    expect(normalizeAgentUrl('localhost:5173')).toEqual({ ok: true, url: 'http://localhost:5173' })
    expect(normalizeAgentUrl('example.com/a/b')).toEqual({ ok: true, url: 'http://example.com/a/b' })
  })

  it('полный адрес не трогается', () => {
    expect(normalizeAgentUrl('https://example.com/x?y=1')).toEqual({ ok: true, url: 'https://example.com/x?y=1' })
  })

  // СОЗНАТЕЛЬНОЕ ОТЛИЧИЕ от адресной строки человека: там не-URL уезжает в поиск.
  // Здесь это сделало бы прогон невоспроизводимым и выглядело бы успехом.
  it('не-адрес — честная ошибка, а не молчаливый поисковый запрос', () => {
    const r = normalizeAgentUrl('как проверить форму')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/адрес/i)
  })
})

describe('схема инструмента объявляет среду и правило её выбора', () => {
  const nav = TOOL_DEFS.find(t => t.name === 'browser_navigate')

  it('browser_navigate принимает env с закрытым списком значений', () => {
    expect(nav).toBeTruthy()
    const props = (nav!.parameters as { properties: Record<string, { enum?: unknown[] }> }).properties
    expect(props.env, 'у точки входа нет параметра среды').toBeTruthy()
    expect(props.env.enum, 'список сред обязан быть закрытым').toEqual([...BROWSER_ENVS])
  })

  // Текст правила подставляется ИЗ ЕДИНСТВЕННОГО ИСТОЧНИКА. Пин сторожит именно связь:
  // если кто-то перепишет описание руками, копия начнёт расходиться с поведением молча.
  it('описание несёт правило выбора из общего источника, а не свою копию', () => {
    expect(nav!.description).toContain(BROWSER_ENV_RULE)
  })

  it('инструмент закрытия чистой сессии объявлен (явный close жизненного цикла)', () => {
    expect(TOOL_DEFS.some(t => t.name === 'browser_close_session')).toBe(true)
  })

  // ВТОРОГО НАБОРА ИНСТРУМЕНТОВ НЕТ — прямой запрет рамки волны. Пин ловит именно
  // это: попытка завести browser_*_isolated / playwright_* краснеет здесь.
  it('второго набора browser-инструментов под изоляцию не заведено', () => {
    const suspicious = TOOL_DEFS.map(t => t.name).filter(n => /playwright|_isolated|isolated_/i.test(n))
    expect(suspicious, `заведены дублирующие инструменты: ${suspicious.join(', ')}`).toEqual([])
  })
})

describe('чем запускается чистая сессия — разрешение исполняемого файла', () => {
  const winEnv = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\LA' } as NodeJS.ProcessEnv

  it('явное указание человека имеет высший приоритет', () => {
    const r = resolveBrowserExecutable({
      env: { ...winEnv, [BROWSER_EXECUTABLE_ENV]: 'C:\\my\\browser.exe' },
      platform: 'win32',
      exists: p => p === 'C:\\my\\browser.exe' || p.includes('msedge.exe'),
      playwrightExecutablePath: () => 'C:\\pw\\chrome.exe',
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.browser).toMatchObject({ executablePath: 'C:\\my\\browser.exe', source: 'override' })
  })

  // Промах явного указания НЕ подменяется автопоиском: подстановка «чего-нибудь
  // другого» вместо названного человеком — фолбэк без следа.
  it('явное указание на несуществующий файл — ошибка, а не тихий автопоиск', () => {
    const r = resolveBrowserExecutable({
      env: { ...winEnv, [BROWSER_EXECUTABLE_ENV]: 'C:\\нет\\browser.exe' },
      platform: 'win32',
      exists: p => p.includes('msedge.exe'),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(BROWSER_EXECUTABLE_ENV)
  })

  it('свой браузер playwright берётся, только если он реально скачан', () => {
    const withBrowser = resolveBrowserExecutable({
      env: winEnv, platform: 'win32',
      exists: p => p === 'C:\\pw\\chrome.exe',
      playwrightExecutablePath: () => 'C:\\pw\\chrome.exe',
    })
    expect(withBrowser.ok && withBrowser.browser.source).toBe('playwright')

    // Тот же путь, но файла нет (типовой случай: playwright-core без `playwright
    // install`) — уходим в системный браузер, а не отдаём мёртвый путь.
    const withoutBrowser = resolveBrowserExecutable({
      env: winEnv, platform: 'win32',
      exists: p => p.includes('msedge.exe'),
      playwrightExecutablePath: () => 'C:\\pw\\chrome.exe',
    })
    expect(withoutBrowser.ok && withoutBrowser.browser.source).toBe('system')
  })

  it('системный браузер: Edge предпочитается Chrome (на Windows он есть всегда)', () => {
    const r = resolveBrowserExecutable({
      env: winEnv, platform: 'win32',
      exists: p => p.includes('msedge.exe') || p.includes('chrome.exe'),
      playwrightExecutablePath: () => null,
    })
    expect(r.ok && r.browser.label).toBe('Microsoft Edge')
  })

  // ОТКАЗ ЧЕСТНЫЙ И ПОЛЕЗНЫЙ: называет причину, оба способа починки и прямо говорит,
  // что подмены встроенным браузером не будет (иначе «чистая сессия» была бы враньём).
  it('браузера нет — отказ с причиной и способом починки, без подмены встроенным', () => {
    const r = resolveBrowserExecutable({
      env: winEnv, platform: 'win32', exists: () => false, playwrightExecutablePath: () => null,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/Edge|Chrome/)
      expect(r.error).toContain(BROWSER_EXECUTABLE_ENV)
      expect(r.error, 'отказ обязан сказать, что встроенным это не подменяется').toMatch(/НЕ подменяется|не подменяется/)
    }
  })
})
