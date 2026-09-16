import type { ChatMessage } from '../types'
import type { ComputerAction } from './types'

export const MAX_COMPUTER_USE_ORIGINAL_USER_TEXT_BYTES = 32 * 1024
export const COMPUTER_USE_PERSISTED_ATTACHMENT_BOUNDARY = '\n\n📎 '
const MAX_COMPUTER_USE_ATTEMPT_PREFIX_CODE_UNITS = MAX_COMPUTER_USE_ORIGINAL_USER_TEXT_BYTES

/** Preserve accepted text byte-for-byte. Malformed or oversized provenance
 * loses Computer Use authority without breaking ordinary chat delivery. */
export function validateComputerUseOriginalUserText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // One UTF-16 code unit always occupies at least one UTF-8 byte. Rejecting
  // this case first keeps an attacker-controlled oversized envelope from
  // forcing trim/encoding work over the complete raw value.
  if (value.length > MAX_COMPUTER_USE_ORIGINAL_USER_TEXT_BYTES) return null
  if (Buffer.byteLength(value, 'utf8') > MAX_COMPUTER_USE_ORIGINAL_USER_TEXT_BYTES) return null
  if (value.trim().length === 0) return null
  return value
}

/** Extract the untouched composer text from the persisted user-message form.
 * Attachment labels are display metadata and never carry desktop authority. */
export function computerUseOriginalTextFromPersistedContent(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // The composer part cannot be authoritative past the byte ceiling. Include
  // only enough extra code units to recognize a boundary immediately after a
  // maximum-size ASCII composer value; never scan an unbounded attachment tail.
  const bounded = value.slice(
    0,
    MAX_COMPUTER_USE_ORIGINAL_USER_TEXT_BYTES + COMPUTER_USE_PERSISTED_ATTACHMENT_BOUNDARY.length,
  )
  const attachmentBoundary = bounded.indexOf(COMPUTER_USE_PERSISTED_ATTACHMENT_BOUNDARY)
  return validateComputerUseOriginalUserText(
    attachmentBoundary >= 0 ? bounded.slice(0, attachmentBoundary) : value,
  )
}

type OriginalUserMessage = Pick<ChatMessage, 'role' | 'content'> & {
  /** Scheduler/reminder turns are never interactive consent. */
  source?: string
}

const POLITE_PREFIX = String.raw`(?:пожалуйста[,.!]?\s+|please[,.!]?\s+)?`
const COMPUTER_USE_COMMAND = new RegExp(
  String.raw`^${POLITE_PREFIX}(?:`
    + String.raw`\/computer[-_ ]?use(?:\s|$|[:—-])`
    + String.raw`|(?:используй|запусти|включи|продолжи|разрешаю|управляй|работай\s+через)\s+(?:режим\s+)?computer[-_ ]?use(?:\s|$|[:—-])`
    + String.raw`|(?:use|start|enable|continue|allow)\s+(?:the\s+)?computer[-_ ]?use(?:\s|$|[:—-])`
    + String.raw`|(?:управляй|работай\s+с)\s+(?:этим\s+|моим\s+)?выбранн(?:ым|ом)\s+окн(?:ом|е)(?:\s|$|[,:;—-])`
    + String.raw`|в\s+(?:этом\s+|моём\s+)?выбранном\s+окне(?:\s+windows)?\s+(?:нажми|кликни|введи|напечатай|прокрути|прочитай|проверь|выбери)(?:\s|$)`
    + String.raw`|(?:control|work\s+in)\s+(?:this\s+|the\s+)?selected\s+window(?:\s|$|[:—-])`
    + String.raw`)`,
  'iu',
)
// A bare command grants only observation. Keep the full expression anchored:
// an unrecognised suffix must not inherit read authority merely because its
// prefix happened to look like a Computer Use command.
const BARE_COMPUTER_USE_COMMAND = new RegExp(
  String.raw`^${POLITE_PREFIX}(?:`
    + String.raw`\/computer[-_ ]?use(?:\s+(?:в|для)\s+(?:этого\s+|моего\s+)?выбранного\s+окна(?:\s+windows)?)?`
    + String.raw`|(?:используй|запусти|включи|продолжи|разрешаю)\s+(?:режим\s+)?computer[-_ ]?use(?:\s+(?:в|для)\s+(?:этого\s+|моего\s+)?выбранного\s+окна(?:\s+windows)?)?`
    + String.raw`|(?:use|start|enable|continue|allow)\s+(?:the\s+)?computer[-_ ]?use(?:\s+(?:in|for)\s+(?:this\s+|the\s+)?selected\s+window)?`
    + String.raw`)\s*[:.!—-]?$`,
  'iu',
)

