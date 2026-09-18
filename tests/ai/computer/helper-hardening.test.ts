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
  const secure = callback.indexOf('IsSecureSurface(armedIdentity.Hwnd, armedTitle, 64, 500)', armLock)
  const geometryRead = callback.indexOf('DwmGetWindowAttribute(armedIdentity.Hwnd', secure)
  const positiveGeometry = callback.indexOf(
    'if (geometry.Right <= geometry.Left || geometry.Bottom <= geometry.Top) return true;',
    geometryRead,
  )
  const snapshotAdd = callback.indexOf('snapshots.Add(new CandidateSnapshot', positiveGeometry)
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
    geometryRead > secure,
    positiveGeometry > geometryRead,
    snapshotAdd > positiveGeometry,
    (callback.match(/IsElevated\(/g)?.length ?? 0) === 1,
    (callback.match(/IsSecureSurface\(/g)?.length ?? 0) === 1,
    postEnumerationDrain > secure,
    generationRecheck > postEnumerationDrain,
    identityRecheck > generationRecheck,
  ].every(Boolean)
}

function bindingSurfaceBudgetIsPinned(source: string): boolean {
  const handler = source.match(
    /private\s+static\s+void\s+HandleProbe[\s\S]*?(?=\n\s*private\s+static\s+void\s+HandleObserve)/,
  )?.[0] ?? ''
  const probe = source.match(
    /private\s+static\s+WindowProbe\s+ProbeExact\s*\([\s\S]*?(?=\n\s*private\s+static\s+bool\s+IsDestroyedWindowInstance)/,
  )?.[0] ?? ''
  return /private\s+const\s+int\s+BindingSurfaceInspectionTimeoutMs\s*=\s*1500\s*;/.test(source)
    && /ProbeExact\s*\(\s*expected,\s*true,\s*MaxSurfaceInspectionElements,\s*BindingSurfaceInspectionTimeoutMs\s*\)/.test(handler)
    && /return\s+ProbeExact\s*\(\s*expected,\s*blockUnsafe,\s*MaxSurfaceInspectionElements,\s*MaxTargetCheckIntervalMs\s*\)\s*;/.test(probe)
    && /ProbeExact\s*\(\s*WindowIdentity\s+expected,\s*bool\s+blockUnsafe,\s*int\s+surfaceMaxElements,\s*int\s+surfaceMaxMilliseconds\s*\)/.test(probe)
    && /return\s+ProbeExact\s*\(\s*expected,\s*blockUnsafe,\s*surfaceMaxElements,\s*surfaceMaxMilliseconds,\s*true\s*\)\s*;/.test(probe)
    && /IsSecureSurface\s*\(\s*actual\.Hwnd,\s*title,\s*surfaceMaxElements,\s*surfaceMaxMilliseconds,\s*inspectSurfaceDescendants\s*\)/.test(probe)
}

function observationCaptureSurfaceBudgetIsPinned(source: string): boolean {
  const observe = source.match(
    /private\s+static\s+IDictionary<string, object>\s+ExecuteObserve[\s\S]*?(?=\n\s*private\s+static\s+void\s+RequireObservationBudget)/,
  )?.[0] ?? ''
  const capture = source.match(
    /private\s+static\s+string\s+CaptureExactWindowPng[\s\S]*?(?=\n\s*private\s+static\s+byte\[\]\s+EncodeWindowPng)/,
  )?.[0] ?? ''
  const lightweightIdentityProbes = observe.match(
    /ProbeExact\(\s*expected,\s*true,\s*MaxSurfaceInspectionElements,\s*MaxTargetCheckIntervalMs,\s*false\s*\)/g,
  ) ?? []
  return /private\s+const\s+int\s+ObservationSurfaceInspectionTimeoutMs\s*=\s*1500\s*;/.test(source)
    && lightweightIdentityProbes.length === 2
    && /HasUnsafeSurfaceDescendant\s*\(\s*expected\.Hwnd\s*,\s*MaxSurfaceInspectionElements\s*,\s*ObservationSurfaceInspectionTimeoutMs\s*\)/.test(capture)
    && /WindowProbe\s+after\s*=\s*ProbeExact\(\s*expected,\s*true,\s*MaxSurfaceInspectionElements,\s*ObservationSurfaceInspectionTimeoutMs\s*\)\s*;/.test(capture)
}

function observationDeadlineLeavesSurfaceScanHeadroom(source: string): boolean {
  return /private\s+const\s+int\s+ObservationSurfaceInspectionTimeoutMs\s*=\s*1500\s*;/.test(source)
    && /private\s+const\s+int\s+ObservationTimeoutMs\s*=\s*5000\s*;/.test(source)
}

function actionSurfaceScanPrecedesFastDispatchGuard(source: string): boolean {
  const prepare = source.match(
    /private\s+static\s+void\s+HandlePrepare[\s\S]*?(?=\n\s*private\s+static\s+void\s+HandleCommit)/,
  )?.[0] ?? ''
  const commit = source.match(
    /private\s+static\s+void\s+HandleCommit[\s\S]*?(?=\n\s*private\s+static\s+void\s+HandleCancel)/,
  )?.[0] ?? ''
  const timely = source.match(
    /private\s+static\s+void\s+RequireTimelyActionCurrent[\s\S]*?(?=\n\s*private\s+static\s+void\s+RequireDispatchWithinInterval)/,
  )?.[0] ?? ''
  const current = source.match(
    /private\s+static\s+void\s+RequireActionCurrent[\s\S]*?(?=\n\s*private\s+static\s+WindowProbe\s+ProbeExact)/,
  )?.[0] ?? ''
  const probe = source.match(
    /private\s+static\s+WindowProbe\s+ProbeExact[\s\S]*?(?=\n\s*private\s+static\s+bool\s+IsDestroyedWindowInstance)/,
  )?.[0] ?? ''
  const secure = source.match(
    /private\s+static\s+bool\s+IsSecureSurface[\s\S]*?(?=\n\s*private\s+static\s+bool\s+IsPassword)/,
  )?.[0] ?? ''

  const surfaceScan = timely.indexOf(
    'ProbeExact(action.Identity, true, MaxSurfaceInspectionElements, ActionSurfaceInspectionTimeoutMs);',
  )
  const fastTimer = timely.indexOf('Stopwatch timer = Stopwatch.StartNew();')
  const fastCurrent = timely.indexOf('RequireActionCurrent(action, expectedInput, true, cancellation);')

  return [
    /private\s+const\s+int\s+ActionSurfaceInspectionTimeoutMs\s*=\s*1500\s*;/.test(source),
    surfaceScan >= 0,
    fastTimer > surfaceScan,
    fastCurrent > fastTimer,
    /ProbeExact\s*\(\s*identity,\s*true,\s*MaxSurfaceInspectionElements,\s*ActionSurfaceInspectionTimeoutMs\s*\)/.test(prepare),
    /WindowProbe\s+before\s*=\s*ProbeExact\s*\(\s*prepared\.Identity,\s*true,\s*MaxSurfaceInspectionElements,\s*ActionSurfaceInspectionTimeoutMs\s*\)/.test(commit),
    /WindowProbe\s+after\s*=\s*ProbeExact\s*\(\s*prepared\.Identity,\s*false,\s*MaxSurfaceInspectionElements,\s*ActionSurfaceInspectionTimeoutMs\s*\)/.test(commit),
    /ProbeExact\s*\(\s*action\.Identity,\s*true,\s*MaxSurfaceInspectionElements,\s*MaxTargetCheckIntervalMs,\s*false\s*\)/.test(current),
    /bool\s+inspectSurfaceDescendants/.test(probe),
    /IsSecureSurface\s*\(\s*actual\.Hwnd,\s*title,\s*surfaceMaxElements,\s*surfaceMaxMilliseconds,\s*inspectSurfaceDescendants\s*\)/.test(probe),
    /return\s+inspectSurfaceDescendants\s*&&\s*HasUnsafeSurfaceDescendant\s*\(/.test(secure),
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

function statelessCoordinateClickEffectProofIsPinned(source: string): boolean {
  const click = source.match(
    /private\s+static\s+ExecutionOutcome\s+ExecuteClick[\s\S]*?(?=\n\s*private\s+static\s+ExecutionOutcome\s+ExecuteType)/,
  )?.[0] ?? ''
  const coordinate = click.slice(click.indexOf('POINT point = ActionPoint(action, entry);'))
  const beforeSurface = coordinate.indexOf('string pointerBeforeSurface = SurfaceStateFingerprint(action.Identity, cancellation);')
  const dispatch = coordinate.indexOf('SendMouseClick(action, entry, point);', beforeSurface)
  const inputEpoch = coordinate.indexOf('expectedInput = UserInputEpoch();', dispatch)
  const deadline = coordinate.indexOf('DateTime pointerDeadline = DateTime.UtcNow.AddMilliseconds(1200);', inputEpoch)
  const afterSurface = coordinate.indexOf('string pointerAfterSurface = SurfaceStateFingerprint(action.Identity, cancellation);', deadline)
  const proven = coordinate.indexOf(
    'if (!String.Equals(pointerBeforeSurface, pointerAfterSurface, StringComparison.Ordinal)) return Outcome(true, true);',
    afterSurface,
  )
  const uncertain = coordinate.indexOf('return Outcome(true, false);', proven)
  const fingerprint = source.match(
    /private\s+static\s+string\s+SurfaceStateFingerprint[\s\S]*?(?=\n\s*private\s+static\s+string\s+ChooseMethod)/,
  )?.[0] ?? ''
  const sendMouse = source.match(
    /private\s+static\s+void\s+SendMouseClick[\s\S]*?(?=\n\s*private\s+static\s+void\s+SendWheel)/,
  )?.[0] ?? ''
  const firstTargetCheck = sendMouse.indexOf('RequireSendInputTarget(action, entry, point);')
  const secondTargetCheck = sendMouse.indexOf('RequireSendInputTarget(action, entry, point);', firstTargetCheck + 1)
  const dispatchTimer = sendMouse.indexOf('Stopwatch dispatchTimer = Stopwatch.StartNew();', secondTargetCheck)
  const sendInput = sendMouse.indexOf('SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)))', dispatchTimer)
  const dispatchAccepted = sendMouse.indexOf('action.DispatchAccepted = true;', sendInput)
  const intervalProof = sendMouse.indexOf('RequireDispatchWithinInterval(dispatchTimer);', dispatchAccepted)
  const postTargetCheck = sendMouse.indexOf('RequireSendInputTarget(action, entry, point, false);', intervalProof)

  return /private\s+const\s+int\s+ActionEffectFingerprintElements\s*=\s*64\s*;/.test(source)
    && /if\s*\(count\+\+\s*>=\s*ActionEffectFingerprintElements\)\s*break\s*;/.test(fingerprint)
    && !fingerprint.includes('HasKeyboardFocus')
    && beforeSurface >= 0
    && dispatch > beforeSurface
    && inputEpoch > dispatch
    && deadline > inputEpoch
    && afterSurface > deadline
    && proven > afterSurface
    && uncertain > proven
    && (coordinate.match(/SendMouseClick\(/g)?.length ?? 0) === 1
    && !coordinate.includes('Stopwatch clickTimer = Stopwatch.StartNew();')
    && firstTargetCheck >= 0
    && secondTargetCheck > firstTargetCheck
    && dispatchTimer > secondTargetCheck
    && sendInput > dispatchTimer
    && dispatchAccepted > sendInput
    && intervalProof > dispatchAccepted
    && postTargetCheck > intervalProof
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

function automaticFocusUsesExactThreadAttachment(source: string): boolean {
  const focus = source.match(
    /private\s+static\s+void\s+HandleFocus[\s\S]*?(?=\n\s*private\s+static\s+void\s+HandleObserve)/,
  )?.[0] ?? ''
  const boundedSurfaceChecks = focus.match(
    /ProbeExact\(\s*expected,\s*true,\s*MaxSurfaceInspectionElements,\s*FocusSurfaceInspectionTimeoutMs\s*\)/g,
  ) ?? []
  const messageQueue = focus.indexOf(
    'PeekMessage(out currentThreadMessage, IntPtr.Zero, 0, 0, PmNoRemove);',
  )
  const firstAttach = focus.indexOf('AttachThreadInput(currentThread, foregroundThread, true)')
  return /AttachThreadInput\s*\(/.test(source)
    && /private\s+const\s+uint\s+PmNoRemove\s*=\s*0x0000\s*;/.test(source)
    && /private\s+static\s+extern\s+bool\s+PeekMessage\s*\(\s*out\s+MSG\s+message,\s*IntPtr\s+hwnd,\s*uint\s+min,\s*uint\s+max,\s*uint\s+remove\s*\)\s*;/.test(source)
    && messageQueue >= 0
    && firstAttach > messageQueue
    && boundedSurfaceChecks.length === 2
    && /AutomationElement\.FromHandle\(expected\.Hwnd\)[\s\S]*\.SetFocus\(\)/.test(focus)
    && /SwitchToThisWindow\s*\(\s*expected\.Hwnd,\s*true\s*\)/.test(focus)
    && /AttachThreadInput\s*\(\s*currentThread,\s*foregroundThread,\s*true\s*\)/.test(focus)
    && /AttachThreadInput\s*\(\s*currentThread,\s*targetThread,\s*true\s*\)/.test(focus)
    && /finally[\s\S]*AttachThreadInput\s*\(\s*currentThread,\s*targetThread,\s*false\s*\)[\s\S]*AttachThreadInput\s*\(\s*currentThread,\s*foregroundThread,\s*false\s*\)/.test(focus)
    && /if\s*\(!after\.Foreground\)\s*throw\s+new\s+SafeError\("focus_lost"/.test(focus)
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

function mutableRootTitleIsExcludedFromElementIdentity(source: string): boolean {
  const fingerprint = source.match(
    /private\s+static\s+string\s+CaptureElementFingerprint[\s\S]*?(?=\n\s*private\s+static\s+string\s+FingerprintPart)/,
  )?.[0] ?? ''
  return /bool\s+isRoot\s*=\s*Automation\.Compare\(current,\s*root\)\s*;/.test(fingerprint)
    && /FingerprintPart\(isRoot\s*\?\s*""\s*:\s*current\.Current\.Name\)/.test(fingerprint)
    && /if\s*\(isRoot\)\s*\{\s*reachedRoot\s*=\s*true;\s*break;\s*\}/.test(fingerprint)
}

function verifiedValueChunkRebasesOnlyMutableTitle(source: string): boolean {
  const executeType = source.match(
    /private\s+static\s+ExecutionOutcome\s+ExecuteType[\s\S]*?(?=\n\s*private\s+static\s+ExecutionOutcome\s+ExecuteKey)/,
  )?.[0] ?? ''
  const refresh = source.match(
    /private\s+static\s+void\s+RefreshExpectedAfterVerifiedValueEffect[\s\S]*?(?=\n\s*private\s+static\s+)/,
  )?.[0] ?? ''
  return /string\s+afterChunkValue\s*=\s*valuePattern\.Current\.Value\s*\?\?\s*""\s*;/.test(executeType)
    && /if\s*\(!String\.Equals\(afterChunkValue,\s*accumulated,\s*StringComparison\.Ordinal\)\)\s*return\s+Outcome\(true,\s*false\)\s*;/.test(executeType)
    && /RefreshExpectedAfterVerifiedValueEffect\(action,\s*entry,\s*afterChunkValue,\s*expectedInput,\s*cancellation\)\s*;/.test(executeType)
    && /RequireElementCurrent\(entry\)\s*;/.test(refresh)
    && /ProbeExact\(\s*action\.Identity,\s*true,\s*MaxSurfaceInspectionElements,\s*MaxTargetCheckIntervalMs,\s*false\s*\)/.test(refresh)
    && /current\.UserInputEpoch\s*!=\s*expectedInput[\s\S]*"hardware_input"/.test(refresh)
    && /action\.Expected\.Title\s*=\s*current\.Title\s*;/.test(refresh)
    && /action\.Expected\.TitleFingerprint\s*=\s*current\.TitleFingerprint\s*;/.test(refresh)
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

function exactWindowVisualObservationIsPinned(source: string): boolean {
  const capture = source.match(
    /private\s+static\s+string\s+CaptureExactWindowPng[\s\S]*?(?=\n\s*private\s+static\s+byte\[\]\s+EncodeWindowPng)/,
  )?.[0] ?? ''
  return /private\s+const\s+int\s+MaxScreenshotBytes\s*=\s*16384\s*;/.test(source)
    && /private\s+const\s+int\s+MaxScreenshotWidth\s*=\s*512\s*;/.test(source)
    && /private\s+const\s+int\s+MaxScreenshotHeight\s*=\s*384\s*;/.test(source)
    && /PrintWindow\s*\(\s*expected\.Hwnd\s*,\s*hdc\s*,\s*PrintWindowRenderFullContent\s*\)/.test(capture)
    && /SameIdentity\s*\(\s*expected\s*,\s*probe\.Identity\s*\)/.test(capture)
    && /!probe\.Foreground/.test(capture)
    && /probe\.ScreenLocked\s*\|\|\s*probe\.Elevated\s*\|\|\s*probe\.ProtectedProcess\s*\|\|\s*probe\.SecureSurface/.test(capture)
    && /HasUnsafeSurfaceDescendant\s*\(\s*expected\.Hwnd/.test(capture)
    && /cancellation\.ThrowIfCancellationRequested\s*\(\s*\)/.test(capture)
    && /ProbeExact\s*\(\s*expected\s*,\s*true\s*,\s*MaxSurfaceInspectionElements\s*,\s*ObservationSurfaceInspectionTimeoutMs\s*\)/.test(capture)
    && /"screenshotDataUrl"/.test(source)
    && !/(?:CopyFromScreen|BitBlt|GetDesktopWindow|GetDC\s*\(\s*IntPtr\.Zero|GetWindowDC)/.test(source)
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
  it('captures pixels only from the exact safe selected HWND with hard privacy bounds', () => {
    const source = helperSource()
    expect(exactWindowVisualObservationIsPinned(source)).toBe(true)

    const desktopMutation = source.replace(
      'PrintWindow(expected.Hwnd, hdc, PrintWindowRenderFullContent)',
      'CopyFromScreen(0, 0, 0, 0, source.Size)',
    )
    expect(desktopMutation).not.toBe(source)
    expect(exactWindowVisualObservationIsPinned(desktopMutation)).toBe(false)
  })

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

    const zeroGeometryMutation = source.replace(
      'if (geometry.Right <= geometry.Left || geometry.Bottom <= geometry.Top) return true;',
      '/* mutated: zero-area candidate reaches the wire */',
    )
    expect(zeroGeometryMutation).not.toBe(source)
    expect(candidatePrefilterIsArmedSafely(zeroGeometryMutation)).toBe(false)
  })

  it('uses a bounded one-time surface budget for binding while action probes retain the 50 ms guard', () => {
    const source = helperSource()
    expect(bindingSurfaceBudgetIsPinned(source)).toBe(true)

    const actionBudgetMutation = source.replace(
      'return ProbeExact(expected, blockUnsafe, MaxSurfaceInspectionElements, MaxTargetCheckIntervalMs);',
      'return ProbeExact(expected, blockUnsafe, MaxSurfaceInspectionElements, BindingSurfaceInspectionTimeoutMs);',
    )
    expect(actionBudgetMutation).not.toBe(source)
    expect(bindingSurfaceBudgetIsPinned(actionBudgetMutation)).toBe(false)
  })

  it('keeps the read-only screenshot safety rescan bounded without the 50 ms action deadline', () => {
    const source = helperSource()
    expect(observationCaptureSurfaceBudgetIsPinned(source)).toBe(true)

    const actionDeadlineMutation = source.replace(
      'HasUnsafeSurfaceDescendant(expected.Hwnd, MaxSurfaceInspectionElements, ObservationSurfaceInspectionTimeoutMs)',
      'HasUnsafeSurfaceDescendant(expected.Hwnd, MaxSurfaceInspectionElements, MaxTargetCheckIntervalMs)',
    )
    expect(actionDeadlineMutation).not.toBe(source)
    expect(observationCaptureSurfaceBudgetIsPinned(actionDeadlineMutation)).toBe(false)

    const probeDeadlineMutation = source.replace(
      /ProbeExact\(\s*expected,\s*true,\s*MaxSurfaceInspectionElements,\s*MaxTargetCheckIntervalMs,\s*false\s*\)/,
      'ProbeExact(expected, true)',
    )
    expect(probeDeadlineMutation).not.toBe(source)
    expect(observationCaptureSurfaceBudgetIsPinned(probeDeadlineMutation)).toBe(false)

    const postCaptureDeadlineMutation = source.replace(
      'WindowProbe after = ProbeExact(expected, true, MaxSurfaceInspectionElements, ObservationSurfaceInspectionTimeoutMs);',
      'WindowProbe after = ProbeExact(expected, true);',
    )
    expect(postCaptureDeadlineMutation).not.toBe(source)
    expect(observationCaptureSurfaceBudgetIsPinned(postCaptureDeadlineMutation)).toBe(false)
  })

  it('leaves enough total observation headroom for traversal, screenshot encoding, and the safety rescan', () => {
    const source = helperSource()
    expect(observationDeadlineLeavesSurfaceScanHeadroom(source)).toBe(true)

    const collapsedDeadlineMutation = source.replace(
      'private const int ObservationTimeoutMs = 5000;',
      'private const int ObservationTimeoutMs = 1500;',
    )
    expect(collapsedDeadlineMutation).not.toBe(source)
    expect(observationDeadlineLeavesSurfaceScanHeadroom(collapsedDeadlineMutation)).toBe(false)
  })

  it('finishes the fail-closed action surface scan before applying the 50 ms dispatch guard', () => {
    const source = helperSource()
    expect(actionSurfaceScanPrecedesFastDispatchGuard(source)).toBe(true)

    for (const mutation of [
      source.replace(
        'ProbeExact(identity, true, MaxSurfaceInspectionElements, ActionSurfaceInspectionTimeoutMs)',
        'ProbeExact(identity, true)',
      ),
      source.replace(
        'ProbeExact(prepared.Identity, true, MaxSurfaceInspectionElements, ActionSurfaceInspectionTimeoutMs)',
        'ProbeExact(prepared.Identity, true)',
      ),
      source.replace(
        'ProbeExact(prepared.Identity, false, MaxSurfaceInspectionElements, ActionSurfaceInspectionTimeoutMs)',
        'ProbeExact(prepared.Identity, false)',
      ),
    ]) {
      expect(mutation).not.toBe(source)
      expect(actionSurfaceScanPrecedesFastDispatchGuard(mutation)).toBe(false)
    }
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

  it('proves an exact stateless coordinate click only from a bounded surface change without retrying', () => {
    const source = helperSource()
    expect(statelessCoordinateClickEffectProofIsPinned(source)).toBe(true)

    const fingerprint = source.match(
      /private\s+static\s+string\s+SurfaceStateFingerprint[\s\S]*?(?=\n\s*private\s+static\s+string\s+ChooseMethod)/,
    )?.[0] ?? ''
    expect(fingerprint).not.toContain('HasKeyboardFocus')

    const proof = 'if (!String.Equals(pointerBeforeSurface, pointerAfterSurface, StringComparison.Ordinal)) return Outcome(true, true);'
    const coordinateStart = source.indexOf('POINT point = ActionPoint(action, entry);')
    const proofIndex = source.indexOf(proof, coordinateStart)
    const unprovenMutation = source.slice(0, proofIndex)
      + proof.replace('Outcome(true, true)', 'Outcome(true, false)')
      + source.slice(proofIndex + proof.length)
    expect(unprovenMutation).not.toBe(source)
    expect(statelessCoordinateClickEffectProofIsPinned(unprovenMutation)).toBe(false)
  })

  it('reports only the bounded safe-error code when a post-dispatch guard becomes uncertain', () => {
    const source = helperSource()
    expect(source).toContain(
      '"uncertain: post-dispatch safety check failed (" + error.Code + ")"',
    )
    expect(source).not.toContain(
      '"uncertain: post-dispatch safety check failed (" + error.Message + ")"',
    )
  })

  it('keeps exact post-click element identity but does not reject an already dispatched click only for a slow matching fingerprint', () => {
    const source = helperSource()
    const sendMouse = source.match(
      /private\s+static\s+void\s+SendMouseClick[\s\S]*?(?=\n\s*private\s+static\s+void\s+SendWheel)/,
    )?.[0] ?? ''
    const dispatchAccepted = sendMouse.indexOf('action.DispatchAccepted = true;')
    const postDispatch = sendMouse.indexOf(
      'RequireSendInputTarget(action, entry, point, false);',
      dispatchAccepted,
    )
    expect(dispatchAccepted).toBeGreaterThanOrEqual(0)
    expect(postDispatch).toBeGreaterThan(dispatchAccepted)
    expect(source).toMatch(
      /private\s+static\s+void\s+RequireElementCurrent\(ElementEntry entry, bool enforceInterval = true\)[\s\S]*?if\s*\(enforceInterval\s*&&\s*timer\.ElapsedMilliseconds\s*>\s*MaxTargetCheckIntervalMs\)/,
    )
    expect(source).toContain('RequireElementCurrent(entry, enforceElementInterval);')
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

  it('focuses only the exact bound window through a bounded attach and always detaches threads', () => {
    const source = helperSource()
    expect(automaticFocusUsesExactThreadAttachment(source)).toBe(true)

    const mutation = source.replace(
      'AttachThreadInput(currentThread, targetThread, false);',
      '/* mutated: target thread remains attached */',
    )
    expect(mutation).not.toBe(source)
    expect(automaticFocusUsesExactThreadAttachment(mutation)).toBe(false)

    const messageQueueMutation = source.replace(
      'PeekMessage(out currentThreadMessage, IntPtr.Zero, 0, 0, PmNoRemove);',
      '/* mutated: helper thread has no Win32 message queue */',
    )
    expect(messageQueueMutation).not.toBe(source)
    expect(automaticFocusUsesExactThreadAttachment(messageQueueMutation)).toBe(false)

    const timeoutMutation = source.replace(
      /ProbeExact\(\s*expected,\s*true,\s*MaxSurfaceInspectionElements,\s*FocusSurfaceInspectionTimeoutMs\s*\)/,
      'ProbeExact(expected, true)',
    )
    expect(timeoutMutation).not.toBe(source)
    expect(automaticFocusUsesExactThreadAttachment(timeoutMutation)).toBe(false)
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

  it('keeps a writable element stable when its own edit changes only the top-level window title', () => {
    const source = helperSource()
    expect(mutableRootTitleIsExcludedFromElementIdentity(source)).toBe(true)

    const mutation = source.replace(
      'FingerprintPart(isRoot ? "" : current.Current.Name)',
      'FingerprintPart(current.Current.Name)',
    )
    expect(mutation).not.toBe(source)
    expect(mutableRootTitleIsExcludedFromElementIdentity(mutation)).toBe(false)
  })

  it('adopts a self-caused title change only after an exact ValuePattern chunk and no input drift', () => {
    const source = helperSource()
    expect(verifiedValueChunkRebasesOnlyMutableTitle(source)).toBe(true)

    const mutation = source.replace(
      'action.Expected.Title = current.Title;',
      '/* mutated: next chunk still uses the pre-effect title */',
    )
    expect(mutation).not.toBe(source)
    expect(verifiedValueChunkRebasesOnlyMutableTitle(mutation)).toBe(false)
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
