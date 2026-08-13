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
        missing.length ? `Не найдено в проекте (в черновике так и записано): ${missing.join(', ')}.` : '',
      ].filter(Boolean).join(' '),
    }
  },
}
