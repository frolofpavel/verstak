const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const OBSERVATION_REF_RE = new RegExp(`^wo-${UUID_RE}$`, 'i')
const ELEMENT_REF_RE = new RegExp(`^we-${UUID_RE}$`, 'i')

/** Only refs minted by the main-process controller may cross into routing. */
export function isComputerObservationRef(value: unknown): value is string {
  return typeof value === 'string' && value.length === 39 && OBSERVATION_REF_RE.test(value)
}

export function isComputerElementRef(value: unknown): value is string {
  return typeof value === 'string' && value.length === 39 && ELEMENT_REF_RE.test(value)
}
