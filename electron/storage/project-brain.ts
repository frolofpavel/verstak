/**
 * Project Brain — «мозг проекта» (ядро продукта v3+). Интеллект живёт в проекте
 * (ключ — project_path), а не в модели: overview, summary файлов, context-packs,
 * решения. Модели сменяемы — мозг копит экспертизу конкретного проекта.
 *
 * Data layer (Итерация 2). Warmup-наполнение — ai/project-brain/warmup.ts;
 * инъекция в запросы — context-pack/compose-system; UI — отдельно.
 * Stubs model_scoreboard/agency_hive_mind пока без логики (схема заложена в db.ts).
 */

import type { Database } from 'better-sqlite3'

export interface ProjectBrain {
  id: number
  projectPath: string
  version: number
  overview: string | null
  architectureSummary: string | null
  importantFiles: string[]
  entities: string[]
  projectRules: string | null
  createdAt: number
  updatedAt: number
  lastWarmupAt: number | null
}

export interface FileSummary {
  filePath: string
  fileHash: string | null
  summary: string | null
  keyExports: string[]
  keyDependencies: string[]
  risks: string | null
  tokenEstimate: number | null
}

export type ContextPackType = 'short' | 'medium' | 'long'

export interface ContextPack {
  type: ContextPackType
  content: string
  tokenEstimate: number | null
  sourceFiles: string[]
}

export type Confidence = 'low' | 'medium' | 'high'

export interface DecisionRecord {
  id: number
  projectPath: string
  sourceMessageId: string | null
  title: string
  userRequest: string | null
  finalDecision: string | null
  why: string | null
  keyArguments: string[]
  objections: string[]
  risks: string[]
  alternativesRejected: string[]
  nextActions: string[]
  confidence: Confidence | null
  revisitDate: number | null
  createdAt: number
  updatedAt: number
}

/** DecisionBrief — сжатая карта решения ДО сохранения (вход для save). */
export type NewDecisionRecord = Omit<DecisionRecord, 'id' | 'projectPath' | 'createdAt' | 'updatedAt'>

function arr(json: unknown): string[] {
  if (typeof json !== 'string' || !json) return []
  try { const v = JSON.parse(json); return Array.isArray(v) ? v.map(String) : [] } catch { return [] }
}
const j = (v: string[] | undefined | null) => JSON.stringify(v ?? [])

export interface ProjectBrainStore {
  createBrain(projectPath: string): ProjectBrain
  getBrain(projectPath: string): ProjectBrain | null
  updateBrain(projectPath: string, patch: Partial<Omit<ProjectBrain, 'id' | 'projectPath' | 'createdAt'>>): ProjectBrain | null
  saveFileSummary(projectPath: string, fs: FileSummary): void
  getFileSummaries(projectPath: string): FileSummary[]
  saveContextPack(projectPath: string, pack: ContextPack): void
  getContextPacks(projectPath: string): ContextPack[]
  getContextPack(projectPath: string, type: ContextPackType): ContextPack | null
  saveDecisionRecord(projectPath: string, rec: NewDecisionRecord): DecisionRecord
  getDecisionRecords(projectPath: string): DecisionRecord[]
}

interface BrainRow {
  id: number; project_path: string; version: number; overview: string | null
  architecture_summary: string | null; important_files: string | null; entities: string | null
  project_rules: string | null; created_at: number; updated_at: number; last_warmup_at: number | null
}

function mapBrain(r: BrainRow): ProjectBrain {
  return {
    id: r.id, projectPath: r.project_path, version: r.version,
    overview: r.overview, architectureSummary: r.architecture_summary,
    importantFiles: arr(r.important_files), entities: arr(r.entities),
    projectRules: r.project_rules, createdAt: r.created_at, updatedAt: r.updated_at,
    lastWarmupAt: r.last_warmup_at,
  }
}

