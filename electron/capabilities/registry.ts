/**
 * Сборка паспортов возможностей из ЖИВЫХ источников.
 *
 * Ничего не копирует в свою таблицу: имя, описание и включённость читаются у
 * источника на каждом вызове. В БД (оверлей) живёт только бездомное — доверие,
 * оценка, отметка проверки и версия, на которой доверие было заработано.
 * Обоснование выбора — в шапке `shared/contracts/capability.ts`.
 */
import { createHash } from 'node:crypto'
import {
  capabilityId,
  trustAfterVersionChange,
  TRUST_DEFAULT,
  type Capability,
  type CapabilityRisk,
  type CapabilityStatus,
  type TrustLevel,
} from '../../shared/contracts/capability'
import { keywordScopeAndRisk } from '../../shared/contracts/mcp-scope'
import type { Skill } from '../ai/skills/types'
import type { McpServerEntry } from '../mcp/registry'
import type { ConnectorInfo } from '../connectors/types'

/** Что оверлей знает о возможности. Пусто (null) — записи ещё нет. */
export interface CapabilityOverlay {
  trustLevel: TrustLevel
  /** Версия, НА КОТОРОЙ доверие заработано. Разошлась с текущей — доверие падает. */
  version: string
  evalScore: number | null
  lastVerifiedAt: number | null
}

/** Читатель оверлея. Отдельным параметром, чтобы сборка не зависела от БД. */
export type OverlayReader = (id: string) => CapabilityOverlay | null

export interface CapabilitySources {
  skills: readonly Skill[]
  mcpServers: readonly McpServerEntry[]
  connectors: readonly ConnectorInfo[]
  /** Роли агента из agent-model-policy.json — они и есть «агенты» продукта. */
  roles: readonly string[]
  /** Версия файла политики ролей: у ролей нет своего содержимого для хеша. */
  policyVersion: string
}

/**
 * Версия скилла — хеш ПОВЕДЕНЧЕСКИ значимого содержимого. Имя и иконка в хеш не
 * входят: переименование скилла не должно ронять заработанное доверие, а правка
 * промпта или списка инструментов — обязана.
 */
