/**
 * Защита секретов на ДВУХ путях — один источник запретов (§3.2 ревизии 2026-08).
 *
 * Дефект, который закрывает эта сетка: список секрето-путей жил в двух редакциях —
 * `secret-scanner.isForbiddenPath` (API-путь) и рукописный `SECRET_GLOBS` в
 * `claude-cli.ts` (CLI-путь), объявлявший себя «зеркалом». Зеркало разошлось по пяти
 * позициям, и самая дорогая из них: приватный ключ В КОРНЕ ПРОЕКТА (обычное дело после
 * `ssh-keygen -f ./id_rsa`) API-путь закрывал, а Claude Code читал штатным `Read`.
 * То есть при работе через CLI защита была слабее, и об этом никто не знал.
 *
 * Почему прежний пин этого не ловил (§2.10 «б» ревизии): он проверял наличие пяти
 * ЛИТЕРАЛОВ в списке CLI и не импортировал `isForbiddenPath` вовсе — сравнивать двум
 * спискам между собой было нечем.
 *
 * Здесь сетка держит три вещи:
 *   1) КОНТРОЛЬНАЯ ПАРА — секрет закрыт на ОБОИХ путях, а обычный файл рядом читается
 *      на ОБОИХ. Без второй половины «закрыто» зелено и тогда, когда не читается ничего;
 *   2) все пять расхождений §3.2 поимённо — чтобы регрессия называлась своим именем;
 *   3) анти-дрейф: второй рукописный список глобов не завёлся заново нигде в `electron/`.
 *
 * ЧЕГО ЭТА СЕТКА НЕ ДОКАЗЫВАЕТ, и это граница, а не недоделка: диалект матчера внутри
 * дочернего `claude` нам не подконтролен — здесь моделируется общая gitignore-семантика.
 * И Bash-эксфильтрация (`cat id_rsa`) флагами не режется в принципе; на CLI-пути это
 * заявленный лимит, сеть безопасности там другая (Control Envelope).
 */
import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isForbiddenPath } from '../../electron/ai/secret-scanner'
import { claudeGuardArgs } from '../../electron/ai/claude-cli'

const ROOT = join(__dirname, '..', '..')

// ─────────────────────────────────────────────────────────────────────────────
// CLI-путь берётся в ПРОДОВОЙ форме: не из генератора, а из итоговых аргументов
// дочернего процесса — ровно того, что уезжает в argv. Тест, чья фикстура не
// совпадает с продовой формой вызова, не защищает ничего (§3.1 регламента).
// ─────────────────────────────────────────────────────────────────────────────
function cliDenyGlobs(mode: 'ask' | 'accept-edits' | 'bypass'): string[] {
  const args = claudeGuardArgs(mode)
  const dtIdx = args.indexOf('--disallowedTools')
  expect(dtIdx, 'в аргументах claude пропал --disallowedTools — guard секретов исчез').toBeGreaterThanOrEqual(0)
  const specs = args.slice(dtIdx + 1)
  return [...new Set(specs.map(s => s.replace(/^(?:Read|Edit|Write)\(/, '').replace(/\)$/, '')))]
}

/** gitignore-подмножество, которое реально порождает генератор: двойная звезда,
 *  одиночная звезда внутри сегмента, литералы. Больше он ничего не умеет. */
function globToRe(glob: string): RegExp {
  const segs = glob.split('/')
  let body = ''
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1
    if (seg === '**') {
      // хвостовая двойная звезда — любой хвост; ведущая или срединная — ноль и более
      // сегментов, поэтому «двойная звезда / имя» ловит имя и в корне проекта тоже.
      body += last ? '.*' : '(?:[^/]+/)*'
      return
    }
    body += seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
    if (!last) body += '/'
  })
  return new RegExp(`^${body}$`)
}

/** Закрыт ли путь на CLI-пути (хотя бы одним deny-глобом). */
function blockedByCli(relPath: string, globs: string[]): boolean {
  return globs.some(g => globToRe(g).test(relPath))
}