const NEGATED_COMMAND = new RegExp(
  String.raw`^${POLITE_PREFIX}(?:не\s+|не\s+надо\s+|don't\s+|do\s+not\s+)`,
  'iu',
)

// A recognized command prefix is not consent when the same untouched user
// turn revokes the whole Computer Use request or explicitly defers it to a
// future confirmation. Keep this narrower than per-action restrictions such
// as "не нажимай, только прочитай", which still authorize readback now.
const WHOLE_COMMAND_DENIAL_OR_DEFERRAL = new RegExp(
  String.raw`(?:`
    + String.raw`(?:^|[\s,;:—-])(?:пока\s+)?не\s+(?:используй|запускай|включай|продолжай|разрешай|управляй|работай)(?:\s+(?:computer[-_ ]?use|его|это|с\s+ним))?(?=$|[\s,.!?;:—-])`
    + String.raw`|(?:^|[\s,;:—-])(?:не\s+(?:надо|нужно)\s+(?:использовать|запускать|включать|продолжать|разрешать|управлять)|(?:использовать|запускать|включать|продолжать)\s+не\s+(?:надо|нужно))(?=$|[\s,.!?;:—-])`
    + String.raw`|(?:^|[\s,;:—-])(?:я\s+)?не\s+разрешаю(?:\s+(?:использовать|запускать|включать|продолжать|управлять|это|его))?(?=$|[\s,.!?;:—-])`
    + String.raw`|(?:^|[\s,;:—-])(?:только\s+когда\s+я\s+(?:отдельно|явно)\s+(?:разрешу|подтвержу)|после\s+(?:моего\s+)?(?:отдельного|явного)\s+(?:подтверждения|разрешения))(?=$|[\s,.!?;:—-])`
    + String.raw`|(?:^|[\s,;:—-])только\s+(?:с\s+моего\s+(?:разрешения|подтверждения)|по\s+моему\s+(?:разрешению|подтверждению))(?=$|[\s,.!?;:—-])`
    + String.raw`|(?:^|[\s,;:—-])после\s+(?:того,?\s+как\s+)?я\s+скажу\s+да(?=$|[\s,.!?;:—-])`
    + String.raw`|(?:^|[\s,;:—-])(?:разрешения|подтверждения)\s+не\s+даю(?=$|[\s,.!?;:—-])`
    + String.raw`|(?:^|[\s,;:—-])(?:я\s+)?запрещаю(?=$|[\s,.!?;:—-])`
    + String.raw`|(?:^|[\s,;:—-])я\s+не\s+соглас(?:ен|на)(?=$|[\s,.!?;:—-])`
    + String.raw`|(?:^|[\s,;:—-])(?:но\s+)?(?:сначала|сперва)\s+(?:согласуй\s+со\s+мной|спроси\s+(?:меня|у\s+меня))(?=$|[\s,.!?;:—-])`
    + String.raw`|(?:^|[\s,;:—-])(?:дождись|жди|подожди)\s+(?:моего\s+)?(?:подтверждения|разрешения)(?=$|[\s,.!?;:—-])`
    + String.raw`|(?:^|[\s,;:—-])сначала\s+(?:спроси|запроси|получи)\s+(?:у\s+меня\s+|моего\s+)?(?:подтверждение|подтверждения|разрешение|разрешения)(?=$|[\s,.!?;:—-])`
    + String.raw`|(?:^|[\s,;:—-])только\s+(?:после\s+(?:того,?\s+как\s+я\s+)?(?:подтвержу|разрешу|подтверждения|разрешения)|если\s+я\s+(?:подтвержу|разрешу)|когда\s+я\s+(?:подтвержу|разрешу))(?=$|[\s,.!?;:—-])`
    + String.raw`|(?:^|[\s,;:—-])(?:если|когда)\s+я\s+(?:явно\s+|отдельно\s+)?(?:подтвержу|разрешу)(?=$|[\s,.!?;:—-])`
    + String.raw`|(?:^|[\s,;:—-])(?:после|до)\s+(?:(?:того,?\s+как\s+я\s+)(?:подтвержу|разрешу)|(?:моего\s+)?(?:подтверждения|разрешения))(?=$|[\s,.!?;:—-])`
    + String.raw`|(?:^|[\s,;:—-])(?:но\s+)?не\s+сейчас(?=$|[\s,.!?;:—-])`
    + String.raw`|(?:^|[\s,;:—-])(?:потом|позже)(?=$|[\s,.!?;:—-])`
    + String.raw`|\b(?:don't|do\s+not)\s+(?:use|start|enable|continue|allow|control)(?:\s+(?:it|computer[-_ ]?use))?\b`
    + String.raw`|\bnever\s+(?:use|start|enable|continue|allow|control)(?:\s+(?:it|computer[-_ ]?use))?\b`
    + String.raw`|\b(?:i\s+)?(?:do\s+not|don't)\s+consent\b`
    + String.raw`|\bonly\s+(?:when|after)\s+(?:i\s+(?:explicitly|separately)\s+(?:allow|confirm)|my\s+(?:explicit|separate)\s+(?:approval|confirmation))\b`
    + String.raw`|\bonly\s+with\s+my\s+(?:permission|approval|confirmation)\b`
    + String.raw`|\b(?:after|once)\s+i\s+say\s+yes\b`
    + String.raw`|\b(?:but\s+)?(?:ask\s+me|check\s+with\s+me)\s+first\b`
    + String.raw`|\b(?:if|when|once|after|until)\s+i\s+(?:confirm|approve|allow)(?:\s+later)?\b`
    + String.raw`|\b(?:after|until)\s+(?:my\s+)?(?:confirmation|approval|permission)\b`
    + String.raw`|\bwait\s+until\s+i\s+(?:confirm|approve|allow)\b`
    + String.raw`|\bonly\s+(?:if|when|after)\s+(?:i\s+)?(?:confirm|approve|allow|confirmation|approval)\b`
    + String.raw`|\bbut\s+not\s+now\b`
    + String.raw`|\bnot\s+(?:now|yet)\b`
    + String.raw`|\bnever\b`
    + String.raw`|(?:^|[\s,;:—-])later(?=$|[\s,.!?;:—-])`
    + String.raw`)`,
  'iu',
)

