import { join } from 'node:path'
import { lookupHandler, type ToolContext, type ToolHandler } from '../ipc/tool-handlers'
import { formatDiagnosticHint, shouldAutoDiagnose } from './diagnostic-loop'
import { formatLspDiagnosticHint } from './lang-servers'
import { runLspDiagnostics } from './lsp-diagnose'
import { detectVerifyScriptsForHint } from './session-journal'
import type { ToolCall } from './types'

interface TurnVerificationInput {
  acceptedWrites: number
  tsWrites: number
  lspWrites: Map<string, string>
  toolCalls: ToolCall[]
  projectPath: string
  context: ToolContext
  diagnosticEnabled: boolean
  resolveHandler?: (name: string, context: ToolContext) => ToolHandler | null
  detectVerifyScripts?: (projectPath: string) => Promise<string[]>
  diagnoseLsp?: typeof runLspDiagnostics
}

async function resolveTypeScriptHint(input: TurnVerificationInput, modelCheckedThisTurn: boolean): Promise<string> {
  if (
    !shouldAutoDiagnose({
      enabled: input.diagnosticEnabled,
      tsWritesThisTurn: input.tsWrites,
      modelCheckedThisTurn,
    })
  )
    return ''

  try {
    const resolveHandler = input.resolveHandler ?? lookupHandler
    const handler = resolveHandler('check_diagnostics', input.context)
    if (!handler) return ''
    const diagnostic = await handler.handle({ id: 'auto-diag', name: 'check_diagnostics', args: {} }, input.context)
    return formatDiagnosticHint(typeof diagnostic.result === 'string' ? diagnostic.result : '') ?? ''
  } catch {
    return ''
  }
}

async function resolveLspHint(input: TurnVerificationInput, modelCheckedThisTurn: boolean): Promise<string> {
  if (input.lspWrites.size === 0 || !input.diagnosticEnabled || modelCheckedThisTurn) return ''
  try {
    const diagnoseLsp = input.diagnoseLsp ?? runLspDiagnostics
    const entries = [...input.lspWrites.entries()].slice(0, 5)
    const hints = await Promise.all(
      entries.map(async ([path, content]) => {
        const diagnostics = await diagnoseLsp({
          path: join(input.projectPath, path),
          content,
          root: input.projectPath,
        })
        return diagnostics ? formatLspDiagnosticHint(path, diagnostics) : null
      }),
    )
    return hints.filter(Boolean).join('\n\n')
  } catch {
    return ''
  }
}

/**
 * Verification phase for one completed tool turn.
 *
 * Priority is unchanged: TypeScript diagnostics → language server diagnostics
 * → a bounded hint with project verification scripts.
 */
export async function buildTurnVerificationHint(input: TurnVerificationInput): Promise<string> {
  if (input.acceptedWrites <= 0) return ''

  const modelCheckedThisTurn = input.toolCalls.some(call => call.name === 'check_diagnostics')
  const hint =
    (await resolveTypeScriptHint(input, modelCheckedThisTurn)) || (await resolveLspHint(input, modelCheckedThisTurn))
  if (hint) return hint
  const detectVerifyScripts = input.detectVerifyScripts ?? detectVerifyScriptsForHint
  const scripts = await detectVerifyScripts(input.projectPath)
  if (scripts.length === 0) return ''
  return `[system: пользователь принял ${input.acceptedWrites} write(s). Перед "готово" запусти проверку через run_command — варианты: ${scripts.slice(0, 2).join(' / ')}. Если уверен что проверка избыточна — объясни почему.]`
}
