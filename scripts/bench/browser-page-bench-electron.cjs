// Electron-раннер токен-бенчмарка страниц (контракт — в browser-page-bench.mjs).
// Здесь только то, что требует Electron: настоящий Chromium грузит настоящую
// страницу, и в неё инжектируются ТЕ ЖЕ vskSnapshot/vskCapSnapshot/vskFind, что
// уходят в webview из BrowserView.tsx (через .toString()). Меряем прод-код, а не
// его копию — CLAUDE.md §3.1.
//
// ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ ПРОДА (объявлено, чтобы цифру не прочли шире, чем она есть):
//  · страница грузится в BrowserWindow, а не в <webview> внутри окна приложения.
//    Для снимка это тот же Chromium и тот же DOM; разница — в CSP приложения,
//    который к чужой странице сознательно НЕ применяется (csp-scope.ts, 12.08),
//    поэтому здесь его просто нет — то же, что после починки в проде;
//  · backgroundThrottling: false — окно скрыто, а замер должен видеть отрисованную
//    SPA. Ровно тот дефект, который чинили 13.08 (замороженная фоновая вкладка);
//    без этого бенчмарк мерил бы пустые страницы.
const { app, BrowserWindow } = require('electron')
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')

const config = JSON.parse(readFileSync(process.env.VERSTAK_PAGE_BENCH_CONFIG, 'utf8'))

app.setPath('userData', config.userDataDir)
app.disableHardwareAcceleration()

const snap = require(config.bundlePath)

/** Прогресс — в файл и построчно: stdout дочернего процесса виден только после
 *  выхода, поэтому зависший прогон снаружи неотличим от работающего. */
function progress(line) {
  const s = `${new Date().toISOString()} ${line}\n`
  process.stdout.write(s)
  try { appendFileSync(config.progressPath, s, 'utf8') } catch { /* лог не критичен */ }
}

/**
 * ПОТОЛОК НА КАЖДЫЙ ВЫЗОВ БРАУЗЕРА. Без него замер однажды встаёт навсегда: первая
 * редакция простояла на поиске Хабра 1 час 48 минут и не написала ни строки. Причина
 * структурная, а не про эту страницу — `loadURL` ждёт did-finish-load, которого у
 * страницы с длинными соединениями может не быть, а `executeJavaScript`, выданный в
 * момент навигации (клик по иконке поиска её и вызывает), адресован кадру, который
 * уже уничтожен: промис не отклоняется, он просто не наступает никогда.
 *
 * Отказ по времени — ЧЕСТНЫЙ результат замера, а зависание — отсутствие результата.
 */
function withTimeout(promise, ms, label) {
  let timer = null
  const guard = new Promise((_res, rej) => { timer = setTimeout(() => rej(new Error(`таймаут ${ms} мс: ${label}`)), ms) })
  return Promise.race([promise, guard]).finally(() => { if (timer) clearTimeout(timer) })
}

/** ~4 симв. на токен — та же оценка, что estimateTokens (electron/ai/context-limits.ts). */
const estimateTokens = (text) => Math.ceil(text.length / 4)

/**
 * Полезная нагрузка ОДНОГО tool result — ровно то, что уходит провайдеру:
 * runner-api.ts:1556 сериализует result.result через JSON.stringify.
 * Форма объекта — из browser.ts (url/title + тело инструмента).
 */
function payload(obj) {
  const s = JSON.stringify(obj)
  return { chars: s.length, tokens: estimateTokens(s) }
}

