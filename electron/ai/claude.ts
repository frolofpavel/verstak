import Anthropic from '@anthropic-ai/sdk'
import type { ChatProvider, ChatMessage, ChatEvent, ToolDefinition, ToolResult } from './types'

interface ClaudeOptions {
  apiKey: string
  model?: string
}

export const CLAUDE_MODELS = [
  'claude-opus-4-5-20251101',
  'claude-sonnet-4-5-20251101',
  'claude-haiku-4-5-20251101'
]

const DEFAULT_MODEL = CLAUDE_MODELS[1]

interface ClaudeContentBlock {
  type: 'text' | 'image' | 'document'
  text?: string
  source?: { type: 'base64'; media_type: string; data: string }
}

function buildContent(message: ChatMessage): string | ClaudeContentBlock[] {
  if (!message.attachments?.length) return message.content
  const blocks: ClaudeContentBlock[] = []
  if (message.content) blocks.push({ type: 'text', text: message.content })
  for (const att of message.attachments) {
    if (att.mimeType.startsWith('image/')) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: att.mimeType, data: att.data } })
    } else if (att.mimeType === 'application/pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: att.mimeType, data: att.data } })
    }
    // other types: skip silently (Claude only supports images and PDFs as document)
  }
  return blocks.length === 0 ? '' : blocks
}

export function createClaudeProvider(opts: ClaudeOptions): ChatProvider {
  const model = opts.model ?? DEFAULT_MODEL
  const client = new Anthropic({ apiKey: opts.apiKey })

  return {
    id: 'claude',
    name: 'Claude',
    models: CLAUDE_MODELS,

    async *send(messages: ChatMessage[], _tools: ToolDefinition[], _results?: ToolResult[]): AsyncIterable<ChatEvent> {
      const systemMessages = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
      const conversation = messages
        .filter(m => m.role !== 'system')
        .map(m => ({
          role: (m.role === 'assistant' ? 'assistant' : 'user') as 'assistant' | 'user',
          content: buildContent(m)
        }))
        .filter(m => m.content && (typeof m.content === 'string' ? m.content : m.content.length > 0))

      try {
        const stream = await client.messages.stream({
          model,
          max_tokens: 4096,
          system: systemMessages || undefined,
          messages: conversation as Anthropic.Messages.MessageParam[]
        })
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            yield { type: 'text', text: event.delta.text }
          }
        }
        yield { type: 'done' }
      } catch (err) {
        yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
      }
    }
  }
}
