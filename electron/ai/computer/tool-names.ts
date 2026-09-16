import type { ComputerAction } from './types'

/** Exact built-in desktop capability surface; prefixes are not authority. */
export const COMPUTER_TOOL_ACTION = {
  computer_observe: 'observe',
  computer_click: 'click',
  computer_type: 'type',
  computer_key: 'key',
  computer_scroll: 'scroll',
  computer_wait_for: 'wait_for',
} as const satisfies Record<string, ComputerAction>

const COMPUTER_TOOL_NAMES = new Set<string>(Object.keys(COMPUTER_TOOL_ACTION))

export function isComputerToolName(name: string): name is keyof typeof COMPUTER_TOOL_ACTION {
  return COMPUTER_TOOL_NAMES.has(name)
}
