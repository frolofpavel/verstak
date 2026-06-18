import type { ReleaseNote } from './update-remote'
import {
  getAllBundledReleaseNotes as getRaynerAll,
  getBundledReleaseNote as getRaynerOne,
  getBundledReleaseNotesInRange as getRaynerRange,
  mergeReleaseNotes,
} from './rayner-changelog'
import {
  getAllOfficialReleaseNotes,
  getOfficialReleaseNote,
  getOfficialReleaseNotesInRange,
} from './official-changelog'

export { mergeReleaseNotes }

function allBundledSources(): ReleaseNote[] {
  return [...getRaynerAll(), ...getAllOfficialReleaseNotes()]
}

export function getAllBundledReleaseNotes(): ReleaseNote[] {
  return mergeReleaseNotes([], allBundledSources())
}

export function getBundledReleaseNote(version: string): ReleaseNote | undefined {
  const rayner = getRaynerOne(version)
  const official = getOfficialReleaseNote(version)
  const merged = mergeReleaseNotes([], [rayner, official].filter((n): n is ReleaseNote => !!n))
  return merged[0]
}

export function getBundledReleaseNotesInRange(sinceVersion: string, upToVersion: string): ReleaseNote[] {
  const rayner = getRaynerRange(sinceVersion, upToVersion)
  const official = getOfficialReleaseNotesInRange(sinceVersion, upToVersion)
  return mergeReleaseNotes([], [...rayner, ...official])
}