// ─────────────────────────────────────────────────────────────────────────────
// Корпус. Каждая строка — путь ОТНОСИТЕЛЬНО корня открытого проекта.
// ─────────────────────────────────────────────────────────────────────────────
/** Должно быть закрыто на ОБОИХ путях. */
const SECRET_PATHS: Array<[path: string, why: string]> = [
  // ── пять расхождений §3.2: до правки CLI пускал сюда, API — нет ──
  ['id_rsa', '§3.2: приватный ключ в корне проекта (ssh-keygen -f ./id_rsa)'],
  ['id_ed25519', '§3.2: приватный ключ вне .ssh/'],
  ['id_ecdsa', '§3.2: приватный ключ вне .ssh/'],
  ['id_dsa', '§3.2: приватный ключ вне .ssh/'],
  ['keys/id_rsa', '§3.2: приватный ключ в подкаталоге проекта'],
  ['authorized_keys', '§3.2: authorized_keys вне .ssh/'],
  ['known_hosts', '§3.2: known_hosts вне .ssh/'],
  ['credentials', '§3.2: файл credentials без расширения'],
  ['hh_cookies.json', '§3.2: cookies конкретного сервиса'],
  ['.envrc', '§3.2: .envrc (direnv) — прежний глоб с точкой его не ловил'],
  // ── то, что закрывали обе редакции: не должно потеряться при сведении ──
  ['.env', 'база: переменные окружения'],
  ['.env.local', 'база: переменные окружения'],
  ['.env.production', 'база: переменные окружения'],
  ['.ssh/id_ed25519', 'база: ключ в .ssh/'],
  ['home/.ssh/config', 'база: .ssh/ на любой глубине'],
  ['.aws/credentials', 'база: облачные креды'],
  ['.gnupg/secring.gpg', 'база: gnupg'],
  ['.azure/accessTokens.json', 'база: azure'],
  ['.docker/config.json', 'база: docker'],
  ['.kube/config', 'база: kube'],
  ['.config/gcloud/application_default_credentials.json', 'база: составной путь gcloud'],
  ['server.key', 'база: расширение ключа'],
  ['certs/site.pem', 'база: расширение сертификата'],
  ['bundle.p12', 'база: расширение'],
  ['bundle.pfx', 'база: расширение'],
  ['site.crt', 'база: расширение'],
  ['site.cer', 'база: расширение'],
  ['store.jks', 'база: расширение'],
  ['store.keystore', 'база: расширение'],
  ['creds_google.json', 'база: сервис-аккаунт (аудит B1)'],
  ['credentials.json', 'база: сервис-аккаунт'],
  ['.npmrc', 'база: токен реестра'],
  ['.netrc', 'база: логин/пароль'],
  ['cookies.json', 'база: cookies'],
]

/**
 * Должно ЧИТАТЬСЯ на обоих путях. Это вторая половина контрольной пары: без неё
 * утверждение «секрет закрыт» зелено и у списка, который закрывает вообще всё.
 */
const ORDINARY_PATHS: Array<[path: string, why: string]> = [
  ['id_rsa.pub', 'ПУБЛИЧНЫЙ ключ рядом с приватным в том же корне — читается'],
  ['notes.txt', 'обычный файл в корне проекта'],
  ['README.md', 'обычный файл в корне проекта'],
  ['package.json', 'манифест проекта'],
  ['config.json', 'намеренно НЕ в списке: слишком широко, бьёт по обычным конфигам'],
  ['src/index.ts', 'исходник'],
  ['keys/README.md', 'обычный файл в каталоге с говорящим именем'],
  ['docs/environment.md', 'имя начинается на «env», но это не .env'],
  ['src/keyboard.ts', 'в имени есть «key», но расширение не .key'],
]

