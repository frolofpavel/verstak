import type { ComputerAction, WindowGeometry } from './types'

export type AutomaticComputerApp = 'notepad' | 'calculator'
export type AutomaticComputerSource = 'browser'

export interface AutomaticComputerUseRequest {
  targetApp: AutomaticComputerApp
  sourceApp: AutomaticComputerSource | null
  openTargetIfMissing: boolean
  allowedActions: readonly ComputerAction[]
}

export interface AutomaticTargetCandidate {
  candidateId: string
  processName: string
  title: string
  bounds: WindowGeometry
  visible: boolean
  foreground: boolean
  blocked: boolean
}

export type AutomaticTargetSelection =
  | { kind: 'selected'; candidateId: string }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'missing' }

const NOTEPAD_TARGET = /(?:\bnotepad\b|блокнот)/iu
const CALCULATOR_TARGET = /(?:\bcalculator\b|\bcalc(?:\.exe)?\b|калькулятор)/iu
const BROWSER_SOURCE = /(?:открыт\S*\s+(?:страниц\S*|вкладк\S*)\s+браузер\S*|(?:страниц\S*|вкладк\S*)\s+(?:в|из)\s+браузер\S*|browser\s+(?:page|tab))/iu
const TYPE_ACTION = /(?:^|[\s,;:—-])(?:напиши|напечатай|введи|вставь|вставить|write|type|paste)(?=$|[\s,;:—-])/iu
const CALCULATE_ACTION = /(?:^|[\s,;:—-])(?:посчитай|вычисли|рассчитай|calculate|compute)(?=$|[\s,;:—-])/iu
const TRANSFER_ACTION = /(?:^|[\s,;:—-])(?:возьми|скопируй|перенеси|вставь|copy|take|paste|transfer)(?=$|[\s,;:—-])/iu
const DENIED_OR_DEFERRED_ACTION = /(?:\bне\s+(?:открывай|запускай|пиши|напечатай|вводи|вставляй|считай|вычисляй)|(?:сначала|перед\s+этим)\s+(?:спроси|уточни|получи\s+(?:мо[её]\s+)?(?:подтверждение|разрешение))|(?:только\s+)?после\s+(?:моего\s+)?(?:подтверждения|разрешения)|\b(?:ask|confirm)\s+(?:me\s+)?(?:first|before))/iu

/**
 * Узкий pre-model recognizer для обычного пользовательского UX. Он не решает
 * «простая или сложная задача», а только извлекает названную Windows-цель и
 * минимальный набор уже сформулированных действий. Неизвестная формулировка не
 * получает desktop authority и остаётся обычным сообщением.
 */
export function parseAutomaticComputerUseRequest(value: unknown): AutomaticComputerUseRequest | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32 * 1024) return null
  const text = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (!text) return null
  if (DENIED_OR_DEFERRED_ACTION.test(text)) return null

  const targetApp = NOTEPAD_TARGET.test(text)
    ? 'notepad'
    : CALCULATOR_TARGET.test(text)
      ? 'calculator'
      : null
  if (!targetApp) return null

  const sourceApp = BROWSER_SOURCE.test(text) ? 'browser' : null
  const types = TYPE_ACTION.test(text)
  const calculates = CALCULATE_ACTION.test(text)
  const transfers = sourceApp != null && TRANSFER_ACTION.test(text)

  if (targetApp === 'notepad' && (types || transfers)) {
    return {
      targetApp,
      sourceApp,
      openTargetIfMissing: true,
      allowedActions: ['observe', 'wait_for', 'type'],
    }
  }
  if (targetApp === 'calculator' && calculates) {
    return {
      targetApp,
      sourceApp: null,
      openTargetIfMissing: true,
      allowedActions: ['observe', 'wait_for', 'click'],
    }
  }
  return null
}

export function chooseAutomaticTarget(
  app: AutomaticComputerApp,
  candidates: readonly AutomaticTargetCandidate[],
): AutomaticTargetSelection {
  const matching = candidates
    .filter(candidate => candidate.visible && !candidate.blocked && candidateMatchesApp(candidate, app))
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId))
  if (matching.length === 0) return { kind: 'missing' }
  if (matching.length === 1) return { kind: 'selected', candidateId: matching[0]!.candidateId }

  const foreground = matching.filter(candidate => candidate.foreground)
  if (foreground.length === 1) return { kind: 'selected', candidateId: foreground[0]!.candidateId }
  return { kind: 'ambiguous', candidates: matching.map(candidate => candidate.candidateId) }
}

function candidateMatchesApp(candidate: AutomaticTargetCandidate, app: AutomaticComputerApp): boolean {
  const processName = candidate.processName.toLocaleLowerCase('en-US').replace(/\.exe$/u, '')
  const title = candidate.title.toLocaleLowerCase('ru-RU')
  if (app === 'notepad') return processName === 'notepad' || title.includes('блокнот') || title.includes('notepad')
  return processName === 'calculator'
    || processName === 'calculatorapp'
    || processName === 'applicationframehost' && (title.includes('калькулятор') || title.includes('calculator'))
    || title.includes('калькулятор')
    || title.includes('calculator')
}