export function createProjectBrainStore(db: Database): ProjectBrainStore {
  return {
    createBrain(projectPath) {
      const now = Date.now()
      db.prepare(`INSERT INTO project_brain (project_path, version, created_at, updated_at)
                  VALUES (?, 1, ?, ?) ON CONFLICT(project_path) DO NOTHING`).run(projectPath, now, now)
      return this.getBrain(projectPath)!
    },
    getBrain(projectPath) {
      const r = db.prepare('SELECT * FROM project_brain WHERE project_path = ?').get(projectPath) as BrainRow | undefined
      return r ? mapBrain(r) : null
    },
    updateBrain(projectPath, patch) {
      const cur = this.getBrain(projectPath) ?? this.createBrain(projectPath)
      const sets: string[] = []
      const vals: unknown[] = []
      const map: Record<string, string> = {
        version: 'version', overview: 'overview', architectureSummary: 'architecture_summary',
        projectRules: 'project_rules', lastWarmupAt: 'last_warmup_at',
      }
      for (const [k, col] of Object.entries(map)) {
        if (k in patch) { sets.push(`${col} = ?`); vals.push((patch as Record<string, unknown>)[k] ?? null) }
      }
      if ('importantFiles' in patch) { sets.push('important_files = ?'); vals.push(j(patch.importantFiles)) }
      if ('entities' in patch) { sets.push('entities = ?'); vals.push(j(patch.entities)) }
      if (sets.length === 0) return cur
      sets.push('updated_at = ?'); vals.push(Date.now())
      vals.push(projectPath)
      db.prepare(`UPDATE project_brain SET ${sets.join(', ')} WHERE project_path = ?`).run(...vals)
      return this.getBrain(projectPath)
    },
    saveFileSummary(projectPath, fs) {
      db.prepare(`INSERT INTO file_summary
          (project_path, file_path, file_hash, summary, key_exports, key_dependencies, risks, token_estimate, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_path, file_path) DO UPDATE SET
            file_hash=excluded.file_hash, summary=excluded.summary, key_exports=excluded.key_exports,
            key_dependencies=excluded.key_dependencies, risks=excluded.risks,
            token_estimate=excluded.token_estimate, updated_at=excluded.updated_at`)
        .run(projectPath, fs.filePath, fs.fileHash, fs.summary, j(fs.keyExports), j(fs.keyDependencies),
             fs.risks, fs.tokenEstimate, Date.now())
    },
    getFileSummaries(projectPath) {
      const rows = db.prepare('SELECT * FROM file_summary WHERE project_path = ? ORDER BY file_path').all(projectPath) as Array<Record<string, unknown>>
      return rows.map(r => ({
        filePath: r.file_path as string, fileHash: (r.file_hash as string) ?? null,
        summary: (r.summary as string) ?? null, keyExports: arr(r.key_exports), keyDependencies: arr(r.key_dependencies),
        risks: (r.risks as string) ?? null, tokenEstimate: (r.token_estimate as number) ?? null,
      }))
    },
    saveContextPack(projectPath, pack) {
      const now = Date.now()
      db.prepare(`INSERT INTO context_pack (project_path, type, content, token_estimate, source_files, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_path, type) DO UPDATE SET
            content=excluded.content, token_estimate=excluded.token_estimate,
            source_files=excluded.source_files, updated_at=excluded.updated_at`)
        .run(projectPath, pack.type, pack.content, pack.tokenEstimate, j(pack.sourceFiles), now, now)
    },
    getContextPacks(projectPath) {
      const rows = db.prepare('SELECT * FROM context_pack WHERE project_path = ?').all(projectPath) as Array<Record<string, unknown>>
      return rows.map(r => ({
        type: r.type as ContextPackType, content: r.content as string,
        tokenEstimate: (r.token_estimate as number) ?? null, sourceFiles: arr(r.source_files),
      }))
    },
    getContextPack(projectPath, type) {
      const r = db.prepare('SELECT * FROM context_pack WHERE project_path = ? AND type = ?').get(projectPath, type) as Record<string, unknown> | undefined
      if (!r) return null
      return { type: r.type as ContextPackType, content: r.content as string, tokenEstimate: (r.token_estimate as number) ?? null, sourceFiles: arr(r.source_files) }
    },
    saveDecisionRecord(projectPath, rec) {
      const now = Date.now()
      const info = db.prepare(`INSERT INTO decision_record
          (project_path, source_message_id, title, user_request, final_decision, why, key_arguments,
           objections, risks, alternatives_rejected, next_actions, confidence, revisit_date, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(projectPath, rec.sourceMessageId, rec.title, rec.userRequest, rec.finalDecision, rec.why,
             j(rec.keyArguments), j(rec.objections), j(rec.risks), j(rec.alternativesRejected),
             j(rec.nextActions), rec.confidence, rec.revisitDate, now, now)
      return this.getDecisionRecords(projectPath).find(d => d.id === Number(info.lastInsertRowid))!
    },
    getDecisionRecords(projectPath) {
      const rows = db.prepare('SELECT * FROM decision_record WHERE project_path = ? ORDER BY created_at DESC').all(projectPath) as Array<Record<string, unknown>>
      return rows.map(r => ({
        id: r.id as number, projectPath: r.project_path as string, sourceMessageId: (r.source_message_id as string) ?? null,
        title: r.title as string, userRequest: (r.user_request as string) ?? null, finalDecision: (r.final_decision as string) ?? null,
        why: (r.why as string) ?? null, keyArguments: arr(r.key_arguments), objections: arr(r.objections),
        risks: arr(r.risks), alternativesRejected: arr(r.alternatives_rejected), nextActions: arr(r.next_actions),
        confidence: (r.confidence as Confidence) ?? null, revisitDate: (r.revisit_date as number) ?? null,
        createdAt: r.created_at as number, updatedAt: r.updated_at as number,
      }))
    },
  }
}
