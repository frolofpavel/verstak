/**
 * Максимальные контекстные окна для каждой модели.
 * Используется авто-компакшном (auto-compact) для определения момента сжатия.
 *
 * Принцип: если нет точного совпадения — используем консервативный дефолт 128k.
 * Это безопасно: лучше сжать чуть раньше, чем словить ошибку провайдера.
 */

import { getRegisteredContextLimit } from './model-registry'

export const CONTEXT_LIMITS: Record<string, number> = {
  // Gemini
  'gemini-3-pro': 1_000_000,
  'gemini-3.5-flash': 1_000_000,
  'gemini-3-flash': 1_000_000,
  'gemini-2.5-pro': 1_000_000,
  'gemini-2.5-flash': 1_000_000,
  // Claude
  'claude-sonnet-4-6': 200_000,
  'claude-opus-4-5': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5': 200_000,
  // Grok
  'grok-4.5': 500_000,
  // OpenAI
  'gpt-5': 200_000,
  'gpt-5-mini': 200_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'o1': 200_000,
  'o1-mini': 128_000,
  // DeepSeek V4 — 1M context (api-docs.deepseek.com/quick_start/pricing). Legacy-алиасы тоже на V4.
  'deepseek-v4-flash': 1_000_000,
  'deepseek-v4-pro': 1_000_000,
  'deepseek-chat': 1_000_000,
  'deepseek-reasoner': 1_000_000,
  // Moonshot Kimi (platform.kimi.ai/docs/models.md)
  'kimi-k2.7-code': 256_000,
  'kimi-k2.6': 256_000,
  'kimi-k2.5': 256_000,
  'moonshot-v1-128k': 128_000,
  'moonshot-v1-32k': 32_000,
  'moonshot-v1-8k': 8_000,
  // Qwen / DashScope (alibabacloud.com/help/en/model-studio)
  'qwen3-max': 256_000,
  'qwen3-coder-plus': 256_000,
  'qwen3-coder-flash': 256_000,
  'qwen-max': 32_000,
  'qwen-plus': 128_000,
  'qwen-flash': 1_000_000,
  // Mistral
  'mistral-large-latest': 128_000,
  'mistral-small-latest': 32_000,
  'codestral-latest': 32_000,
  'ministral-8b-latest': 128_000,
  // Groq (лимиты сервиса, не модели)
  'llama-3.3-70b-versatile': 128_000,
  'llama-3.1-8b-instant': 128_000,
  'mixtral-8x7b-32768': 32_768,
  'gemma2-9b-it': 8_192,
}

/** ~4 симв. на токен — грубая оценка без токенизатора. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Возвращает лимит контекста для модели (с консервативным дефолтом). */
export function getContextLimit(model: string): number {
  return CONTEXT_LIMITS[model] ?? getRegisteredContextLimit(model) ?? 128_000
}

/** Порог авто-компакшна — 95% контекстного окна. */
export const COMPACT_THRESHOLD = 0.95