/** Код замера, исполняемый В СТРАНИЦЕ. Функции инжектятся так же, как в проде. */
function measureCode(gen, caps, queries, findLimit) {
  return `(() => {
    const snapshot = ${snap.vskSnapshot.toString()};
    const cap = ${snap.vskCapSnapshot.toString()};
    const find = ${snap.vskFind.toString()};
    const out = { url: location.href, title: document.title };

    // 1. Полный снимок (нумерует ВСЕ элементы) — та же операция, что в api.snapshot().
    const t0 = performance.now();
    const full = snapshot(${JSON.stringify(gen)});
    out.snapshotMs = performance.now() - t0;
    out.count = full.count;
    out.truncatedByBudget = full.truncatedByBudget === true;
    out.roles = full.elements.reduce((acc, e) => { acc[e.role] = (acc[e.role] || 0) + 1; return acc; }, {});
    out.unnamed = full.elements.filter(e => !e.name).length;

    // 2. Обрезка top-N — считаем полезную нагрузку на каждом кандидате порога.
    out.caps = ${JSON.stringify(caps)}.map(n => {
      const c = cap(full, n);
      return { n, shown: c.shown, truncated: c.truncated, body: c };
    });
    out.capAll = cap(full, full.count || 1);

    // 3. browser_find — как в проде: СВОЙ снимок + фильтр (api.find снимает заново).
    out.finds = ${JSON.stringify(queries)}.map(q => {
      const t = performance.now();
      const r = find(snapshot(${JSON.stringify(gen)} + 'f'), q, ${findLimit});
      return { query: q, ms: performance.now() - t, body: r };
    });

    // 4. browser_read_page — альтернативный путь потребления страницы (innerText).
    const text = document.body ? (document.body.innerText || '') : '';
    out.readPageChars = text.length;
    return out;
  })()`
}

/**
 * КОНТРОЛЬНЫЙ ЗАМЕР, без которого весь бенчмарк недоказуем: получает ли страница
 * КАДРЫ. Разведка 13.08 (`docs/browser-spa-render-recon-2026-08-13.md`) показала, что
 * скрытая поверхность может честно выполнить сеть и при этом дать 0 rAF — SPA,
 * рисующая в requestAnimationFrame, не отрисуется никогда, а `visibilityState`
 * продолжит врать «visible». Замер по такой странице выглядит как замер по пустой:
 * элементов мало, ошибок нет, никто не предупреждён.
 *
 * Поэтому у каждого прогона есть число кадров за секунду. 0 — цифры страницы
 * недействительны, и это видно в отчёте, а не додумывается.
 */
function rafProbeCode(ms) {
  return `(() => new Promise(resolve => {
    let frames = 0;
    const t0 = performance.now();
    const tick = () => { frames++; if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick); else resolve({ frames, visibility: document.visibilityState }); };
    requestAnimationFrame(tick);
    setTimeout(() => resolve({ frames, visibility: document.visibilityState }), ${ms + 500});
  }))()`
}

/**
 * Дождаться, пока страница ОТРИСОВАЛАСЬ: did-finish-load для SPA ничего не значит —
 * выдача приезжает XHR'ом после него. Ждём стабилизации числа интерактивных
 * элементов (две подряд одинаковые пробы), с честным потолком. Слепую паузу не
 * ставим: она либо коротка для SPA, либо дорога для статики.
 */
async function settle(wc, { pollMs, maxMs, minMs, stableNeeded }) {
  const probe = `(() => { try { return document.querySelectorAll('a[href],button,input,select,textarea,[role=button],[role=link]').length } catch (e) { return -1 } })()`
  const started = Date.now()
  let prev = -2
  let stable = 0
  let last = -1
  while (Date.now() - started < maxMs) {
    await new Promise(r => setTimeout(r, pollMs))
    let now = -1
    try { now = await withTimeout(wc.executeJavaScript(probe), 5000, 'проба готовности') } catch { now = -1 }
    last = now
    if (now === prev && now > 0) stable++
    else stable = 0
    prev = now
    // ДВА условия, а не одно. Первая редакция ждала две одинаковые пробы — и
    // засчитывала «страница готова» на каркасе SPA до прихода выдачи: у npm-поиска
    // получилось 2 элемента вместо 114, то есть замер тяжёлой страницы делался по
    // пустой. Симптом виден только по разбросу между повторами (min 2 / max 114) —
    // одиночный прогон соврал бы молча. Поэтому: и минимальное время, и больше проб.
    if (stable >= stableNeeded && Date.now() - started >= minMs) break
  }
  return { settleMs: Date.now() - started, interactiveAtSettle: last }
}

