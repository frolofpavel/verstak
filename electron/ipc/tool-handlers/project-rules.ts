// P2 (волна 2.6.0): draft_project_rules — Verstak собирает черновик правил проекта.
//
// ЗАПИСЬ ИДЁТ СУЩЕСТВУЮЩИМ ПУТЁМ. Handler не пишет файл сам, а делегирует общей
// записи: тот же diff перед глазами человека, то же подтверждение, те же гарды
// (write scope, path-policy, запрет на секрето-файлы). Своего окна и своей записи
// здесь нет намеренно — второй путь записи означал бы второй набор гардов,
// который однажды отстанет от первого.
//
// C1 (13.08): отличие ровно одно и оно точечное — diff показывается и в auto.
// Правила проекта меняют ПОВЕДЕНИЕ агента, а не строку кода; auto с 2.6.0
// достаётся новым пользователям по умолчанию, и молчаливая запись правил
// означала бы, что человек узнал о них уже по последствиям.
import type { ToolHandler } from './shared'
import { writeFileConfirmingEvenInAuto } from './file-ops'
import { draftProjectRules } from '../../ai/project-rules-draft'

export const draftProjectRulesHandler: ToolHandler = {
  mode: 'confirm-write',
  async handle(call, ctx) {
    let draft
    try {
      draft = await draftProjectRules(ctx.projectPath)
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: `Не удалось собрать черновик правил: ${err instanceof Error ? err.message : String(err)}` }
    }
    // Существующий файл правил НЕ перезаписываем молча: по умолчанию черновик
    // уходит в отдельный файл-предложение, и человек переносит нужное сам.
    // Прямая правка существующего возможна только явным overwrite:true от
    // модели — то есть осознанным решением, видимым в вызове.
    const overwrite = call.args.overwrite === true
    // C3 (13.08): вторая ветка НЕ мёртвая, хотя приёмка 12.08 записала её мёртвой.
    // ensureUserLayer скаффолдит правила на ОТКРЫТИИ проекта, вызовом `void …
    // .catch(() => {})` — его никто не ждёт, он не повторяется перед вызовом
    // инструмента и может не пройти по правам. Состояние «правил нет» на живом
    // проекте достижимо; ветка — запасной путь, а не остаток. Пины:
    // tests/ipc/project-rules-target.test.ts.
    const targetPath = draft.isProposalToExisting && !overwrite
      ? '.verstak/RULES.draft.md'
      : draft.targetPath
    const notice = draft.isProposalToExisting && !overwrite
      ? `\n\n> Файл ${draft.facts.existingRulesPath} оставлен нетронутым: это отдельный черновик-предложение.\n`
      : ''

    const result = await writeFileConfirmingEvenInAuto(
      { ...call, name: 'write_file', args: { path: targetPath, content: draft.content + notice } },
      ctx,
    )
    if (result.error) return { ...result, id: call.id, name: call.name }
    // Итог называет и путь, и то, чего в черновике НЕТ — иначе человек решит,
    // что отсутствие команды тестов означает «Verstak не нашёл», а не «их нет».
    //
    // C2 (13.08): и НАЙДЕННОЕ тоже, явным перечнем. Раньше итог говорил о
    // командах только в форме «не найдено», а когда не отсутствовало ничего —
    // молчал о них вовсе. Сам черновик уходит в файл, в tool_result его нет, то
    // есть у модели про команды не было НИ ОДНОГО факта — и на месте пробела она
    // досочиняла: живой прогон 12.08 дал «не найдено: build, lint, typecheck»
    // ровно там, где нашлись все четыре. Пробел в результате инструмента модель
    // закрывает догадкой; заполнить его дешевле, чем спорить с пересказом.
    const found = Object.entries(draft.facts.commands).filter(([, v]) => v !== null)
    const missing = Object.entries(draft.facts.commands)
      .filter(([, v]) => v === null)
      .map(([k]) => k)
    return {
      id: call.id,
      name: call.name,
      result: [
        `Черновик правил записан в ${targetPath}.`,
        draft.isProposalToExisting && !overwrite
          ? `Существующий ${draft.facts.existingRulesPath} НЕ тронут — перенесите нужное вручную.`
          : '',
        draft.facts.sources.length ? `Источники фактов: ${draft.facts.sources.join(', ')}.` : 'Источников фактов в корне не нашлось.',
        found.length
          ? `Найдено в проекте и записано в черновик: ${found.map(([k, v]) => `${k} — ${v}`).join(', ')}.`
          : 'Команд в проекте не нашлось ни одной.',
        missing.length
          ? `Не найдено в проекте (в черновике так и записано): ${missing.join(', ')}.`
          : 'Не найденных команд нет — нашлись все четыре.',
      ].filter(Boolean).join(' '),
    }
  },
}
