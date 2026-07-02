// Memory-хендлеры: memory_save/search + core_memory_*. Вынесено при распиле.
import type { ToolHandler } from './shared'
import { emitActivity } from './shared'
import { scanText } from '../../ai/secret-scanner'

export const memorySaveHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const type = String(call.args.type ?? '')
      // Редакция секретов ДО записи (ревью HIGH): агентский content оседает в памяти и
      // всплывает в system prompt другого чата/провайдера. Симметрично session-summary/auto-capture.
      const content = scanText(String(call.args.content ?? '').trim()).redacted
      const tags = Array.isArray(call.args.tags) ? call.args.tags.map(String) : []
      if (!content) {
        return { id: call.id, name: call.name, result: '', error: 'memory_save: content обязателен' }
      }
      const memory = ctx.saveMemory(ctx.projectPath, type, content, tags)
      emitActivity(ctx, call, 'ok', 'memory_save', `${type} · ${content.slice(0, 60)}`)
      return { id: call.id, name: call.name, result: `Сохранено: ${memory.id}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

/** memory_invalidate (ось 4 #2) — пометить устаревший/опровергнутый факт суперсеженным
 *  (soft, не удаляя). Агент сам реконсилирует: memory_search → если новый факт
 *  противоречит/обновляет старый, invalidate(old, superseded_by=new). История сохраняется. */
export const memoryInvalidateHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const id = String(call.args.id ?? '').trim()
      if (!id) return { id: call.id, name: call.name, result: '', error: 'memory_invalidate: id обязателен' }
      if (!ctx.invalidateMemory) return { id: call.id, name: call.name, result: '', error: 'memory_invalidate недоступен' }
      const supersededBy = call.args.superseded_by ? String(call.args.superseded_by) : null
      const ok = ctx.invalidateMemory(id, supersededBy)
      emitActivity(ctx, call, ok ? 'ok' : 'error', 'memory_invalidate', `${id}${supersededBy ? ` → ${supersededBy}` : ''}`)
      return ok
        ? { id: call.id, name: call.name, result: `Воспоминание ${id} помечено устаревшим${supersededBy ? ` (заменено ${supersededBy})` : ''}. Из recall выпало, история сохранена.` }
        : { id: call.id, name: call.name, result: '', error: `Воспоминание ${id} не найдено или уже устаревшее.` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

/** save_decision — пишет структурированное Decision Record в Decision Memory
 *  (project-brain decision_record). Питает AI-штаб (/board) и будущий UI решений. */
export const saveDecisionHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const a = call.args
      const title = String(a.title ?? '').trim()
      const decision = String(a.decision ?? '').trim()
      if (!title || !decision) {
        return { id: call.id, name: call.name, result: '', error: 'save_decision: title и decision обязательны' }
      }
      const strArr = (v: unknown): string[] => Array.isArray(v) ? v.map(String).filter(Boolean) : []
      const conf = a.confidence === 'low' || a.confidence === 'medium' || a.confidence === 'high' ? a.confidence : null
      const revisitDays = typeof a.revisit_days === 'number' && a.revisit_days > 0 ? a.revisit_days : null
      const saved = ctx.saveDecision(ctx.projectPath, {
        sourceMessageId: null,
        title,
        userRequest: a.user_request ? String(a.user_request) : null,
        finalDecision: decision,
        why: a.why ? String(a.why) : null,
        keyArguments: strArr(a.key_arguments),
        objections: strArr(a.objections),
        risks: strArr(a.risks),
        alternativesRejected: strArr(a.alternatives_rejected),
        nextActions: strArr(a.next_actions),
        confidence: conf,
        revisitDate: revisitDays ? Date.now() + revisitDays * 86_400_000 : null,
      })
      emitActivity(ctx, call, 'ok', 'save_decision', title.slice(0, 60))
      return { id: call.id, name: call.name, result: `Решение сохранено в Decision Memory (#${saved.id}): ${title}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

export const memorySearchHandler: ToolHandler = {
  mode: 'parallel-read',
  async handle(call, ctx) {
    try {
      const query = String(call.args.query ?? '').trim()
      const limit = typeof call.args.limit === 'number' ? Math.max(1, Math.min(20, Math.floor(call.args.limit))) : 5
      const results = ctx.searchMemories(ctx.projectPath, query, limit)
      emitActivity(ctx, call, 'ok', 'memory_search', `"${query}" · ${results.length} результатов`)
      if (results.length === 0) {
        return { id: call.id, name: call.name, result: 'Ничего не найдено.' }
      }
      return { id: call.id, name: call.name, result: JSON.stringify(results, null, 2) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

// ============================================================================
// Core Memory: core_memory_append / core_memory_replace / core_memory_remove
// ============================================================================

export const coreMemoryAppendHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const { appendCoreMemory } = await import('../../ai/core-memory')
      const block = String(call.args.block ?? '')
      const content = String(call.args.content ?? '').trim()
      if (block !== 'memory' && block !== 'user') {
        return { id: call.id, name: call.name, result: '', error: 'core_memory_append: block должен быть "memory" или "user"' }
      }
      if (!content) {
        return { id: call.id, name: call.name, result: '', error: 'core_memory_append: content обязателен' }
      }
      // При переполнении эвакуируем старейшее в архивную память (не теряем факты).
      // БЕЗ swallow-catch: если saveMemory кинул (SQLITE_BUSY/shutdown), ошибка всплывает
      // ДО обрезки core-файла (архив-первым в appendCoreMemory) → факт остаётся в core,
      // внешний catch вернёт агенту ошибку. Глотание здесь = молчаливая потеря (ревью HIGH).
      const res = appendCoreMemory(ctx.projectPath, block, content, (evacuated) => {
        ctx.saveMemory(ctx.projectPath, 'fact', `Вытеснено из core-memory (${block}): ${evacuated}`, ['core-evicted', block])
      })
      const overflowNote = res.overflow ? ' (старейшее вытеснено в архивную память)' : ''
      emitActivity(ctx, call, 'ok', 'core_memory_append', `${block} · +${content.length} символов${overflowNote}`)
      return { id: call.id, name: call.name, result: `Добавлено в ${block}${overflowNote}.\n\nТекущее содержимое:\n${res.content}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

export const coreMemoryReplaceHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const { replaceCoreMemory } = await import('../../ai/core-memory')
      const block = String(call.args.block ?? '')
      const oldText = String(call.args.old_text ?? '')
      const newText = String(call.args.new_text ?? '')
      if (block !== 'memory' && block !== 'user') {
        return { id: call.id, name: call.name, result: '', error: 'core_memory_replace: block должен быть "memory" или "user"' }
      }
      if (!oldText) {
        return { id: call.id, name: call.name, result: '', error: 'core_memory_replace: old_text обязателен' }
      }
      const res = replaceCoreMemory(ctx.projectPath, block, oldText, newText)
      if (!res.success) {
        return { id: call.id, name: call.name, result: '', error: `core_memory_replace: фрагмент не найден в ${block}. Текущее содержимое:\n${res.content}` }
      }
      emitActivity(ctx, call, 'ok', 'core_memory_replace', `${block} · замена ${oldText.length} → ${newText.length} символов`)
      return { id: call.id, name: call.name, result: `Обновлено в ${block}.\n\nТекущее содержимое:\n${res.content}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

export const coreMemoryRemoveHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const { removeCoreMemory } = await import('../../ai/core-memory')
      const block = String(call.args.block ?? '')
      const text = String(call.args.text ?? '')
      if (block !== 'memory' && block !== 'user') {
        return { id: call.id, name: call.name, result: '', error: 'core_memory_remove: block должен быть "memory" или "user"' }
      }
      if (!text) {
        return { id: call.id, name: call.name, result: '', error: 'core_memory_remove: text обязателен' }
      }
      const res = removeCoreMemory(ctx.projectPath, block, text)
      if (!res.success) {
        return { id: call.id, name: call.name, result: '', error: `core_memory_remove: фрагмент не найден в ${block}. Текущее содержимое:\n${res.content}` }
      }
      emitActivity(ctx, call, 'ok', 'core_memory_remove', `${block} · удалено ${text.length} символов`)
      return { id: call.id, name: call.name, result: `Удалено из ${block}.\n\nТекущее содержимое:\n${res.content}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}