/**
 * Действия ДО замера: страница класса «SPA-выдача» показывает выдачу не по URL, а
 * после нажатия (эталон приёмки 10.08 — поиск Хабра: по прямому адресу с запросом
 * страница отдаёт заглушку «нажмите на иконку», и это её штатное поведение в любом
 * браузере). Мерить такую страницу без действия — мерить заглушку.
 *
 * Шаги исполняются ТЕМИ ЖЕ функциями, что у инструментов (vskFind + vskResolveNumbered),
 * поэтому попутно они и есть живое доказательство цепочки find → клик → выдача.
 */
async function applySteps(wc, steps) {
  const trace = []
  for (const step of steps) {
    if (step.waitMs) { await new Promise(r => setTimeout(r, step.waitMs)); trace.push({ waitMs: step.waitMs }); continue }
    const code = `(() => {
      const snapshot = ${snap.vskSnapshot.toString()};
      const find = ${snap.vskFind.toString()};
      const resolve = ${snap.vskResolveNumbered.toString()};
      const fill = ${snap.vskFill.toString()};
      const s = snapshot('step');
      const r = find(s, ${JSON.stringify(step.find)}, 30);
      if (!r.matches.length) return { ok: false, error: 'find без совпадений', query: ${JSON.stringify(step.find)} };
      const idx = ${JSON.stringify(step.index ?? 0)};
      const m = idx < 0 ? r.matches[r.matches.length + idx] : r.matches[idx];
      const got = resolve(m.n);
      if (!got.ok) return { ok: false, error: got.error };
      if (${JSON.stringify(step.action)} === 'type') {
        const f = fill(got.el, ${JSON.stringify(step.text ?? '')});
        if (!f.ok) return { ok: false, error: f.error };
      } else {
        try { got.el.scrollIntoView({ block: 'center' }); } catch (e) {}
        if (typeof got.el.click === 'function') got.el.click();
        else got.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      }
      return { ok: true, picked: { n: m.n, role: m.role, name: m.name }, totalHits: r.totalHits };
    })()`
    let res
    try { res = await withTimeout(wc.executeJavaScript(code), 15000, `шаг ${step.action} «${step.find}»`) }
    catch (err) { res = { ok: false, error: err instanceof Error ? err.message : String(err) } }
    trace.push({ step, result: res })
    if (!res || !res.ok) break
  }
  return trace
}

// ОДНО окно на весь замер. Первая редакция заводила окно под каждый повтор и
// стабильно роняла Electron на втором-третьем цикле (крэш main-процесса, crashpad
// «not connected»). Причина в замер не входит и здесь не расследуется — важно, что
// переиспользование окна её снимает и заодно ближе к проду: там один <webview> на
// всю работу, а не новый на каждую страницу.
let sharedWin = null
let consoleErrors = []

function getWindow() {
  if (sharedWin && !sharedWin.isDestroyed()) return sharedWin
  sharedWin = new BrowserWindow({
    // ВИДИМОСТЬ ОКНА — не косметика, а условие замера. Скрытое окно даёт ~1 кадр/с
    // (замер rAF ниже), и страница, раскрывающая содержимое по анимации, может не
    // дорисоваться. Контрольный прогон с --show отвечает на вопрос, искажает ли это
    // цифры: если число элементов совпало, скрытая поверхность мерит то же самое.
    show: config.showWindow === true,
    width: config.viewport.width,
    height: config.viewport.height,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Скрытое окно Chromium душит таймеры и rAF — SPA не дорисовывается.
      backgroundThrottling: false,
    },
  })
  const wc = sharedWin.webContents
  // Сигнатура события менялась между версиями Electron: старая — (event, level:number,
  // message), новая — один объект {level:'error'|'warning', message}. Поддерживаем обе,
  // иначе замер молча теряет консоль ровно там, где она и нужна (SPA-страницы).
  wc.on('console-message', (a, b, c) => {
    const level = a && typeof a === 'object' && 'level' in a ? a.level : b
    const message = a && typeof a === 'object' && 'message' in a ? a.message : c
    const isProblem = level === 'error' || level === 'warning' || (typeof level === 'number' && level >= 2)
    if (isProblem) consoleErrors.push(String(message).slice(0, 200))
  })
  // Гибель рендерера обязана оставлять след: без этого страница «просто пустая».
  wc.on('render-process-gone', (_e, details) => {
    consoleErrors.push(`render-process-gone: ${details && details.reason}`)
  })
  return sharedWin
}

