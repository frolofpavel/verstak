import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()

function helperSource(): string {
  return readFileSync(join(ROOT, 'resources', 'computer-use', 'helper.ps1'), 'utf8')
}

function candidatePrefilterIsArmedSafely(source: string): boolean {
  const handler = source.match(
    /private\s+static\s+void\s+HandleListCandidates[\s\S]*?(?=\n\s*private\s+static\s+void\s+HandleProbe)/,
  )?.[0] ?? ''
  const callback = handler.slice(handler.indexOf('EnumWindows(delegate'))
  const prefilterIdentity = callback.indexOf('TryIdentity(hwnd, out prefilteredIdentity)')
  const prefilterTitle = callback.indexOf('string prefilteredTitle = NormalizeWindowTitle(WindowText(hwnd));')
  const prefilterBlocked = callback.indexOf('IsBlockedApplication(prefilteredIdentity, prefilteredTitle)')
  const armLock = callback.indexOf('lock (WindowLifecycleLock)')
  const lifecycleArm = callback.indexOf('TryWatchWindowLifecycle(hwnd, out destroyGeneration)', armLock)
  const armedIdentity = callback.indexOf('TryIdentity(hwnd, out armedIdentity)', lifecycleArm)
  const armedSameIdentity = callback.indexOf('SameIdentity(armedIdentity, prefilteredIdentity)', armedIdentity)
  const armedTitle = callback.indexOf('armedTitle = NormalizeWindowTitle(WindowText(hwnd));', armedIdentity)
  const armedSameTitle = callback.indexOf('String.Equals(armedTitle, prefilteredTitle, StringComparison.Ordinal)', armedTitle)
  const armedBlocked = callback.indexOf('IsBlockedApplication(armedIdentity, armedTitle)', armedTitle)
  const elevated = callback.indexOf('IsElevated(armedIdentity.Pid', armLock)
  const secure = callback.indexOf('IsSecureSurface(armedIdentity.Hwnd, armedTitle, 64, 20)', armLock)
  const postEnumerationDrain = callback.indexOf('DrainForegroundEvents();', callback.indexOf('}, IntPtr.Zero);'))
  const generationRecheck = callback.indexOf(
    'snapshot.DestroyGeneration != WindowDestroyGeneration(snapshot.Identity.Hwnd)',
    postEnumerationDrain,
  )
  const identityRecheck = callback.indexOf('TryIdentity(snapshot.Identity.Hwnd, out actual)', generationRecheck)

  return [
    prefilterIdentity >= 0,
    prefilterTitle > prefilterIdentity,
    prefilterBlocked > prefilterTitle,
    armLock > prefilterBlocked,
    lifecycleArm > armLock,
    armedIdentity > lifecycleArm,
    armedSameIdentity > armedIdentity,
    armedTitle > armedSameIdentity,
    armedSameTitle > armedTitle,
    armedBlocked > armedTitle,
    elevated > armedBlocked,
    secure > elevated,
    (callback.match(/IsElevated\(/g)?.length ?? 0) === 1,
    (callback.match(/IsSecureSurface\(/g)?.length ?? 0) === 1,
    postEnumerationDrain > secure,
    generationRecheck > postEnumerationDrain,
    identityRecheck > generationRecheck,
  ].every(Boolean)
}

function ownerCreationIdentityIsPinned(source: string): boolean {
  const watchdog = source.match(
    /private\s+static\s+void\s+StartOwnerWatchdog[\s\S]*?(?=\n\s*private\s+static\s+void\s+StartInputHooks)/,
  )?.[0] ?? ''
  const creationQuery = watchdog.indexOf('GetProcessTimes(owner, out creation')
  const exactCreation = watchdog.indexOf('string actualOwnerStartTime100ns = FileTime100ns(creation);', creationQuery)
  const comparison = watchdog.indexOf(
    'String.Equals(actualOwnerStartTime100ns, ownerStartTime100ns, StringComparison.Ordinal)',
    exactCreation,
  )
  const saveHandle = watchdog.indexOf('OwnerProcessHandle = owner;', comparison)
  return /\[ValidatePattern\('\^\[1-9\]\[0-9\]\*\$'\)\][\s\S]{0,80}\[string\]\$OwnerStartTime100ns/.test(source)
    && /public\s+static\s+void\s+Run\s*\(\s*int\s+ownerPid,\s*string\s+ownerStartTime100ns\s*\)/.test(source)
    && /StartOwnerWatchdog\s*\(\s*ownerPid,\s*ownerStartTime100ns\s*\)\s*;/.test(source)
    && /\[VerstakComputerUse\.Helper\]::Run\(\$OwnerPid,\s*\$OwnerStartTime100ns\)/.test(source)
    && /private\s+static\s+string\s+FileTime100ns\s*\(\s*FILETIME\s+value\s*\)/.test(source)
    && creationQuery >= 0
    && exactCreation > creationQuery
    && comparison > exactCreation
    && /CloseHandle\s*\(\s*owner\s*\)[\s\S]*owner process identity changed/.test(watchdog)
    && saveHandle > comparison
}

function authenticationBoundaryIsPinned(source: string): boolean {
  const secureSurface = source.match(
    /private\s+static\s+bool\s+IsSecureSurface\s*\(\s*IntPtr\s+hwnd,\s*string\s+title,\s*int\s+maxElements[\s\S]*?(?=\n\s*private\s+static\s+bool\s+IsPassword)/,
  )?.[0] ?? ''
  const authControl = source.match(
    /private\s+static\s+bool\s+IsAuthenticationControl[\s\S]*?(?=\n\s*private\s+static\s+bool\s+ContainsCredentialMarker)/,
  )?.[0] ?? ''
  const blockedMarkers = authControl.match(/string\[\]\s+blocked\s*=\s*\{[\s\S]*?\};/)?.[0] ?? ''
  return [
    /private\s+static\s+bool\s+ContainsUnicodeToken\s*\(/.test(source),
    /Char\.IsLetterOrDigit\s*\(\s*value,\s*previous\s*\)/.test(source),
    /Char\.IsLetterOrDigit\s*\(\s*value,\s*index\s*\)/.test(source),
    /ContainsStandaloneOtpOrPin\s*\(\s*joined\s*\)/.test(secureSurface),
    /ContainsStandaloneOtpOrPin\s*\(\s*marker\s*\)/.test(authControl),
    !/\.Contains\s*\(\s*"(?:otp|пин)"\s*\)/.test(secureSurface),
    !/"(?:otp|пин)"\s*,/.test(blockedMarkers),
    /"otp code"[\s\S]*"totp"[\s\S]*"verification pin"/.test(source),
    /ValidateAuthenticationTokenBoundaryContract\s*\(\s*\)\s*;/.test(source),
    /"Спинка"[\s\S]*"Пинтерест"[\s\S]*"prototype"[\s\S]*"desktop"/.test(source),
  ].every(Boolean)
}

function toggleTransitionGuardIsPinned(source: string): boolean {
  const prepare = source.match(
    /private\s+static\s+void\s+HandlePrepare[\s\S]*?(?=\n\s*private\s+static\s+void\s+HandleCommit)/,
  )?.[0] ?? ''
  const click = source.match(
    /private\s+static\s+ExecutionOutcome\s+ExecuteClick[\s\S]*?(?=\n\s*private\s+static\s+ExecutionOutcome\s+ExecuteType)/,
  )?.[0] ?? ''
  const toggleBranch = click.slice(click.indexOf('TogglePattern toggle ='))
  const timely = toggleBranch.indexOf('RequireTimelyActionCurrent(action, expectedInput, cancellation);')
  const current = toggleBranch.indexOf('ToggleState before = toggle.Current.ToggleState;', timely)
  const exactBefore = toggleBranch.indexOf('RequireExpectedElementTransition(action, "toggle", SafeToggleState(before));', current)
  const dispatch = toggleBranch.indexOf('toggle.Toggle();', exactBefore)
  const exactAfter = toggleBranch.indexOf('MatchesExpectedElementTransition(action, "toggle", SafeToggleState(after))', dispatch)

  return prepare.includes('ParseExpectedElementTransition((IDictionary<string, object>)resolvedValue, prepared);')
    && /kind == "toggle"[\s\S]*before == "off"[\s\S]*after == "on"[\s\S]*before == "on"[\s\S]*after == "off"/.test(source)
    && timely >= 0
    && current > timely
    && exactBefore > current
    && dispatch > exactBefore
    && exactAfter > dispatch
}

function helperBlocksProcess(source: string, processName: string): boolean {
  const blockedApplication = source.match(
    /private\s+static\s+bool\s+IsBlockedApplication[\s\S]*?(?=\n\s*private\s+static\s+string\s+FileTime100ns)/,
  )?.[0] ?? ''
  const array = blockedApplication.match(/string\[\]\s+blockedProcesses\s*=\s*\{([\s\S]*?)\};/)?.[1] ?? ''
  const names = new Set([...array.matchAll(/"([^"]+)"/g)].map(match => match[1]!.toLowerCase()))
  return names.has(processName.toLowerCase())
}

function browserApplicationBoundaryIsPinned(source: string): boolean {
  const blockedApplication = source.match(
    /private\s+static\s+bool\s+IsBlockedApplication[\s\S]*?(?=\n\s*private\s+static\s+string\s+FileTime100ns)/,
  )?.[0] ?? ''
  return [
    '"browser"', '"yandex"', '"yandexbrowser"', '"arc"', '"duckduckgo"',
    '"zen"', '"floorp"', 'chrome_widgetwin_', 'mozillawindowclass',
    'productname',
  ].every(marker => blockedApplication.toLocaleLowerCase('en-US').includes(marker))
}

function valuePatternStateGuardIsPinned(source: string): boolean {
  const observe = source.match(
    /private\s+static\s+IDictionary<string, object>\s+ExecuteObserve[\s\S]*?(?=\n\s*private\s+static\s+void\s+RequireObservationBudget)/,
  )?.[0] ?? ''
  const prepare = source.match(
    /private\s+static\s+void\s+HandlePrepare[\s\S]*?(?=\n\s*private\s+static\s+void\s+HandleCommit)/,
  )?.[0] ?? ''
  const type = source.match(
    /private\s+static\s+ExecutionOutcome\s+ExecuteType[\s\S]*?(?=\n\s*private\s+static\s+ExecutionOutcome\s+ExecuteKey)/,
  )?.[0] ?? ''
  const current = type.indexOf('string currentValue = valuePattern.Current.Value ?? "";')
  const exact = type.indexOf('RequireExpectedValueState(action, currentValue);', current)
  const setValue = type.indexOf('valuePattern.SetValue(accumulated);', exact)
  const nextChunkExact = type.indexOf('!String.Equals(currentValue, accumulated, StringComparison.Ordinal)', exact)
  const finalExact = type.indexOf('MatchesExpectedAfterValueState(action, afterValue)', setValue)

  return observe.includes('item["valueState"] = ValueStateObject(element);')
    && prepare.includes('ParseExpectedValueState((IDictionary<string, object>)resolvedValue, prepared);')
    && prepare.includes('PrepareExpectedAfterValueState(prepared, entry);')
    && prepare.includes('prepareResponse["expectedAfterValueState"]')
    && /Hash\(Salt \+ ":value-state:" \+ value\)/.test(source)
    && /"fingerprint"[\s\S]*"scalarLength"/.test(source)
    && current >= 0
    && exact > current
    && setValue > exact
    && nextChunkExact > exact
    && nextChunkExact < setValue
    && finalExact > setValue
}

function scrollStateGuardIsPinned(source: string): boolean {
  const observe = source.match(
    /private\s+static\s+IDictionary<string, object>\s+ExecuteObserve[\s\S]*?(?=\n\s*private\s+static\s+void\s+RequireObservationBudget)/,
  )?.[0] ?? ''
  const prepare = source.match(
    /private\s+static\s+void\s+HandlePrepare[\s\S]*?(?=\n\s*private\s+static\s+void\s+HandleCommit)/,
  )?.[0] ?? ''
  const scroll = source.match(
    /private\s+static\s+ExecutionOutcome\s+ExecuteScroll[\s\S]*?(?=\n\s*private\s+static\s+ExecutionOutcome\s+Outcome)/,
  )?.[0] ?? ''
  const timely = scroll.indexOf('RequireTimelyActionCurrent(action, expectedInput, cancellation);')
  const current = scroll.indexOf('double beforeHorizontal = scroll.Current.HorizontalScrollPercent;', timely)
  const exact = scroll.indexOf('RequireExpectedScrollState(action, beforeHorizontal, beforeVertical);', current)
  const dispatch = scroll.indexOf('scroll.Scroll(horizontal, vertical);', exact)
  const signedPost = scroll.indexOf('ScrollDirectionMatched(action.DeltaX, beforeHorizontal, afterHorizontal)', dispatch)

  return observe.includes('item["scrollState"] = ScrollStateObject(element);')
    && prepare.includes('ParseExpectedScrollState((IDictionary<string, object>)resolvedValue, prepared);')
    && timely >= 0
    && current > timely
    && exact > current
    && dispatch > exact
    && signedPost > dispatch
    && source.includes('if (delta == 0) return before == after;')
}

function unicodeToken(value: string, token: string): boolean {
  let from = 0
  while (from <= value.length - token.length) {
    const index = value.toLocaleLowerCase('en-US').indexOf(token, from)
    if (index < 0) return false
    const before = index === 0 ? '' : String.fromCodePoint(value.codePointAt(index - 1)!)
    const end = index + token.length
    const after = end >= value.length ? '' : String.fromCodePoint(value.codePointAt(end)!)
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true
    from = index + token.length
  }
  return false
}

describe('computer helper hardening contracts', () => {
  it('prefilters 130 ineligible windows before lifecycle-arm and retains a following valid window', () => {
    const source = helperSource()
    expect(candidatePrefilterIsArmedSafely(source)).toBe(true)

    const windows = [...Array.from({ length: 130 }, () => false), true]
    const list = (prefilterBeforeArm: boolean): boolean[] => {
      let armed = 0
      return windows.filter(eligible => {
        if (prefilterBeforeArm && !eligible) return false
        if (armed >= 130) return false
        armed += 1
        return eligible
      })
    }
    expect(list(true)).toEqual([true])
    expect(list(false)).toEqual([])

    const armFirstMutation = source.replace(
      'if (!TryIdentity(hwnd, out prefilteredIdentity)',
      'if (false /* mutated: no cheap identity prefilter before lifecycle arm */',
    )
    expect(armFirstMutation).not.toBe(source)
    expect(candidatePrefilterIsArmedSafely(armFirstMutation)).toBe(false)
  })

  it('pins the exact owner creation FILETIME before the watchdog handle is retained', () => {
    const source = helperSource()
    expect(ownerCreationIdentityIsPinned(source)).toBe(true)

    const pidOnlyMutation = source.replace(
      'if (!String.Equals(actualOwnerStartTime100ns, ownerStartTime100ns, StringComparison.Ordinal))',
      'if (false /* mutated: PID reuse accepted */)',
    )
    expect(pidOnlyMutation).not.toBe(source)
    expect(ownerCreationIdentityIsPinned(pidOnlyMutation)).toBe(false)
  })

  it.each([
    ['otp', true],
    ['OTP code', true],
    ['otp_input', true],
    ['пин', true],
    ['ПИН-код', true],
    ['field_пин', true],
    ['Спинка', false],
    ['Пинтерест', false],
    ['prototype', false],
    ['desktop', false],
  ])('uses Unicode letter/digit boundaries for %s', (label, blocked) => {
    expect(unicodeToken(label, 'otp') || unicodeToken(label, 'пин')).toBe(blocked)
  })

  it('routes both window and UIA control paths through the startup-validated boundary matcher', () => {
    const source = helperSource()
    expect(authenticationBoundaryIsPinned(source)).toBe(true)

    const substringMutation = source.replace(
      'ContainsStandaloneOtpOrPin(joined)',
      'joined.Contains("otp") || joined.Contains("пин")',
    )
    expect(substringMutation).not.toBe(source)
    expect(authenticationBoundaryIsPinned(substringMutation)).toBe(false)
  })

  it('pins exact observed Toggle pre/post state immediately around Toggle()', () => {
    const source = helperSource()
    expect(toggleTransitionGuardIsPinned(source)).toBe(true)

    const staleStateMutation = source.replace(
      'RequireExpectedElementTransition(action, "toggle", SafeToggleState(before));',
      '/* mutated: stale ToggleState accepted */',
    )
    expect(staleStateMutation).not.toBe(source)
    expect(toggleTransitionGuardIsPinned(staleStateMutation)).toBe(false)
  })

  it('denies common browser executables while retaining ordinary desktop canaries', () => {
    const source = helperSource()
    const browsers = [
      'chrome', 'chrome_proxy', 'google-chrome',
      'msedge', 'msedgewebview2',
      'firefox', 'firefox-esr',
      'brave', 'brave-browser',
      'opera', 'opera_gx',
      'chromium', 'chromium-browser',
      'vivaldi', 'waterfox', 'librewolf',
      'browser', 'yandex', 'yandexbrowser', 'arc', 'duckduckgo', 'zen', 'floorp',
    ]
    for (const processName of browsers) {
      expect(helperBlocksProcess(source, processName), processName).toBe(true)
    }
    for (const processName of ['notepad', 'mspaint', 'winword']) {
      expect(helperBlocksProcess(source, processName), processName).toBe(false)
    }

    for (const processName of [
      'systemsettings', 'systemsettingsadminflows', 'control', 'controlpanel',
      'mmc', 'secpol', 'sechealthui',
    ]) {
      expect(helperBlocksProcess(source, processName), processName).toBe(true)
    }

    const chromeMutation = source.replace('"chrome",', '"mutated-browser-gap",')
    expect(chromeMutation).not.toBe(source)
    expect(helperBlocksProcess(chromeMutation, 'chrome')).toBe(false)

    expect(browserApplicationBoundaryIsPinned(source)).toBe(true)
    const classMutation = source.replace('"chrome_widgetwin_",', '"mutated-browser-class",')
    expect(classMutation).not.toBe(source)
    expect(browserApplicationBoundaryIsPinned(classMutation)).toBe(false)
  })

  it('pins a salted opaque ValuePattern state immediately before SetValue()', () => {
    const source = helperSource()
    expect(valuePatternStateGuardIsPinned(source)).toBe(true)

    const staleValueMutation = source.replace(
      'RequireExpectedValueState(action, currentValue);',
      '/* mutated: stale ValuePattern state accepted */',
    )
    expect(staleValueMutation).not.toBe(source)
    expect(valuePatternStateGuardIsPinned(staleValueMutation)).toBe(false)

    const finalTokenMutation = source.replace(
      'PrepareExpectedAfterValueState(prepared, entry);',
      '/* mutated: no effect-free expected-after token */',
    )
    expect(finalTokenMutation).not.toBe(source)
    expect(valuePatternStateGuardIsPinned(finalTokenMutation)).toBe(false)
  })

  it('pins exact ScrollPattern pre-state and signed post direction around Scroll()', () => {
    const source = helperSource()
    expect(scrollStateGuardIsPinned(source)).toBe(true)
    expect(source.match(/OptionalInt\((?:scroll|action), "delta[XY]", 0, -1, 1\)/g)).toHaveLength(4)

    const staleScrollMutation = source.replace(
      'RequireExpectedScrollState(action, beforeHorizontal, beforeVertical);',
      '/* mutated: stale ScrollPattern state accepted */',
    )
    expect(staleScrollMutation).not.toBe(source)
    expect(scrollStateGuardIsPinned(staleScrollMutation)).toBe(false)

    const unsignedMutation = source.replace(
      'ScrollDirectionMatched(action.DeltaX, beforeHorizontal, afterHorizontal)',
      'beforeHorizontal != afterHorizontal /* mutated: opposite direction accepted */',
    )
    expect(unsignedMutation).not.toBe(source)
    expect(scrollStateGuardIsPinned(unsignedMutation)).toBe(false)

    const crossAxisMutation = source.replace(
      'if (delta == 0) return before == after;',
      'if (delta == 0) return true;',
    )
    expect(crossAxisMutation).not.toBe(source)
    expect(scrollStateGuardIsPinned(crossAxisMutation)).toBe(false)

    const rangeMutation = source.replace(
      'OptionalInt(scroll, "deltaX", 0, -1, 1)',
      'OptionalInt(scroll, "deltaX", 0, -2000, 2000)',
    )
    expect(rangeMutation).not.toBe(source)
    expect(rangeMutation.match(/OptionalInt\((?:scroll|action), "delta[XY]", 0, -1, 1\)/g)).toHaveLength(3)
  })
})
