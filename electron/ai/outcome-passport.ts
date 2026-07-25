import { homedir } from 'os'
import { readFileSync, writeFileSync } from 'fs'
import { scanText } from './secret-scanner'
import { redactPathsForExport } from './export-path-redaction'
import type { AgentJobV1 } from '../../shared/contracts/agent-job'
import type { PipelineRun, OutcomeMetrics } from '../storage/pipeline-runs'

export interface OutcomePassportInput {
  pipeline: PipelineRun
  plan: { title: string; steps: Array<{ title: string; status: string; result?: string | null }> } | null
  jobs: AgentJobV1[]
  verification: {
    overall: string
    checksTotal: number
    checksPassed: number
    changedFilesCount: number
    htmlPath?: string | null
    artifactPath?: string | null
  } | null
  route: { providerId: string; model: string; accountId?: number | null } | null
  metrics: OutcomeMetrics
  exportedAt?: number
  homeDir?: string
}

export function buildOutcomePassport(input: OutcomePassportInput): string {
  const { pipeline, plan, jobs, verification, route, metrics } = input
  const lines = [
    `# Паспорт результата #${pipeline.id}`,
    '',
    `Экспортирован: ${new Date(input.exportedAt ?? Date.now()).toISOString()}`,
    `Состояние: ${pipeline.step}`,
    `Глубина: ${effortLabel(pipeline.effortLevel)}`,
    '',
    '## Задача',
    '',
    `**Цель:** ${pipeline.brief.goal}`,
    `**Ограничения:** ${pipeline.brief.constraints || 'не заданы'}`,
    `**Готово когда:** ${pipeline.brief.dod || 'уточнялось агентом'}`,
    `**Контракт:** ${pipeline.taskContract ? `revision ${pipeline.contractRevision}, risk ${pipeline.taskContract.risk}` : 'не создан'}`,
    '',
    '## План',
    '',
    ...(plan?.steps.length
      ? plan.steps.map((step, index) => `${index + 1}. [${step.status}] ${step.title}${step.result ? ` — ${step.result}` : ''}`)
      : ['План не создан.']),
    '',
    '## Исполнители и маршрут',
    '',
    route
      ? `Основной прогон: ${route.providerId} / ${route.model}${route.accountId == null ? '' : ` / account ${route.accountId}`}`
      : 'Основной маршрут: неизвестно',
    ...(jobs.length
      ? jobs.map(job => `- [${job.status}] ${job.role}: ${job.providerId} / ${job.model}${job.accountId == null ? '' : ` / account ${job.accountId}`}; attempt ${job.attempt}/${job.maxAttempts}`)
      : ['- Делегированные jobs не создавались.']),
    '',
    '## Проверка и Proof',
    '',
    ...(verification
      ? [
          `Статус: ${verification.overall}`,
          `Проверки: ${verification.checksPassed}/${verification.checksTotal}`,
          `Изменённые файлы: ${verification.changedFilesCount}`,
          `Proof: ${verification.htmlPath || verification.artifactPath || 'артефакт не создан'}`,
        ]
      : ['Проверка не зафиксирована.']),
    '',
    '## Локальные метрики',
    '',
    `Завершено: ${metrics.completed}/${metrics.starts}`,
    `Блокировки: ${metrics.blocked}`,
    `Повторы: ${metrics.retries}`,
    `Перепланы: ${metrics.replans}`,
    `Вмешательства: ${metrics.interventions}`,
    `Токены input/output: ${nullable(metrics.inputTokens)} / ${nullable(metrics.outputTokens)}`,
    `Стоимость: ${metrics.costCents == null ? 'неизвестно' : `$${(metrics.costCents / 100).toFixed(2)}`}`,
    `Медиана до Proof: ${metrics.medianTimeToProofMs == null ? 'неизвестно' : `${metrics.medianTimeToProofMs} ms`}`,
    '',
    '_Сформировано Verstak. Паспорт описывает локально сохранённые факты прогона._',
  ]
  const scanned = scanText(lines.join('\n')).redacted
  return redactPathsForExport(scanned, {
    homeDir: input.homeDir ?? homedir(),
    projectRoots: [pipeline.projectPath],
  })
}

export function writeOutcomePassportFile(path: string, markdown: string): void {
  writeFileSync(path, markdown, 'utf8')
  if (readFileSync(path, 'utf8') !== markdown) {
    throw new Error('Паспорт записан не полностью.')
  }
}

function effortLabel(level: PipelineRun['effortLevel']) {
  if (level === 'quick') return 'Быстро'
  if (level === 'deep') return 'Глубоко'
  return 'Под контролем'
}

function nullable(value: number | null) {
  return value == null ? 'неизвестно' : String(value)
}
