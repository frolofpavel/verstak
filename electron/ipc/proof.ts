import { ipcMain } from 'electron'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { assembleProofPack, renderProofPackHtml, renderProofPackMarkdown } from '../ai/proof-pack'
import { artifactsDir } from '../ai/artifacts'
import { readDiffStat } from './git'
import type { AgentRun, AgentRunEvent, AgentRuns } from '../storage/agent-runs'
import type { Verifications } from '../storage/verifications'

/**
 * Proof Pack IPC — собирает доказательство выполнения прогона в пару файлов
 * proof.json + proof.html (в той же .verstak/artifacts/{дата}/). Данные тянутся
 * из готовых источников: agent_runs + events, verifications.latestByRunId, git diff,
 * audit_log. Чистая сборка/рендер — в ai/proof-pack.ts.
 */
export interface ProofDeps {
  agentRuns: AgentRuns
  verifications: Verifications
  getProjectRoot: () => string | null
  /** Записи audit_log этого прогона (action/detail/timestamp). */
  queryAuditForRun: (runId: string) => Array<{ action: string; detail: string; timestamp: number }>
}

export interface ProofGenerateResult {
  ok: boolean
  jsonPath?: string
  htmlPath?: string
  markdownPath?: string
  html?: string
  markdown?: string
  error?: string
}

function isReviewGateEvent(e: AgentRunEvent): boolean {
  return e.kind === 'tool_call' && e.label === 'review_before_commit'
}

function isPassedReviewGateEvent(e: AgentRunEvent): boolean {
  return isReviewGateEvent(e) && e.status === 'ok' && (e.detail ?? '').includes('REVIEW GATE: ПРОЙДЕНО')
}

function relatedReviewEvents(deps: ProofDeps, run: AgentRun, events: AgentRunEvent[]): AgentRunEvent[] {
  if (events.some(isPassedReviewGateEvent) || run.chatId == null) return []
  const candidates = deps.agentRuns
    .list(run.projectPath, { limit: 10 })
    .filter(r => r.runId !== run.runId && r.chatId === run.chatId && r.startedAt >= run.startedAt)

  for (const candidate of candidates) {
    const reviewEvents = deps.agentRuns.getEvents(candidate.runId).filter(isReviewGateEvent)
    if (reviewEvents.some(isPassedReviewGateEvent)) return reviewEvents
  }
  return []
}

export function registerProofIpc(deps: ProofDeps): void {
  ipcMain.handle('proof:generate', async (_e, runId: string): Promise<ProofGenerateResult> => {
    const projectPath = deps.getProjectRoot()
    if (!projectPath) return { ok: false, error: 'no-project' }
    if (!runId || typeof runId !== 'string') return { ok: false, error: 'no-run-id' }

    const run = deps.agentRuns.get(runId)
    if (!run) return { ok: false, error: 'no-run' }
    if (run.projectPath !== projectPath) return { ok: false, error: 'run-project-mismatch' }
    const events = deps.agentRuns.getEvents(runId)
    const proofEvents = [...events, ...relatedReviewEvents(deps, run, events)]
      .sort((a, b) => a.createdAt - b.createdAt)

    // Verification: строгая связка по runId. Proof Pack не должен подхватывать
    // свежую проверку другого прогона из того же чата.
    const verRow = deps.verifications.latestByRunId(projectPath, runId)
    const verification = verRow
      ? { overall: verRow.overall, checksTotal: verRow.checksTotal, checksPassed: verRow.checksPassed, taskSummary: verRow.taskSummary }
      : { overall: 'not_run' as const, checksTotal: 0, checksPassed: 0, taskSummary: null }

    let changedFiles: Array<{ path: string; added: number; removed: number; status: string }> = []
    try { changedFiles = await readDiffStat(projectPath) } catch { /* не git / нет правок */ }

    let audit: Array<{ action: string; detail: string; timestamp: number }> = []
    try { audit = deps.queryAuditForRun(runId) } catch { /* audit best-effort */ }

    const pack = assembleProofPack({
      generatedAt: Date.now(),
      run: {
        runId: run.runId, title: run.title, providerId: run.providerId, model: run.model,
        status: run.status, agentMode: run.agentMode, startedAt: run.startedAt, endedAt: run.endedAt,
        toolCount: run.toolCount, filesCount: run.filesCount, agentsCount: run.agentsCount,
        costCents: run.costCents, turnIndex: run.turnIndex, error: run.error
      },
      changedFiles,
      verification,
      events: proofEvents.map(e => ({ kind: e.kind, label: e.label, detail: e.detail, status: e.status, createdAt: e.createdAt })),
      audit
    })

    const html = renderProofPackHtml(pack)
    const markdown = renderProofPackMarkdown(pack)
    try {
      const dir = artifactsDir(projectPath)
      await mkdir(dir, { recursive: true })
      const slug = `proof-${runId.slice(0, 8)}`
      const jsonPath = join(dir, `${slug}.proof.json`)
      const htmlPath = join(dir, `${slug}.proof.html`)
      const markdownPath = join(dir, `${slug}.proof.md`)
      await writeFile(jsonPath, JSON.stringify(pack, null, 2), 'utf-8')
      await writeFile(htmlPath, html, 'utf-8')
      await writeFile(markdownPath, markdown, 'utf-8')
      return { ok: true, jsonPath, htmlPath, markdownPath, html, markdown }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