export function skillVersion(skill: Skill): string {
  const material = JSON.stringify({
    prompt: skill.systemPrompt,
    tools: skill.tools_allow ?? null,
    provider: skill.default_provider ?? null,
    model: skill.default_model ?? null,
    mode: skill.default_mode ?? null,
    loaders: skill.context_loaders ?? null,
    recipe: skill.recipe ?? null,
  })
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

/** Версия MCP-сервера — хеш того, ЧТО именно будет запущено. */
function mcpVersion(entry: McpServerEntry): string {
  return createHash('sha256')
    .update(JSON.stringify({ command: entry.command, args: entry.args }))
    .digest('hex')
    .slice(0, 16)
}

/**
 * Применение оверлея. Здесь единственное место, где решается судьба доверия при
 * расхождении версий, — и решается оно в пользу осторожности.
 */
function withOverlay(
  base: Omit<Capability, 'trustLevel' | 'evalScore' | 'lastVerifiedAt'>,
  overlay: CapabilityOverlay | null
): Capability {
  if (!overlay) {
    return { ...base, trustLevel: TRUST_DEFAULT, evalScore: null, lastVerifiedAt: null }
  }
  const trustLevel = trustAfterVersionChange(overlay.trustLevel, overlay.version, base.version)
  return {
    ...base,
    trustLevel,
    // Оценка и отметка проверки относились к ПРЕЖНЕМУ содержимому: после подмены
    // они не про этот скилл. Показывать их дальше значило бы врать о проверенности.
    evalScore: trustLevel === overlay.trustLevel ? overlay.evalScore : null,
    lastVerifiedAt: trustLevel === overlay.trustLevel ? overlay.lastVerifiedAt : null,
  }
}

function skillCapability(skill: Skill, read: OverlayReader): Capability {
  const id = capabilityId('skill', skill.id)
  const version = skillVersion(skill)
  // Риск скилла — по тому, что он себе разрешил. Не объявил инструменты вовсе —
  // значит доступны все стандартные, и это не «низкий риск».
  const tools = skill.tools_allow ?? null
  const risk: CapabilityRisk = tools === null
    ? 'medium'
    : tools.some(t => /write|patch|command|delete|execute/i.test(t)) ? 'high' : 'low'
  return withOverlay(
    {
      id,
      type: 'skill',
      nativeId: skill.id,
      name: skill.name ?? skill.id,
      description: skill.description ?? '',
      owner: skill.source,
      version,
      source: skill.sourceRef,
      enabled: true,
      status: 'ready',
      allowedTools: tools,
      allowedPaths: null,
      allowedDomains: null,
      dependencies: (skill.context_loaders ?? []).map(l => l.impl),
      riskTier: risk,
    },
    read(id)
  )
}

function mcpCapability(entry: McpServerEntry, read: OverlayReader): Capability {
  const id = capabilityId('mcp', entry.id)
  // Риск берётся тем же классификатором, что работает на инструментах MCP —
  // второго словаря риска в продукте не заводим.
  const { risk } = keywordScopeAndRisk(entry.name, entry.command)
  const status: CapabilityStatus = entry.enabled ? 'ready' : 'disabled'
  return withOverlay(
    {
      id,
      type: 'mcp',
      nativeId: entry.id,
      name: entry.name,
      description: entry.catalogId ? `Из каталога: ${entry.catalogId}` : 'Свой сервер',
      owner: entry.catalogId ?? 'user',
      version: mcpVersion(entry),
      source: `${entry.command} ${entry.args}`,
      enabled: entry.enabled,
      status,
      // Инструменты сервера известны только после подключения — офлайн честно null.
      allowedTools: null,
      allowedPaths: null,
      allowedDomains: null,
      dependencies: [],
      riskTier: risk,
    },
    read(id)
  )
}

function connectorCapability(info: ConnectorInfo, read: OverlayReader): Capability {
  const id = capabilityId('connector', info.id)
  return withOverlay(
    {
      id,
      type: 'connector',
      nativeId: info.id,
      name: info.label,
      description: info.detail ?? '',
      owner: 'built-in',
      // У встроенных коннекторов нет своей версии — их версия это версия продукта,
      // а меняются они только вместе с ним.
      version: 'built-in',
      source: `connectors/${info.id}`,
      enabled: info.status === 'ready',
      status: info.status,
      allowedTools: null,
      allowedPaths: null,
      allowedDomains: null,
      dependencies: [...(info.requires ?? []), ...(info.requiresAnyOf ?? [])],
      // Коннекторы продукта read-only (CLAUDE.md §1) — низкий риск по построению.
      riskTier: 'low',
    },
    read(id)
  )
}

function roleCapability(role: string, policyVersion: string, read: OverlayReader): Capability {
  const id = capabilityId('agent', role)
  return withOverlay(
    {
      id,
      type: 'agent',
      nativeId: role,
      name: role,
      description: 'Роль агента из политики моделей',
      owner: 'built-in',
      version: policyVersion,
      source: 'electron/ai/agent-model-policy.json',
      enabled: true,
      status: 'ready',
      allowedTools: null,
      allowedPaths: null,
      allowedDomains: null,
      dependencies: [],
      riskTier: 'medium',
    },
    read(id)
  )
}

/** Собрать реестр из всех источников. Порядок — по типам, стабильный. */
export function buildCapabilities(sources: CapabilitySources, read: OverlayReader): Capability[] {
  return [
    ...sources.skills.map(s => skillCapability(s, read)),
    ...sources.mcpServers.map(m => mcpCapability(m, read)),
    ...sources.connectors.map(c => connectorCapability(c, read)),
    ...sources.roles.map(r => roleCapability(r, sources.policyVersion, read)),
  ]
}

/** Что выдано конкретному потребителю. Пустой список значит «ничего». */
export interface CapabilityGrant {
  granted: readonly string[]
}

/**
 * Что агент реально видит. Запрет по умолчанию: не выдано — не видно. Выключенная
 * возможность не выдаётся даже будучи разрешённой — разрешение не включает.
 */
export function visibleTo(capabilities: readonly Capability[], grant: CapabilityGrant): Capability[] {
  const allowed = new Set(grant.granted)
  return capabilities.filter(c => allowed.has(c.id) && c.enabled)
}
