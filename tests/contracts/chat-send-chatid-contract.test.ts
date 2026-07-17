// Контракт «отправка знает свой чат» — хвост ревью 2.0.11-B, находка #2 (critical).
//
// КЛАСС ДЕФЕКТА. `ai:send` принимает chatId последним аргументом. От него в main зависят
// ТРИ вещи разом (electron/ipc/ai.ts, ~450-470):
//   1. компакция контекста — getContextSnapshot зовётся только при chatId (2.0.11-B);
//   2. закрепление аккаунта за чатом — без chatId резолв идёт «auto», и прогон уходит на
//      глобально-активный аккаунт вместо закреплённого (2.0.8-D2, UI 2.0.10);
//   3. изоляция worktree — isolatedRoot берётся только при chatId.
// Аргумент необязательный, забыть его молча — легко: TypeScript не ругается, тесты main
// зелёные (они сами подставляют chatId), UI выглядит рабочим. Фича мертва в тишине.
//
// Так и было: фоновые пути (очередь, напоминания, help, SideChat) chatId передавали, а
// ГЛАВНЫЙ путь основного чата — нет. Ревью поймало то, чего не видел ни один тест: дыра
// сидела в шве между слоями, обе половины «зелёные».
//
// Почему AST-страж, а не компонентный тест: Chat.tsx = 4292 строки и 37 эффектов; сквозной
// прогон отправки в jsdom упирается в инфраструктурный предел (в 2.0.9-A по этой же причине
// уже снимались два теста). Здесь проверяется само место шва — в исходнике, дёшево и точно.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const ROOT = process.cwd()

/**
 * Сканируем ВЕСЬ renderer, а не один Chat.tsx (ре-ревью B, находка #2).
 *
 * Первая версия стража смотрела только Chat.tsx — и пропустила PlanView и ReviewPills,
 * которые шлют в тот же главный чат тем же ai.send. Страж, знающий одно место, даёт
 * ложное спокойствие: дыра переезжает в соседний файл и «покрытие» об этом молчит.
 */
function rendererFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...rendererFiles(full))
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}
const SRC = join(ROOT, 'src')

/** Индекс аргумента chatId в сигнатурах preload. */
const CHATID_ARG_INDEX: Record<string, number> = {
  sendWithOverrides: 3, // (messages, projectPath, overrides, chatId?)
  sendWithBudget: 3,    // (messages, projectPath, budget, chatId?)
  send: 2,              // (messages, projectPath, chatId?)
}

interface SendCall {
  method: string
  file: string
  line: number
  argCount: number
  /** Текст аргумента chatId, если он передан. */
  chatIdArg: string | null
}

function collectSendCalls(file: string): SendCall[] {
  const src = readFileSync(file, 'utf8')
  if (!src.includes('api.ai.')) return []
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const out: SendCall[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      const target = node.expression.expression.getText(sf)
      // Только вызовы window.api.ai.* — не любые send() в файле.
      if (target.endsWith('api.ai') && method in CHATID_ARG_INDEX) {
        const idx = CHATID_ARG_INDEX[method]
        const arg = node.arguments[idx]
        out.push({
          method,
          file: file.slice(ROOT.length + 1).replace(/\\/g, '/'),
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          argCount: node.arguments.length,
          chatIdArg: arg ? arg.getText(sf) : null,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

describe('контракт: каждая отправка из renderer знает свой чат', () => {
  const calls = rendererFiles(SRC).flatMap(collectSendCalls)

  it('вызовы ai.send* вообще найдены (страж не ослеп после рефактора)', () => {
    // Если отправку переименуют/перенесут — страж молча прошёл бы на пустом списке.
    expect(calls.length).toBeGreaterThanOrEqual(8)
  })

  it('страж видит НЕ ТОЛЬКО Chat.tsx (иначе дыра переезжает в соседний файл)', () => {
    expect(new Set(calls.map(c => c.file)).size).toBeGreaterThan(1)
  })

  // ГЛАВНОЕ. Пропуск этого аргумента = три мёртвые фичи и ноль сигналов.
  it('НИ ОДИН вызов не забывает chatId', () => {
    const missing = calls.filter(c => c.chatIdArg === null)
    expect(
      missing.map(c => `${c.method} @ ${c.file}:${c.line} — chatId не передан`),
    ).toEqual([])
  })

  it('chatId — не пустая заглушка', () => {
    const bad = calls.filter(c => c.chatIdArg === 'undefined' || c.chatIdArg === 'null' || c.chatIdArg === "''")
    expect(bad.map(c => `${c.method} @ ${c.file}:${c.line} — chatId = ${c.chatIdArg}`)).toEqual([])
  })
})