describe('секрето-пути: API-путь и CLI-путь судят ОДИНАКОВО (§3.2)', () => {
  const globs = cliDenyGlobs('accept-edits')

  it('список deny-глобов не пуст (иначе пины ниже беспредметны)', () => {
    expect(globs.length, 'CLI остался без deny-глобов — сравнивать нечего').toBeGreaterThan(20)
  })

  describe('контрольная пара — закрытое закрыто на ОБОИХ путях', () => {
    for (const [path, why] of SECRET_PATHS) {
      it(`${path} — ${why}`, () => {
        expect(isForbiddenPath(path), `API-путь пустил секрет: ${path}`).toBe(true)
        expect(blockedByCli(path, globs), `CLI-путь пустил секрет: ${path}`).toBe(true)
      })
    }
  })

  describe('контрольная пара — обычное читается на ОБОИХ путях', () => {
    for (const [path, why] of ORDINARY_PATHS) {
      it(`${path} — ${why}`, () => {
        expect(isForbiddenPath(path), `API-путь закрыл обычный файл: ${path}`).toBe(false)
        expect(blockedByCli(path, globs), `CLI-путь закрыл обычный файл: ${path}`).toBe(false)
      })
    }
  })

  it('во ВСЕХ режимах guard одинаков — слабее в bypass он не становится', () => {
    expect(new Set(cliDenyGlobs('ask'))).toEqual(new Set(globs))
    expect(new Set(cliDenyGlobs('bypass'))).toEqual(new Set(globs))
  })

  it('свод: ни один путь корпуса не судится двумя путями по-разному', () => {
    const divergent = [...SECRET_PATHS, ...ORDINARY_PATHS]
      .map(([p]) => p)
      .filter(p => isForbiddenPath(p) !== blockedByCli(p, globs))
    expect(divergent, 'API-путь и CLI-путь снова разошлись — вернулась вторая редакция списка').toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Анти-дрейф. Образец — пин полярности флагов (tests/lib/runtime-flags.test.ts):
// сторожим не значение, а то, что ВТОРОЙ источник не завёлся заново.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Строковый литерал, который выглядит как рукописный секрето-глоб: содержит звезду,
 * содержит маркер секрета и состоит ТОЛЬКО из символов пути. Последнее условие важно:
 * оно отделяет объявление глоба от прозы, которая упоминает те же имена.
 */
const HAND_WRITTEN_SECRET_GLOB =
  /(['"`])(?=[^'"`\n]*\*)[A-Za-z0-9._*/-]*(?:\.env|\.ssh|\.aws|\.gnupg|\.kube|\.azure|\.npmrc|\.netrc|creds|credentials|cookies|\.pem|\.p12|\.pfx|\.jks|\.keystore|\.key)[A-Za-z0-9._*/-]*\1/

/** Единственное место, где такой литерал законен, — сам генератор. */
const SINGLE_SOURCE = 'electron/ai/secret-scanner.ts'

/** Комментарий, приводящий глоб КАК ПРИМЕР, вторым источником не является. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('секрето-пути: анти-дрейф — второй список не вернулся', () => {
  it(`во ВСЁМ electron/ секрето-глобы объявлены только в ${SINGLE_SOURCE}`, () => {
    const files = execSync('git ls-files electron', { cwd: ROOT, encoding: 'utf8' })
      .split('\n').map(f => f.trim()).filter(f => f.endsWith('.ts'))
    expect(files.length, 'не нашёл исходников electron/ — пин потерял предмет').toBeGreaterThan(50)
    const offenders: string[] = []
    for (const file of files) {
      if (file === SINGLE_SOURCE) continue
      const hit = stripComments(readFileSync(join(ROOT, file), 'utf8')).match(HAND_WRITTEN_SECRET_GLOB)
      if (hit) offenders.push(`${file} → ${hit[0]}`)
    }
    expect(offenders, 'рукописная вторая редакция секрето-списка вернулась в electron/').toEqual([])
  })

  /**
   * ЗАКОННАЯ РАЗНИЦА, названная явно (а не подогнанная под пин).
   *
   * `dangerous-commands.ts` тоже перечисляет секрето-имена, но это НЕ вторая редакция
   * списка путей: он судит ТЕКСТ КОМАНДЫ, а не путь, и сознательно ловит формы, которых
   * в списке путей нет и быть не должно — обходы через шаблон (`cat .ss*`, `id_*`) и
   * `kubeconfig`. Свести их — значит либо ослабить один, либо начать блокировать файл
   * `notes-about-.ssh.md` по подстроке.
   *
   * Единый источник на командном пути обеспечивает не он, а `command-policy`: каждый
   * токен команды проходит через тот же `isForbiddenPath`. Этот пин стережёт, что
   * командный путь не отвязался от общего источника вслед за CLI-путём.
   */
  it('командный путь судит токены тем же isForbiddenPath, а не своей копией списка', () => {
    const src = readFileSync(join(ROOT, 'electron/ai/command-policy.ts'), 'utf8')
    expect(src, 'command-policy перестал читать общий источник запретов').toContain('isForbiddenPath(tok)')
  })

  it('CLI-провайдер берёт глобы из единственного источника, а не пишет свои', () => {
    const src = readFileSync(join(ROOT, 'electron/ai/claude-cli.ts'), 'utf8')
    expect(src, 'claude-cli перестал звать общий генератор').toContain('secretPathDenyGlobs()')
  })

  it('контроль: регулярка ЛОВИТ дубль, если он появится (иначе пин выше пуст)', () => {
    // §3.1: рядом с каждым «не произошло» обязан стоять кейс, где то же происходит.
    expect(HAND_WRITTEN_SECRET_GLOB.test("const SECRET_GLOBS = ['**/.env', '.ssh/**']")).toBe(true)
    expect(HAND_WRITTEN_SECRET_GLOB.test("out.push('**/creds*.json')")).toBe(true)
    expect(HAND_WRITTEN_SECRET_GLOB.test("deny('**/*.pem')")).toBe(true)
    // И НЕ ловит того, что дублем не является.
    expect(HAND_WRITTEN_SECRET_GLOB.test('for (const g of secretPathDenyGlobs()) {')).toBe(false)
    expect(HAND_WRITTEN_SECRET_GLOB.test("if (isForbiddenPath('.env')) return")).toBe(false)
    // Проза, упоминающая те же имена, — не объявление списка (сообщение local-read).
    expect(HAND_WRITTEN_SECRET_GLOB.test(
      "message: 'Файл выглядит как хранилище секретов (.env / *.key / creds*.json) — отправка заблокирована.'"
    )).toBe(false)
  })
})
