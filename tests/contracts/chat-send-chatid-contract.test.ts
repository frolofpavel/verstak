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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const ROOT = process.cwd()
const CHAT_PATH = join(ROOT, 'src', 'components', 'Chat.tsx')

/** Индекс аргумента chatId в сигнатурах preload. */
const CHATID_ARG_INDEX: Record<string, number> = {
  sendWithOverrides: 3, // (messages, projectPath, overrides, chatId?)
  sendWithBudget: 3,    // (messages, projectPath, budget, chatId?)
  send: 2,              // (messages, projectPath, chatId?)
}

interface SendCall {
  method: string
  line: number
  argCount: number
  /** Текст аргумента chatId, если он передан. */
  chatIdArg: string | null
}

function collectSendCalls(file: string): SendCall[] {
  const src = readFileSync(file, 'utf8')
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

describe('контракт: каждая отправка из Chat.tsx знает свой чат', () => {
  const calls = collectSendCalls(CHAT_PATH)

  it('вызовы ai.send* вообще найдены (страж не ослеп после рефактора)', () => {
    // Если Chat.tsx переименуют/перенесут отправку — страж молча пройдёт на пустом списке.
    expect(calls.length).toBeGreaterThanOrEqual(4)
  })

  // ГЛАВНОЕ. Пропуск этого аргумента = три мёртвые фичи и ноль сигналов.
  it('НИ ОДИН вызов не забывает chatId', () => {
    const missing = calls.filter(c => c.chatIdArg === null)
    expect(
      missing.map(c => `${c.method} @ Chat.tsx:${c.line} — chatId не передан`),
    ).toEqual([])
  })

  it('chatId — не пустая заглушка', () => {
    const bad = calls.filter(c => c.chatIdArg === 'undefined' || c.chatIdArg === 'null' || c.chatIdArg === "''")
    expect(bad.map(c => `${c.method} @ Chat.tsx:${c.line} — chatId = ${c.chatIdArg}`)).toEqual([])
  })
})
