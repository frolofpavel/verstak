import OpenAI from 'openai'
import type { ChatProvider, ChatMessage, ChatEvent, ToolDefinition, ToolResult } from './types'

export interface OpenAiCompatOptions {
  id: string
  name: string
  models: string[]
  defaultModel: string
  apiKey: string
  baseUrl?: string  // override for Grok / Ollama / etc.
  model?: string
}

interface OpenAiContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

function buildContent(message: ChatMessage): string | OpenAiContentPart[] {
  if (!message.attachments?.length) return message.content
  const parts: OpenAiContentPart[] = []
  if (message.content) parts.push({ type: 'text', text: message.content })
  for (const att of message.attachments) {
    if (att.mimeType.startsWith('image/')) {
      parts.push({ type: 'image_url', image_url: { url: `data:${att.mimeType};base64,${att.data}` } })
    }
    // PDFs / files: not natively inlinable for OpenAI/Grok chat completions
  }
  return parts.length > 0 ? parts : ''
}

/**
 * Generic OpenAI-compatible provider — works for OpenAI, Grok (xAI), Together,
 * Ollama and friends. Differences are baseUrl + model list.
 */
export function createOpenAiCompatProvider(opts: OpenAiCompatOptions): ChatProvider {
  const model = opts.model ?? opts.defaultModel
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseUrl
  })

  return {
    id: opts.id,
    name: opts.name,
    models: opts.models,

    async *send(messages: ChatMessage[], _tools: ToolDefinition[], _results?: ToolResult[]): AsyncIterable<ChatEvent> {
      const conversation = messages.map(m => ({
        role: (m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user') as 'assistant' | 'system' | 'user',
        content: buildContent(m)
      }))

      try {
        const stream = await client.chat.completions.create({
          model,
          messages: conversation as OpenAI.Chat.ChatCompletionMessageParam[],
          stream: true,
          max_tokens: 4096
        })
        for await (const chunk of stream) {
          const text = chunk.choices?.[0]?.delta?.content
          if (text) yield { type: 'text', text }
        }
        yield { type: 'done' }
      } catch (err) {
        yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
      }
    }
  }
}
