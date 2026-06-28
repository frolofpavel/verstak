// Connector-хендлеры: list_connectors / connector_query. Вынесено при распиле.
import type { ToolHandler } from './shared'
import { emitActivity, awaitCommandConfirm } from './shared'
import { scanText, isForbiddenPath } from '../../ai/secret-scanner'
import { safeRealJoin } from '../../ai/path-policy'
import { relative, resolve, isAbsolute } from 'path'
import { decide, blockReason } from '../../ai/mode-policy'
import { isReadOnlyConnectorOp } from '../../ai/connector-readonly'
import { summarizeToolCall } from './shared'

export const listConnectorsHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    const list = ctx.connectors.list()
    const result = JSON.stringify(list)
    const s = summarizeToolCall(call.name, call.args, result)
    if (s) emitActivity(ctx, call, 'ok', s.label, s.detail)
    return { id: call.id, name: call.name, result }
  }
}

export const connectorQueryHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const cid = String(call.args.id ?? '')
      if (!cid) {
        return { id: call.id, name: call.name, result: '', error: 'connector_query: id обязателен' }
      }
      // NL-cron: unattended-прогон читает внешние данные, но НЕ пишет/выполняет. Гейтим
      // op по kind через op-level политику (fail-safe). ssh run_remote / telegram send /
      // вебхуки → запрет без надзора. Read-op'ы (Ozon/WB/Метрика-данные) проходят.
      if (ctx.readOnlyConnectors) {
        const kind = ctx.connectors.list().find(c => c.id === cid)?.kind ?? ''
        if (!isReadOnlyConnectorOp(kind, call.args as Record<string, unknown>)) {
          return { id: call.id, name: call.name, result: '', error: `Расписанный (unattended) прогон: коннектор "${cid}" (${kind || 'неизвестный'}) с этой операцией запрещён — без надзора разрешено только чтение данных, не отправка/выполнение.` }
        }
      }
      // Mode policy: коннекторы трогают внешние системы (SSH, HTTP POST, Telegram,
      // публикация), поэтому гейтятся как команда — plan блокирует, ask подтверждает,
      // auto/bypass авто-принимают. Описание запроса показываем пользователю в модалке.
      const entity = call.args.entity ? ` · ${call.args.entity}` : ''
      const path = call.args.path ? ` · ${call.args.path}` : ''
      const summary = `Коннектор ${cid}${entity}${path}`
      const decision = decide('connector_query', ctx.agentMode)
      if (decision === 'block') {
        const reason = blockReason('connector_query', ctx.agentMode)
        ctx.sender.send('ai:event', {
          id: ctx.sendId,
          event: { type: 'tool-blocked', callId: call.id, name: 'connector_query', command: summary, reason }
        })
        return { id: call.id, name: call.name, result: '', error: reason }
      }
      let accepted: boolean
      if (decision === 'auto-accept') {
        accepted = true
      } else {
        // 'confirm' — переиспользуем pending-command поток (та же модалка подтверждения)
        ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'pending-command', callId: call.id, command: summary } })
        accepted = await awaitCommandConfirm(ctx, call.id)
      }
      if (!accepted) {
        ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'command-result', callId: call.id, command: summary, status: 'rejected' } })
        return { id: call.id, name: call.name, result: summary, error: 'User rejected' }
      }
      const { id: _omit, ...rest } = call.args as Record<string, unknown> & { id?: unknown }
      void _omit
      // Я.Диск upload читает локальный файл по local_path. Без guard'а агент мог
      // выгрузить ЛЮБОЙ файл системы (включая .env/.ssh/creds) в облако клиента.
      // Загоняем local_path в границы проекта (тем же safeRealJoin, что и tools),
      // отсекаем выход за корень и секретные файлы. Артефакты в
      // {project}/.verstak/artifacts проходят автоматически — они внутри корня.
      if (cid === 'yandex_disk' && rest.local_path != null) {
        if (!ctx.projectPath) {
          return { id: call.id, name: call.name, result: '', error: 'Я.Диск upload запрещён без открытого проекта' }
        }
        const lp = String(rest.local_path)
        const relCheck = relative(ctx.projectPath, resolve(ctx.projectPath, lp))
        if (relCheck.startsWith('..') || isAbsolute(relCheck)) {
          return { id: call.id, name: call.name, result: '', error: 'Я.Диск upload: путь вне проекта запрещён' }
        }
        const safe = await safeRealJoin(ctx.projectPath, lp)  // бросит при symlink-escape
        if (isForbiddenPath(relative(ctx.projectPath, safe))) {
          return { id: call.id, name: call.name, result: '', error: 'Я.Диск upload: секретные файлы (.env/.key/creds) запрещены' }
        }
        rest.local_path = safe
      }
      // Аудит B4: у коннекторов нет собственного таймаута — зависший хост
      // (медленный 1С / упавший OAuth-endpoint) повесил бы весь agent-loop до
      // ручного Stop. Комбинируем ctx.signal (ручной Stop / отмена роя) с
      // 30-секундным таймаутом запроса. Чинит все 31 коннектора разом.
      const connAc = new AbortController()
      const onParentAbort = () => connAc.abort()
      const connTimeout = setTimeout(() => connAc.abort(), 30_000)
      ctx.signal.addEventListener('abort', onParentAbort, { once: true })
      if (ctx.signal.aborted) connAc.abort()
      let result: unknown
      try {
        result = await ctx.connectors.query(cid, rest, connAc.signal)
      } catch (e) {
        if (connAc.signal.aborted && !ctx.signal.aborted) {
          return { id: call.id, name: call.name, result: '', error: `Коннектор ${cid}: таймаут запроса (30с) — хост не ответил` }
        }
        throw e
      } finally {
        clearTimeout(connTimeout)
        ctx.signal.removeEventListener('abort', onParentAbort)
      }
      const s = summarizeToolCall(call.name, call.args, undefined)
      if (s) emitActivity(ctx, call, 'ok', s.label, s.detail)
      // Journal connector queries
      try {
        const entity = call.args.entity ? ` · ${call.args.entity}` : ''
        const path = call.args.path ? ` · ${call.args.path}` : ''
        ctx.recordJournal(ctx.projectPath, 'tool', `Коннектор ${cid}${entity}${path}`, null)
      } catch { /* journal not critical */ }
      // Аудит M2: тело коннектора и его ошибки могут содержать эхо токена
      // (многие API отражают auth-параметр). scanText — последний рубеж перед
      // тем, как результат уйдёт в контекст модели и transcript.
      const rawResult = typeof result === 'string' ? result : JSON.stringify(result)
      return { id: call.id, name: call.name, result: scanText(rawResult).redacted }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const safeMsg = scanText(msg).redacted
      emitActivity(ctx, call, 'error', call.name, safeMsg)
      try { ctx.recordJournal(ctx.projectPath, 'tool', `Коннектор упал: ${String(call.args.id ?? '?')}`, safeMsg) } catch { /* journal not critical */ }
      return { id: call.id, name: call.name, result: '', error: safeMsg }
    }
  }
}