// A current Computer Use turn may allow observation while explicitly holding
// its named mutation until a separate approval. These natural forms are not a
// grant for click/type/key actions, but unlike a whole-command denial they do
// leave the safe observe/wait prerequisites available now.
const MUTATION_AWAITS_APPROVAL = new RegExp(
  String.raw`(?:`
    + String.raw`(?:^|[\s,;:—-])(?:но\s+)?спроси\s+(?:меня|у\s+меня)\s+(?:перед\s+(?:этим|действием)|до\s+(?:этого|действия))(?=$|[\s,.!?;:—-])`
    + String.raw`|(?:^|[\s,;:—-])(?:дождись|жди|подожди)\s+(?:моего\s+)?(?:одобрения|согласия)(?=$|[\s,.!?;:—-])`
    + String.raw`|\b(?:but\s+)?(?:ask\s+me|check\s+with\s+me)\s+before\s+(?:doing\s+it|you\s+(?:do|click|type|press|invoke))\b`
    + String.raw`|\bwait\s+for\s+my\s+(?:go[- ]ahead|approval|confirmation|consent)\b`
    + String.raw`)`,
  'iu',
)

const READ_ACTIONS: readonly ComputerAction[] = ['observe', 'wait_for']
const ALL_ACTIONS: readonly ComputerAction[] = ['observe', 'wait_for', 'click', 'type', 'key', 'scroll']
const FULL_CONTROL = new RegExp(
  String.raw`^${POLITE_PREFIX}(?:`
    + String.raw`(?:управляй|работай\s+с)\s+(?:этим\s+|моим\s+)?выбранн(?:ым|ом)\s+окн(?:ом|е)`
    + String.raw`|(?:control|work\s+in)\s+(?:this\s+|the\s+)?selected\s+window`
    + String.raw`)[.!]?$`,
  'iu',
)
const RESTRICTED_SCOPE = /(?:(?:только|лишь|просто)|ничего\s+не|\b(?:only|just|read[- ]?only|do\s+not|don['’]t)\b)/iu
const BROAD_RESTRICTION = /(?:(?:^|[\s,;:—-])(?:не|без|кроме|запрещено)(?=\s|$)|\b(?:without|except|forbidden)\b)/iu
const EN_ACTION_PREFIX = String.raw`(?:^|[,:;—-]\s*|\b(?:and|then|please|only|just)\s+|\/computer[-_ ]?use\s+)`
const CLICK_ACTION = new RegExp(
  String.raw`(?:кликни|кликай|щёлкни|щёлкай|выбери|выбирай)`
    + String.raw`|(?:нажми|нажимай)\s+(?!(?:клавиш\S*\s+)?(?:enter|tab|escape|стрелк\S*)\b)\S+`
    + String.raw`|${EN_ACTION_PREFIX}(?:click(?!\s+(?:count|rate|metrics?|statistics?|data|events?)\b)|select|choose)(?![-\p{L}\p{N}_])`
    + String.raw`|${EN_ACTION_PREFIX}press\s+(?!(?:enter|tab|escape|arrow\w*)\b)\S+`,
  'iu',
)
const TYPE_ACTION = new RegExp(
  String.raw`(?:введи|вводи|напечатай|печатай|заполни|заполняй)`
    + String.raw`|${EN_ACTION_PREFIX}(?:type(?!\s+of\b)|fill|write)(?![-\p{L}\p{N}_])`,
  'iu',
)
const KEY_ACTION = new RegExp(
  String.raw`(?:нажми|нажимай)\s+(?:клавиш\S*\s+)?(?:enter|tab|escape|стрелк\S*)`
    + String.raw`|${EN_ACTION_PREFIX}press\s+(?:enter|tab|escape|arrow\w*)\b`,
  'iu',
)
const SCROLL_ACTION = new RegExp(
  String.raw`(?:прокрути|прокручивай|пролистай|листай)`
    + String.raw`|${EN_ACTION_PREFIX}scroll(?![-\p{L}\p{N}_])`
    + String.raw`(?!\s+(?:settings?|configuration|position|state|properties?|type|role)\b)`,
  'iu',
)
const READ_ACTION = new RegExp(
  String.raw`(?:прочитай|читай|проверь|проверяй|посмотри|наблюдай|дождись|подожди)`
    + String.raw`|${EN_ACTION_PREFIX}(?:read|inspect|check|observe|wait\s+(?:for|until))(?![-\p{L}\p{N}_])`,
  'iu',
)
const EXPLICIT_READ_ONLY_SCOPE = new RegExp(
  String.raw`(?:`
    + String.raw`(?:^|[\s,;:—-])(?:только|лишь|просто)\s+(?:прочитай|читай|проверь|проверяй|посмотри|наблюдай)(?=$|[\s,.!?;:—-])`
    + String.raw`|\b(?:only|just)\s+(?:read|inspect|check|observe)\b`
    + String.raw`|\bread[- ]only\b`
    + String.raw`)`,
  'iu',
)
const RU_NEGATION_PREFIX = String.raw`(?:^|[\s,;:—-])(?:не|ничего\s+не)\s+`
const CLICK_NEGATION = new RegExp(
  String.raw`(?:${RU_NEGATION_PREFIX}(?:кликни|кликай|щёлкни|щёлкай|нажми|нажимай|выбери|выбирай)|\b(?:(?:do\s+not|don['’]t)\s+(?:click|select|choose|press)|without\s+(?:click(?:ing)?|select(?:ing)?|choosing|pressing))\b)`,
  'giu',
)
const TYPE_NEGATION = new RegExp(
  String.raw`(?:${RU_NEGATION_PREFIX}(?:введи|вводи|напечатай|печатай|заполни|заполняй|пиши)|\b(?:do\s+not|don['’]t)\s+(?:type|fill|write)\b)`,
  'giu',
)
const KEY_NEGATION = new RegExp(
  String.raw`(?:${RU_NEGATION_PREFIX}(?:нажми|нажимай)(?:\s+(?:клавиш\S*\s*)?(?:enter|tab|escape|стрелк\S*)|\s+клавиш\S*)|\b(?:do\s+not|don['’]t)\s+press\s+(?:enter|tab|escape|arrow\w*)\b)`,
  'giu',
)
const SCROLL_NEGATION = new RegExp(
  String.raw`(?:${RU_NEGATION_PREFIX}(?:прокрути|прокручивай|пролистай|листай)|\b(?:do\s+not|don['’]t)\s+scroll\b)`,
  'giu',
)

function normalizeExplicitContent(raw: string): string | null {
  const content = raw.trim().replace(/\s+/gu, ' ')
  if (!content || NEGATED_COMMAND.test(content) || !COMPUTER_USE_COMMAND.test(content)) return null
  return content
}

/** Main-owned privacy signal. This intentionally covers a recognized command
 * attempt even when a later suffix grants no action: expired/malformed tickets
 * must not turn raw Computer Use composer content into ordinary reusable chat. */
export function isComputerUseComposerAttempt(value: unknown): boolean {
  if (typeof value !== 'string') return false
  // Privacy classification deliberately outlives the authority envelope. An
  // oversized explicit command must still taint/fail closed, while the action
  // gate below receives no executable authority. Inspect only the bounded
  // command prefix so raw oversized content is neither copied nor normalized.
  const bounded = value.slice(0, MAX_COMPUTER_USE_ATTEMPT_PREFIX_CODE_UNITS)
  const attachmentBoundary = bounded.indexOf(COMPUTER_USE_PERSISTED_ATTACHMENT_BOUNDARY)
  const boundedComposer = attachmentBoundary >= 0 ? bounded.slice(0, attachmentBoundary) : bounded
  const content = boundedComposer
    .trim()
    .replace(/\s+/gu, ' ')
  return !!content && !NEGATED_COMMAND.test(content) && COMPUTER_USE_COMMAND.test(content)
}

function latestExplicitContent(messages: readonly OriginalUserMessage[]): string | null {
  const latest = [...messages].reverse().find(message => message.role === 'user')
  if (!latest || latest.source === 'reminder') return null
  const original = computerUseOriginalTextFromPersistedContent(latest.content)
  return original ? normalizeExplicitContent(original) : null
}

/**
 * Least-authority scope derived only from the untouched latest user turn.
 * Observation requires a bare recognized command or an explicit current
 * read/mutation action. Mutations require the same current command to name
 * them, so an unknown or deferred suffix grants nothing.
 */
export function allowedComputerUseActions(messages: readonly OriginalUserMessage[]): readonly ComputerAction[] {
  return deriveAllowedComputerUseActions(latestExplicitContent(messages))
}

function deriveAllowedComputerUseActions(content: string | null): readonly ComputerAction[] {
  if (!content) return []
  // Restrictions are evaluated on the complete current command before any
  // data delimiter is truncated. A quoted target must not hide a later
  // "not now"/"only read" suffix.
  if (WHOLE_COMMAND_DENIAL_OR_DEFERRAL.test(content)) return []
  if (MUTATION_AWAITS_APPROVAL.test(content)) return [...READ_ACTIONS]
  if (EXPLICIT_READ_ONLY_SCOPE.test(content)) return [...READ_ACTIONS]

  // Quoted page/document content and pasted code are data, not an
  // authority-bearing command. Stop at the first data delimiter: trying to
  // balance malformed or nested quotes could expose later page text as consent.
  const authorityText = authorityBeforeDataDelimiter(content).trim().replace(/\s+/gu, ' ')

  // Full control remains an exact, unqualified command. It is checked only
  // after the whole-command denial gate, so a suffix can never inherit it.
  if (FULL_CONTROL.test(content)
    && !RESTRICTED_SCOPE.test(content)
    && !BROAD_RESTRICTION.test(content)
    && ![CLICK_NEGATION, TYPE_NEGATION, KEY_NEGATION, SCROLL_NEGATION]
      .some(pattern => hasRegexMatch(content, pattern))) {
    return [...ALL_ACTIONS]
  }

  const mutations: ComputerAction[] = []
  if (hasUnnegatedAction(authorityText, CLICK_ACTION, CLICK_NEGATION)) mutations.push('click')
  if (hasUnnegatedAction(authorityText, TYPE_ACTION, TYPE_NEGATION)) mutations.push('type')
  if (hasUnnegatedAction(authorityText, KEY_ACTION, KEY_NEGATION)) mutations.push('key')
  if (hasUnnegatedAction(authorityText, SCROLL_ACTION, SCROLL_NEGATION)) mutations.push('scroll')

  // Fail closed on an unknown suffix. Observation exists only for a bare
  // recognized command, an explicit current read, or as the targeting/readback
  // prerequisite of an explicitly named mutation.
  if (!BARE_COMPUTER_USE_COMMAND.test(authorityText)
    && !READ_ACTION.test(authorityText)
    && mutations.length === 0) return []

  const actions = [...READ_ACTIONS, ...mutations]
  return actions
}

function authorityBeforeDataDelimiter(text: string): string {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '`' || char === '«' || char === '“' || char === '"' || char === '‘') {
      return text.slice(0, index)
    }
    if (char === "'") {
      const before = text[index - 1] ?? ''
      const after = text[index + 1] ?? ''
      // Apostrophes inside words (don't, user's) are language, not delimiters.
      if (!/[\p{L}\p{N}]/u.test(before) || !/[\p{L}\p{N}]/u.test(after)) {
        return text.slice(0, index)
      }
    }
  }
  return text
}

/**
 * Provenance gate for one run. Only a fresh user send from the visible composer
 * may grant desktop authority. Replayed checkpoints and main-owned synthetic
 * runs can contain user-shaped text, but that text is data, not fresh consent.
 */
export function allowedComputerUseActionsForRun(
  originalUserText: string | null,
  context: { resumeFromRunId?: string | null },
): readonly ComputerAction[] {
  if (!originalUserText || context.resumeFromRunId) return []
  const validated = validateComputerUseOriginalUserText(originalUserText)
  return deriveAllowedComputerUseActions(validated ? normalizeExplicitContent(validated) : null)
}

function hasUnnegatedAction(text: string, positive: RegExp, negative: RegExp): boolean {
  return positive.test(text.replace(negative, ' '))
}

function hasRegexMatch(text: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0
  const matched = pattern.test(text)
  pattern.lastIndex = 0
  return matched
}

/**
 * Fail-closed consent signal for the current ai:send.
 *
 * Only the latest original, interactive user turn is inspected. The matcher is
 * deliberately anchored at the start so quoted page/document text cannot grant
 * desktop input authority. This signal is an additional gate; a main-owned
 * selected-window binding and lineage claim are still required by the controller.
 */
export function isExplicitComputerUseRequest(messages: readonly OriginalUserMessage[]): boolean {
  return allowedComputerUseActions(messages).length > 0
}
