// File-хендлеры: read / write_file / apply_patch / propose_edits + diffConfirmWrite. Вынесено при распиле.
import type { ToolHandler, ToolContext } from './shared'
import type { ToolCall, ToolResult } from '../../ai/types'
import { emitActivity, summarizeToolCall } from './shared'
import { existsSync } from 'fs'
import { isAbsolute, join } from 'path'
import { randomUUID } from 'crypto'
import { blockReason } from '../../ai/mode-policy'
import { resolveDecision } from '../../ai/permission-rules'
import { applySearchReplaceBlocks } from '../../ai/tools'
import { markFileDirty } from '../../ai/project-map'
import { decideWriteScope } from '../../ai/write-scope'
import { maskSecretsForDiff, scanText } from '../../ai/secret-scanner'

export const readHandler: ToolHandler = {
  mode: 'parallel-read',
  async handle(call, ctx) {
    try {
      const result = await ctx.tools.execute(call.name, call.args)
      const s = summarizeToolCall(call.name, call.args, result)
      if (s) emitActivity(ctx, call, 'ok', s.label, s.detail)
      return { id: call.id, name: call.name, result }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

/**
 * Хендлер НЕИЗВЕСТНОГО инструмента (2.0.7-G). Раньше lookupHandler отдавал generic
 * readHandler ЛЮБОМУ незарегистрированному имени. Главная опасность была НЕ в
 * «галлюцинированном» имени (для него ctx.tools.execute и так кидает ошибку), а в тулзе,
 * чья реализация в execute СУЩЕСТВУЕТ, но которая выпала из HANDLER_REGISTRY: напр.
 * write_file/apply_patch реально пишут файл, и generic readHandler молча понижал их до
 * parallel-read, ОБХОДЯ mode-policy/confirm write-хендлеров. Теперь такой (и любой
 * неизвестный) вызов ОТКЛОНЯЕТСЯ со структурной ошибкой, ничего не исполняя. mode
 * parallel-read — чтобы отказ не тянул confirm-модалку; сам handle не читает и не пишет.
 */
export const unknownToolHandler: ToolHandler = {
  mode: 'parallel-read',
  async handle(call, ctx) {
    const msg = `Неизвестный инструмент «${call.name}»: не зарегистрирован и не входит в audited read-allowlist — вызов отклонён.`
    emitActivity(ctx, call, 'error', call.name, msg)
    return { id: call.id, name: call.name, result: '', error: msg }
  }
}

// ============================================================================
// File ops: write_file, apply_patch, propose_edits
// ============================================================================

/**
 * opts.alwaysConfirm — ТОЧЕЧНОЕ исключение для записи, которая меняет не код, а
 * ПОВЕДЕНИЕ агента (сегодня один вход: draft_project_rules). Оно умеет ровно
 * одно: понизить `auto-accept` до `confirm`. Ни `block` не ослабляет, ни правила
 * permissions не обходит — путь для обычных правок остаётся тем же.
 *
 * `bypass` не трогаем сознательно, тем же доводом, что и в resolveDecision:
 * этот режим по определению «никаких диалогов», человек выбирает его осознанно.
 * Чинить надо `auto` — он с 2.6.0 достаётся новым пользователям по умолчанию,
 * то есть НЕ выбран, а получен.
 */
async function diffConfirmWrite(call: ToolCall, ctx: ToolContext, path: string, before: string, after: string, permissionName?: string, opts?: { alwaysConfirm?: boolean }): Promise<ToolResult> {
  // Durable Agent Job scope — серверный инвариант поверх режима и permission rules.
  // Даже bypass/auto-accept не может записать за пределы job.writeScope.
  if (ctx.parentJobId && ctx.agentJobs) {
    const job = ctx.agentJobs.get(ctx.parentJobId)
    if (!job) {
      return { id: call.id, name: call.name, result: '', error: 'Agent Job не найдена: запись безопасно остановлена.' }
    }
    const scope = decideWriteScope(path, job.writeScope)
    if (!scope.allowed) {
      try {
        ctx.agentJobs.transition(job.id, {
          status: 'waiting-approval',
          waitingReason: scope.reason ?? 'write-scope-expansion',
        })
      } catch { /* late/cancelled job: сам write всё равно блокируется */ }
      return { id: call.id, name: call.name, result: '', error: scope.reason ?? 'Запись вне write scope.' }
    }
  }
  // Anti-redacted-writeback. Модель видит файл через read_file, то есть с
  // `[REDACTED:…]` вместо секретов. Инструмент, отдающий файл ЦЕЛИКОМ, собирает
  // содержимое из этого вида — и перезапись затёрла бы реальные значения. У
  // apply_patch проблемы нет: его SEARCH/REPLACE ложится на сырое «до», блок с
  // заглушкой просто не найдёт совпадения и будет отвергнут штатной ошибкой
  // поиска. Поэтому условие — «пишет файл целиком», а не имя конкретной тулзы:
  // propose_edits НЕ проходит через writeFileHandler, он собирает синтетические
  // write_file-вызовы и зовёт diffConfirmWrite напрямую, так что гард в
  // обработчике закрыл бы один вход из двух.
  //
  // Проверяем СЫРОЕ «до» сканером, а не наличие подстроки `[REDACTED:` — «до»
  // теперь настоящее, и заглушек в нём нет по построению.
  if (call.name !== 'apply_patch') {
    const scan = scanText(before)
    if (scan.hits.length > 0) {
      return {
        id: call.id,
        name: call.name,
        result: '',
        error: `${call.name} заблокирован: файл содержит секреты (${scan.hits.join(', ')}), а модель видит их как [REDACTED:...] — полная перезапись затёрла бы реальные значения. Используй apply_patch: точечная правка ложится на настоящее содержимое и секрет не трогает.`
      }
    }
  }
  // permissionName — ИСХОДНОЕ имя тула для permission-правил. propose_edits фанит
  // правки в синтетические write_file-subCall'ы; без этого deny/ask на Edit/
  // propose_edits молча игнорировались бы (ревью: правило обходится). Исполнение
  // всё равно идёт как write_file, но решение резолвится по исходному имени.
  const decisionName = permissionName ?? call.name
  const { decision, reason } = resolveDecision(decisionName, call.args, ctx.agentMode, ctx.autoApprove, ctx.permissionRules)
  if (decision === 'block') {
    return { id: call.id, name: call.name, result: '', error: reason ?? blockReason(decisionName, ctx.agentMode) }
  }
  let accepted: boolean
  const forceConfirm = opts?.alwaysConfirm === true && ctx.agentMode !== 'bypass'
  if (decision === 'auto-accept' && !forceConfirm) {
    // Skip user prompt — still surface the diff via tool-activity for visibility
    ctx.sender.send('ai:event', {
      id: ctx.sendId,
      event: { type: 'tool-activity', callId: call.id, name: call.name, label: `${call.name} (авто)`, detail: path, status: 'ok' }
    })
    accepted = true
  } else {
    // 'confirm' — show diff modal and wait. Ожидание привязано к ctx.signal:
    // для суба это taskAc.signal (per-task таймаут/отмена), для главного агента —
    // ctrl.signal. Раньше Promise не слушал abort → суб-executor с write в
    // ask-режиме висел, и per-task таймаут его не разрывал (до 50 модалок).
    // ЕДИНСТВЕННАЯ точка, где содержимое файла покидает main, — поэтому маска
    // подставляется В САМО СОБЫТИЕ, а не перед отрисовкой диффа.
    //
    // Маска в renderer НЕ ЗАКРЫЛА БЫ этот путь, и это не осторожность, а
    // трассировка (29.07): `src/App.tsx` форвардит КАЖДОЕ событие прогона,
    // запущенного с телефона, целиком — `window.api.mobile.sendRunEvent(id,
    // event)` → `mobile:run-event` (main.ts) → `mobileBridge.emit('run.event')`
    // → HTTP POST на внешний relay. То есть `before`/`after` УХОДЯТ С МАШИНЫ ПО
    // СЕТИ, когда заданы VERSTAK_MOBILE_RELAY_URL/TOKEN. Сырое содержимое здесь
    // означало бы отправку живых секретов пользователя на чужой сервер.
    //
    // Renderer и без моста тот периметр, откуда содержимое утекает наружу:
    // запись экрана, демонстрация, RDP, DevTools и DOM, буфер обмена.
    //
    // В событие уходит маска: тип секрета, отпечаток и что с ним происходит —
    // добавлен / изменён / удалён / без изменений. Сырое `before`/`after` живёт
    // только внутри main и только для двух дел: записи на диск и записи в стек
    // отката.
    const shown = maskSecretsForDiff(before, after)
    ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'pending-write', callId: call.id, path, before: shown.before, after: shown.after } })
    const key = ctx.scopedKey(ctx.sendId, call.id)
    accepted = await new Promise<boolean>(resolve => {
      let settled = false
      const finish = (v: boolean) => {
        if (settled) return  // guard от двойного resolve (abort + ai:resolve-write)
        settled = true
        ctx.pendingWrites.delete(key)
        ctx.signal.removeEventListener('abort', onAbort)
        resolve(v)
      }
      // Таймаут/отмена субзадачи (или родителя) → трактуем как reject.
      const onAbort = () => finish(false)
      ctx.pendingWrites.set(key, { sendId: ctx.sendId, resolve: finish })
      if (ctx.signal.aborted) { onAbort(); return }
      ctx.signal.addEventListener('abort', onAbort, { once: true })
    })
  }
  if (!accepted) {
    return { id: call.id, name: call.name, result: `User rejected write to ${path}`, error: 'User rejected' }
  }
  // Существовал ли файл ДО записи: для undo важно отличать «файла не было»
  // (revert → unlink) от «был, но пустой» (revert → восстановить пустым). Иначе
  // before='' для существующего пустого файла трактовался как «не было» и revert
  // удалял его (B4). null = не существовал, '' = существовал пустым.
  const isExternalWrite = isAbsolute(path)
  const physicalPath = isExternalWrite ? path : join(ctx.projectPath, path)
  const existedBefore = existsSync(physicalPath)
  try {
    await ctx.tools.execute('write_file', { path, content: after })
    if (!isExternalWrite) {
      // 2.0.11-E: провенанс отката — какой прогон менял файл. runId из контекста;
      // chatId/messageId в ToolContext не носятся (пока), остаются null. По runId
      // rewindCoverage отличит трассируемую правку от непротрассированной.
      try { ctx.recordWrite(ctx.projectPath, path, existedBefore ? before : null, after, { runId: ctx.runId ?? null }) } catch { /* undo not critical */ }
      // Incremental project map update — mark file dirty instead of full rebuild
      markFileDirty(ctx.projectPath, join(ctx.projectPath, path))
    }
    // Timeline задачи (Фаза 4): принятая запись файла. ref/label = путь (панель
    // строит секцию «Файлы» из событий file_write). best-effort.
    try { ctx.recordRunEvent?.('file_write', { label: path, ref: path, status: 'ok' }) } catch { /* best-effort */ }
    return { id: call.id, name: call.name, result: `Applied ${call.name === 'apply_patch' ? 'patch' : 'write'} to ${path}` }
  } catch (err) {
    return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Исходное состояние файла для пути записи — СЫРОЕ, минуя read_file.
 *
 * read_file отдаёт содержимое, пропущенное через scanText: секреты заменены на
 * `[REDACTED:…]`. Для контекста модели это правильно, для пути записи — нет: то
 * же содержимое ложилось в стек отката, и кнопка «откатить» писала на диск
 * заглушку ВМЕСТО живого секрета. Не утечка, а уничтожение данных — затёртое
 * значение восстановить неоткуда.
 *
 * Сырое «до» не покидает main: в файл и в откат идёт оно, в renderer —
 * маска (см. diffConfirmWrite), модели — ничего.
 */
async function readBeforeContent(ctx: ToolContext, path: string): Promise<string> {
  try {
    return await ctx.tools.readRaw(path)
  } catch { return '' }
}

export const writeFileHandler: ToolHandler = {
  mode: 'confirm-write',
  async handle(call, ctx) {
    const path = String(call.args.path)
    const before = await readBeforeContent(ctx, path)
    const after = String(call.args.content ?? '')
    return diffConfirmWrite(call, ctx, path, before, after)
  }
}

/**
 * Запись файла ТЕМ ЖЕ путём, но с обязательным показом diff в auto (C1, 13.08).
 *
 * Единственный потребитель — draft_project_rules. Правила проекта это мета-файл о
 * поведении агента: приняв их молча, человек узнаёт о новых правилах уже по факту
 * их действия. Живая приёмка 12.08 показала, что заголовочное «черновик показан
 * до записи» держалось только в ask, а auto с 2.6.0 — дефолт новых пользователей.
 *
 * Отдельного пути записи здесь нет намеренно: те же гарды, тот же diff, тот же
 * откат — отличается ровно одно решение (см. diffConfirmWrite, opts.alwaysConfirm).
 */
export async function writeFileConfirmingEvenInAuto(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const path = String(call.args.path)
  const before = await readBeforeContent(ctx, path)
  const after = String(call.args.content ?? '')
  return diffConfirmWrite(call, ctx, path, before, after, undefined, { alwaysConfirm: true })
}

export const applyPatchHandler: ToolHandler = {
  mode: 'confirm-write',
  async handle(call, ctx) {
    const path = String(call.args.path)
    // Гарда здесь больше нет и он не нужен: «до» сырое, патч ложится на
    // настоящий текст. SEARCH-блок, собранный поверх `[REDACTED:…]`, просто не
    // найдёт совпадения и будет отвергнут штатной ошибкой поиска ниже. Заодно
    // перестали быть нередактируемыми полтора десятка исходников, которые сканер
    // считает секретными ошибочно — там, где auth-слово стоит рядом с длинным
    // значением обычного кода (реестр провайдеров, делегирование). Общий гард на
    // запись файла ЦЕЛИКОМ — в diffConfirmWrite.
    //
    // ПРИМЕРА такой строки здесь намеренно НЕТ: он сработал бы сам и запер этот
    // файл для write_file. Живой перечень снимается прогоном scanText по
    // electron/ и src/.
    const before = await readBeforeContent(ctx, path)
    const anchorHash = call.args.anchor_hash ? String(call.args.anchor_hash) : undefined
    let after: string
    try {
      after = applySearchReplaceBlocks(before, String(call.args.diff ?? ''), anchorHash)
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
    return diffConfirmWrite(call, ctx, path, before, after)
  }
}

interface ProposeEdit { path: string; content: string; reason?: string }

export const proposeEditsHandler: ToolHandler = {
  mode: 'confirm-write',
  async handle(call, ctx) {
    const rawEdits = Array.isArray(call.args.edits) ? call.args.edits : []
    const edits: ProposeEdit[] = rawEdits
      .filter((e: unknown): e is Record<string, unknown> => typeof e === 'object' && e !== null)
      .map((e) => ({
        path: String((e as Record<string, unknown>).path ?? ''),
        content: String((e as Record<string, unknown>).content ?? ''),
        reason: (e as Record<string, unknown>).reason != null ? String((e as Record<string, unknown>).reason) : undefined
      }))
      .filter(e => e.path.length > 0)
    if (edits.length === 0) {
      return { id: call.id, name: call.name, result: '', error: 'propose_edits: no edits in batch' }
    }
    // Fan out: one synthetic confirm-write per edit. They all hit the same
    // multi-file modal (renderer accumulates pending writes).
    const subResults: ToolResult[] = []
    for (const edit of edits) {
      const subId = `${call.id}::${randomUUID()}`
      const before = await readBeforeContent(ctx, edit.path)
      const subCall: ToolCall = {
        id: subId,
        name: 'write_file',
        args: { path: edit.path, content: edit.content },
        ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {})
      }
      const r = await diffConfirmWrite(subCall, ctx, edit.path, before, edit.content, 'propose_edits')
      subResults.push(r)
    }
    const ok = subResults.filter(r => !r.error).length
    const total = subResults.length
    // #12: принятые файлы — структурно (filesWritten), чтобы agent-loop добавил
    // их в filesTouched для attest-сверки claimed-vs-actual. Текст "Applied ok/total"
    // не давал per-file accept (частичный accept структурно не виден).
    const filesWritten = edits.filter((_e, i) => !subResults[i].error).map(e => e.path)
    return {
      id: call.id,
      name: call.name,
      result: `Applied ${ok}/${total} edits. ${subResults.map(r => r.error ? `✗ ${r.error}` : `✓ ${r.result}`).join('; ')}`,
      ...(filesWritten.length ? { filesWritten } : {}),
      ...(ok === 0 ? { error: 'All edits rejected or failed' } : {})
    }
  }
}