/** Хост из URL, без учёта префикса www (редирект на www — не смена страницы). */
function hostOf(u) {
  try { return new URL(u).host.replace(/^www\./, '') } catch { return null }
}

async function loadPage(page) {
  const win = getWindow()
  const wc = win.webContents
  consoleErrors = []
  // ЧИСТЫЙ ЛИСТ ПЕРЕД КАЖДОЙ ЗАГРУЗКОЙ. Окно переиспользуется, и при неудачной
  // загрузке в нём оставался ПРЕДЫДУЩИЙ сайт — замер шёл по нему и выглядел
  // полноценным: у httpbin в отчёте стоял заголовок «Example Domain» и 1 элемент
  // вместо 13. Подмена молчаливая, поэтому лечится не проверкой, а тем, что подменять
  // становится нечем.
  try { await withTimeout(wc.loadURL('about:blank'), 5000, 'очистка окна') } catch { /* и так пусто */ }
  const t0 = Date.now()
  let loadError = null
  try {
    await withTimeout(wc.loadURL(page.url), config.loadTimeoutMs, `загрузка ${page.url}`)
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err)
    // Страница могла не «дозагрузиться» (стрим, длинный запрос), но DOM уже есть —
    // останавливаем догрузку и меряем что есть, честно пометив причину.
    try { wc.stop() } catch { /* уже остановлен */ }
  }
  const loadMs = Date.now() - t0
  // Вторая линия к тому же: мерить можно только ТУ страницу, которую заказывали.
  // about:blank в окне после отказа — честный признак «страницы нет», а чужой хост —
  // признак, что мы смотрим не туда.
  const actual = (() => { try { return wc.getURL() } catch { return null } })()
  const wrongPage = !actual || actual === 'about:blank' || hostOf(actual) !== hostOf(page.url)
  return { win, wc, loadMs, loadError, actual, wrongPage }
}

