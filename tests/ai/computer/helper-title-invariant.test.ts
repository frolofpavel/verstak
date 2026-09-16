import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function hasNativeTitlePins(source: string): boolean {
  const windowProbe = source.match(/private sealed class WindowProbe[\s\S]*?\n\s*\}/u)?.[0] ?? ''
  const probeExact = source.match(/private static WindowProbe ProbeExact[\s\S]*?(?=\n\s*private static bool IsDestroyedWindowInstance)/u)?.[0] ?? ''
  const parseExpected = source.match(/private static WindowProbe ParseExpected[\s\S]*?(?=\n\s*private static WindowIdentity ParseIdentity)/u)?.[0] ?? ''
  const requireExpected = source.match(/private static void RequireExpected[\s\S]*?(?=\n\s*private static POINT ActionPoint)/u)?.[0] ?? ''
  const requireActionCurrent = source.match(/private static void RequireActionCurrent[\s\S]*?(?=\n\s*private static WindowProbe ProbeExact)/u)?.[0] ?? ''
  const handleCommit = source.match(/private static void HandleCommit[\s\S]*?(?=\n\s*private static void HandleCancel)/u)?.[0] ?? ''
  const windowText = source.match(/private static string WindowText[\s\S]*?(?=\n\s*private static string WindowClass)/u)?.[0] ?? ''
  const normalizeTitle = source.match(/private static string NormalizeWindowTitle[\s\S]*?(?=\n\s*private static string DisplayWindowTitle)/u)?.[0] ?? ''
  return [
    /public string Title\s*;/u.test(windowProbe),
    /public string TitleFingerprint\s*;/u.test(windowProbe),
    /string\s+title\s*=\s*NormalizeWindowTitle\s*\(\s*WindowText\s*\(\s*actual\.Hwnd\s*\)\s*\)/u.test(probeExact),
    /Title\s*=\s*DisplayWindowTitle\s*\(\s*title\s*\)\s*,\s*TitleFingerprint\s*=\s*WindowTitleFingerprint\s*\(\s*title\s*\)/u.test(probeExact),
    /Title\s*=\s*RequiredString\s*\(\s*value\s*,\s*"title"\s*,\s*MaxWindowTitleDisplayChars\s*\)/u.test(parseExpected),
    /TitleFingerprint\s*=\s*RequiredString\s*\(\s*value\s*,\s*"titleFingerprint"\s*,\s*64\s*\)/u.test(parseExpected),
    /String\.Equals\s*\(\s*expected\.Title\s*,\s*current\.Title\s*,\s*StringComparison\.Ordinal\s*\)/u.test(requireExpected),
    /String\.Equals\s*\(\s*expected\.TitleFingerprint\s*,\s*current\.TitleFingerprint\s*,\s*StringComparison\.Ordinal\s*\)/u.test(requireExpected),
    /String\.Equals\s*\(\s*action\.Expected\.Title\s*,\s*current\.Title\s*,\s*StringComparison\.Ordinal\s*\)/u.test(requireActionCurrent),
    /String\.Equals\s*\(\s*action\.Expected\.TitleFingerprint\s*,\s*current\.TitleFingerprint\s*,\s*StringComparison\.Ordinal\s*\)/u.test(requireActionCurrent),
    /RequireExpected\s*\(\s*prepared\.Expected\s*,\s*before\s*,\s*true\s*\)/u.test(handleCommit),
    /GetWindowTextLength\s*\(\s*hwnd\s*\)/u.test(windowText),
    /beforeLength\s*>\s*MaxWindowTitleChars/u.test(windowText),
    /copied\s*!=\s*afterLength/u.test(windowText),
    !/Substring\s*\(\s*0\s*,\s*300\s*\)/u.test(normalizeTitle),
    /Hash\s*\(\s*"window-title\|"\s*\+\s*normalizedTitle\s*\)/u.test(source),
  ].every(Boolean)
}

describe('computer helper exact title invariant', () => {
  it('pins normalized title from probe through prepare and final pre-dispatch check', () => {
    const source = readFileSync(join(process.cwd(), 'resources', 'computer-use', 'helper.ps1'), 'utf8')
    expect(hasNativeTitlePins(source)).toBe(true)

    const prepareMutation = source.replace(
      'String.Equals(expected.Title, current.Title, StringComparison.Ordinal)',
      'true',
    )
    expect(prepareMutation).not.toBe(source)
    expect(hasNativeTitlePins(prepareMutation)).toBe(false)

    const dispatchMutation = source.replace(
      'String.Equals(action.Expected.Title, current.Title, StringComparison.Ordinal)',
      'true',
    )
    expect(dispatchMutation).not.toBe(source)
    expect(hasNativeTitlePins(dispatchMutation)).toBe(false)

    const fullTitleMutation = source.replace(
      'TitleFingerprint = WindowTitleFingerprint(title)',
      'TitleFingerprint = Hash(DisplayWindowTitle(title))',
    )
    expect(fullTitleMutation).not.toBe(source)
    expect(hasNativeTitlePins(fullTitleMutation)).toBe(false)

    const fingerprintMutation = source.replace(
      'String.Equals(expected.TitleFingerprint, current.TitleFingerprint, StringComparison.Ordinal)',
      'true',
    )
    expect(fingerprintMutation).not.toBe(source)
    expect(hasNativeTitlePins(fingerprintMutation)).toBe(false)
  })
})
