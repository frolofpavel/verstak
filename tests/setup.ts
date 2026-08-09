import { afterEach, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { configureRuntimeLogDir } from '../electron/runtime-log'

// Тесты НЕ смеют писать в БОЕВОЙ журнал приложения. Без этого runtime-log без
// конфигурации падает на %APPDATA%/Verstak/logs — тот самый errors.jsonl, что читает
// живое приложение и охотник за прод-багами. Любой logRuntimeError в тесте сыпал туда
// ложные ошибки, маскируя настоящие (09.08: 336 фальшивых `searchMemories` увели штаб
// на несуществующий дефект). Перенаправляем ТОЛЬКО журнал во временный каталог —
// process.env.APPDATA не трогаем (его читают CLI-detect и headless-фолбэк для реальных
// путей). Каталог свой на процесс-воркер; ОС подметёт temp сама.
configureRuntimeLogDir(join(mkdtempSync(join(tmpdir(), 'vst-test-logs-')), 'logs'))

// Ревизия ambient-лимитов (28.07). У `waitFor` из @testing-library бюджет по
// умолчанию — 1000 мс, и он нигде не задан явно: число выбрано библиотекой, а не
// по нашим измерениям. Замер по трём ПОЛНЫМ параллельным прогонам (json-отчёты
// vitest, максимум длительности теста): settings-characterization 966 мс,
// outcome-mode 848, context-meter 725, policy-tab 712. То есть худший
// component-тест целиком укладывался в 0.97 бюджета, а ожидание — лишь его
// часть; context-meter на этом уже падал «Timed out in waitFor» под нагрузкой.
//
// 5_000 — запас ~5× над худшим измеренным и заведомо меньше testTimeout=20_000:
// настоящая регрессия по-прежнему падает ИМЕННО ошибкой ожидания, а не
// безымянным таймаутом прогона. Логика тестов не тронута — только бюджет.
const DOM_ASYNC_TIMEOUT_MS = 5_000
if (typeof document !== 'undefined') {
  const { configure } = await import('@testing-library/dom')
  configure({ asyncUtilTimeout: DOM_ASYNC_TIMEOUT_MS })
}

// Гигиена глобалов: тесты, мокающие globalThis.fetch через vi.stubGlobal,
// раньше оставляли стаб активным после последнего it() файла — он протекал
// в следующий тест-файл (например telegram.test.ts с реальным fetch падал
// в общем прогоне, но проходил изолированно). Глобальный afterEach снимает
// все стабы после каждого теста — один источник правды вместо afterEach в
// каждом тест-файле.
afterEach(() => {
  vi.unstubAllGlobals()
  // Тест не должен оставлять СЛЕДОВ соседям. unstubAllGlobals снимает stubGlobal, но НЕ
  // vi.spyOn: мок реального http/https/singleton'а без restore жил до конца процесса и
  // ломал следующий файл (нативная линия: autoupdate-download-resume падал под нагрузкой,
  // когда сосед оставлял мок реального http). restoreAllMocks снимает все spy → ни один
  // тест не портит глобальное состояние для соседей. Безопасно: ни один тест не держит
  // spy в beforeAll между it (проверено grep'ом — 0 таких файлов). Класс — брат d89d46b
  // (тесты не пишут в боевой журнал): и то, и другое — «тест не оставляет следов».
  vi.restoreAllMocks()
})