async function runPage(page) {
  const rec = {
    id: page.id, klass: page.klass, url: page.url, label: page.label,
    runs: [], error: null,
  }
  for (let i = 0; i < config.repeats; i++) {
    progress(`  ${page.id} повтор ${i + 1}/${config.repeats}: загрузка`)
    const { wc, loadMs, loadError, actual, wrongPage } = await loadPage(page)
    try {
      if (wrongPage) {
        progress(`  ${page.id} повтор ${i + 1}: в окне не та страница (${actual}) — прогон не засчитан`)
        rec.runs.push({ run: i + 1, loadMs, error: `в окне ${actual ?? 'ничего'}, а не ${page.url}`, loadIncomplete: loadError ?? null })
        continue
      }
      // Незавершённая загрузка — НЕ повод выбросить прогон: у страниц с длинными
      // соединениями did-finish-load может не наступить никогда, а DOM уже полон.
      // Меряем и помечаем причину; отсутствие DOM видно по count в отчёте.
      if (loadError) progress(`  ${page.id} повтор ${i + 1}: загрузка не завершилась (${loadError}) — меряем что есть`)
      const settleOpts = {
        pollMs: config.settlePollMs,
        maxMs: page.settleMaxMs ?? config.settleMaxMs,
        minMs: config.settleMinMs,
        stableNeeded: config.settleStable,
      }
      const st = await settle(wc, settleOpts)
      // Шаги (если заданы) и ПОВТОРНОЕ ожидание: после клика выдача приезжает так же
      // асинхронно, как при первой загрузке.
      let steps = null
      let stAfter = null
      if (page.steps && page.steps.length) {
        progress(`  ${page.id} повтор ${i + 1}: шаги до замера`)
        steps = await applySteps(wc, page.steps)
        stAfter = await settle(wc, settleOpts)
      }
      const gen = `bench${i}`
      progress(`  ${page.id} повтор ${i + 1}: замер`)
      let raf = null
      try { raf = await withTimeout(wc.executeJavaScript(rafProbeCode(1000)), 8000, 'проба кадров') } catch { raf = { frames: -1 } }
      const m = await withTimeout(wc.executeJavaScript(measureCode(gen, config.caps, page.queries, config.findLimit)), config.measureTimeoutMs, `замер ${page.id}`)

      // Полезные нагрузки считаем в Node: те же объекты, что собирает browser.ts.
      const capRows = m.caps.map(c => ({
        n: c.n, shown: c.shown, truncated: c.truncated,
        ...payload({ url: m.url, title: m.title, ...c.body }),
      }))
      const findRows = m.finds.map(f => ({
        query: f.query, ms: Math.round(f.ms),
        count: f.body.count, totalHits: f.body.totalHits, truncated: f.body.truncated,
        top: (f.body.matches || []).slice(0, 3).map(e => ({ n: e.n, role: e.role, name: e.name })),
        ...payload({ url: m.url, title: m.title, ...f.body }),
      }))
      rec.runs.push({
        run: i + 1,
        loadMs,
        settleMs: st.settleMs + (stAfter ? stAfter.settleMs : 0),
        interactiveAtSettle: (stAfter ?? st).interactiveAtSettle,
        interactiveBeforeSteps: steps ? st.interactiveAtSettle : null,
        steps,
        raf,
        loadIncomplete: loadError ?? null,
        title: m.title,
        finalUrl: m.url,
        count: m.count,
        unnamed: m.unnamed,
        roles: m.roles,
        truncatedByBudget: m.truncatedByBudget,
        snapshotMs: Math.round(m.snapshotMs),
        snapshotFull: payload({ url: m.url, title: m.title, ...m.capAll }),
        readPage: { chars: m.readPageChars, tokens: estimateTokens('x'.repeat(m.readPageChars)) },
        caps: capRows,
        finds: findRows,
        consoleErrorSample: consoleErrors.slice(0, 3),
      })
    } catch (err) {
      rec.runs.push({ run: i + 1, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return rec
}

/** Сохранённая ссылка на текущий результат — её пишет и сторож по общему бюджету. */
let liveResult = null

async function main() {
  await app.whenReady()
  // СТОРОЖ ПО ОБЩЕМУ БЮДЖЕТУ — вторая линия после потолков на каждый вызов. Потолки
  // закрывают известные способы зависнуть; сторож закрывает неизвестные. Выходим с
  // тем, что успели снять, и с ненулевым кодом: частичный результат объявлен.
  setTimeout(() => {
    progress(`СТОРОЖ: общий бюджет ${config.globalBudgetMs} мс исчерпан — выходим с частичным результатом`)
    try { if (liveResult) writeFileSync(config.resultPath, JSON.stringify({ ...liveResult, complete: false, watchdog: true }, null, 2), 'utf8') } catch { /* уже не пишется */ }
    app.exit(3)
  }, config.globalBudgetMs).unref?.()
  const result = {
    startedAt: new Date().toISOString(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    viewport: config.viewport,
    repeats: config.repeats,
    caps: config.caps,
    findLimit: config.findLimit,
    topN: snap.VSK_SNAPSHOT_TOP_N,
    pages: [],
  }
  liveResult = result
  for (const page of config.pages) {
    progress(`[page-bench] ${page.id} (${page.klass}) — ${page.url}`)
    result.pages.push(await runPage(page))
    // Пишем ПОСЛЕ КАЖДОЙ страницы: падение Chromium на последней странице не должно
    // стирать замер предыдущих. Частичный результат объявляется частичным (§3.1),
    // а не теряется.
    result.complete = result.pages.length === config.pages.length
    writeFileSync(config.resultPath, JSON.stringify(result, null, 2), 'utf8')
  }
  app.exit(0)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
