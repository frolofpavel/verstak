/**
 * Tool-mode профиль модели — минимальное знание «как эта модель обращается с
 * инструментами». В проекте такого слоя не было: openai-compat одинаково шлёт
 * native `tools` всем, а слабые/reasoning-модели их игнорируют → агент молча
 * отвечает прозой и цикл завершается «готово», ничего не сделав (симптом
 * DeepSeek reasoner / локального Ollama).
 *
 * Чистая логика, без side-effects. Расширяет поведение существующего цикла
 * (ipc/ai.ts) и опирается на уже готовый parseTextToolCalls (tool-call-repair).
 * НЕ переписывает provider-слой.
 *
 *  - 'native' — модель надёжно шлёт structured `tool_calls` (frontier + большинство
 *               OpenAI-compat: deepseek-chat/v4, qwen3-coder, kimi, mistral, groq).
 *  - 'json'   — native tool-calling нестабилен/отсутствует → просим модель отдавать
 *               вызов ТЕКСТОМ как <tool_call>{…}</tool_call>, ловим через repair
 *               (reasoning-модели без function calling, локальный Ollama).
 */

export type ToolMode = 'native' | 'json'

/** Провайдеры, которым native tool-calling НЕ гарантирован — под них включаем
 *  corrective-nudge при «модель ушла в текст, не вызвав тулзу». Frontier
 *  (claude/openai/gemini/grok) и RU (yandex/gigachat) исполняют надёжно —
 *  им nudge не нужен (ложные срабатывания на обычном Q&A-ответе). */
const COAXABLE_PROVIDERS = new Set<string>([
  'deepseek', 'qwen', 'moonshot', 'mistral', 'groq',
  'openrouter', 'ollama', 'custom-openai',
])

/** true — провайдер из «слабого» класса, где модель склонна описывать действие
 *  прозой вместо вызова инструмента. Гейтит corrective-retry в agent loop. */
export function isCoaxableProvider(providerId?: string): boolean {
  return providerId ? COAXABLE_PROVIDERS.has(providerId) : false
}

/**
 * Как модель обращается с инструментами. Консервативно: по умолчанию 'native'
 * (поведение не меняется для существующих провайдеров). 'json' только для
 * reasoning-моделей без function calling и локального Ollama.
 */
export function resolveToolMode(providerId?: string, model?: string): ToolMode {
  const m = (model ?? '').toLowerCase()
  // DeepSeek reasoner / R1 и прочие reasoning-алиасы не поддерживают native
  // function calling через OpenAI-compat — сервер игнорирует `tools`.
  if (/reasoner/.test(m)) return 'json'
  if (/(^|[^a-z0-9])r1([^a-z0-9]|$)/.test(m)) return 'json'
  // Локальные сборки (Ollama) — native tool_calls часто не реализованы.
  if (providerId === 'ollama') return 'json'
  return 'native'
}

/** Инструкция для 'json'-режима: как отдавать вызов инструмента текстом.
 *  Формат совпадает с тем, что уже распознаёт parseTextToolCalls (tool-call-repair). */
export const JSON_TOOL_INSTRUCTION = [
  '<!-- tool_mode:json -->',
  'ВАЖНО про инструменты: эта модель может не поддерживать структурный вызов инструментов.',
  'Когда нужно вызвать инструмент — выведи ТОЛЬКО такой блок (без прозы вокруг):',
  '<tool_call>{"name":"ИМЯ_ИНСТРУМЕНТА","arguments":{…}}</tool_call>',
  'Имя должно быть из списка доступных инструментов. Не описывай действие словами — вызывай инструмент этим блоком. Когда задача выполнена — напиши обычный текстовый ответ без tool_call.',
].join('\n')

/** Corrective-nudge: модель ответила прозой и не вызвала ни одного инструмента,
 *  хотя задача агентная. Один раз просим либо явно завершить, либо вызвать тул. */
export const IGNORED_TOOLS_NUDGE = [
  'Ты не вызвал ни одного инструмента и ответил только текстом.',
  'Если задача ВЫПОЛНЕНА — подтверди это одной короткой строкой.',
  'Если НЕТ — вызови нужный инструмент (read_file / write_file / apply_patch / run_command и т.п.), а не описывай действие словами.',
].join('\n')
