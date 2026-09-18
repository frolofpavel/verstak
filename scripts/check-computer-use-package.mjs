#!/usr/bin/env node
// Fail-closed inspection for the Windows Computer Use helper. It reads only
// reviewed source and an isolated packaged tree. The optional smoke sends only
// hello/ping/shutdown and cannot bind to or act on a desktop window.

import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'

const sha256 = value => createHash('sha256').update(value).digest('hex')
const MAX_LINE_BYTES = 64 * 1024
// Keep the read-only packaged smoke aligned with the production client. A
// canonical System32 PowerShell cold start can exceed one second under the
// full gate load; the query remains bounded and fails before helper spawn.
const OWNER_IDENTITY_QUERY_TIMEOUT_MS = 3_000
const OWNER_IDENTITY_QUERY_MAX_BYTES = 4_096
const CANONICAL_FILETIME_PATTERN = /^[1-9][0-9]*$/
const SYSTEM_POWERSHELL_PARTS = [
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
]
const SYSTEM_ROOT_AT_MODULE_LOAD = process.platform === 'win32' ? process.env.SystemRoot : undefined

export function resolveSystemPowerShellPath() {
  const rawSystemRoot = SYSTEM_ROOT_AT_MODULE_LOAD
  if (!rawSystemRoot || !win32.isAbsolute(rawSystemRoot)) {
    throw new Error('system PowerShell path is unavailable')
  }
  try {
    const canonicalSystemRoot = realpathSync.native(rawSystemRoot)
    if (win32.normalize(rawSystemRoot).toLocaleLowerCase('en-US')
      !== win32.normalize(canonicalSystemRoot).toLocaleLowerCase('en-US')) {
      throw new Error('system PowerShell path is not canonical')
    }
    const systemDirectory = win32.join(canonicalSystemRoot, 'System32')
    const expected = realpathSync.native(win32.join(canonicalSystemRoot, ...SYSTEM_POWERSHELL_PARTS))
    const relative = win32.relative(systemDirectory, expected)
    if (!relative || relative.startsWith('..') || win32.isAbsolute(relative) || !statSync(expected).isFile()) {
      throw new Error('system PowerShell path is not canonical')
    }
    return expected
  } catch (error) {
    if (error instanceof Error && /not canonical/.test(error.message)) throw error
    throw new Error('system PowerShell path is unavailable')
  }
}

export function queryWindowsProcessStartTime100ns(ownerPid, spawnSyncImpl = spawnSync) {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || ownerPid > 2_147_483_647) {
    throw new Error('owner PID is invalid')
  }
  const command = [
    `$owner = Get-Process -Id ${String(ownerPid)} -ErrorAction Stop`,
    "if ($owner.HasExited) { throw 'owner unavailable' }",
    '$start = $owner.StartTime.ToFileTimeUtc()',
    "if ($owner.HasExited) { throw 'owner unavailable' }",
    '[Console]::Out.Write($start.ToString([System.Globalization.CultureInfo]::InvariantCulture))',
  ].join('; ')
  const result = spawnSyncImpl(resolveSystemPowerShellPath(), [
    '-NoProfile', '-NonInteractive', '-Command', command,
  ], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: OWNER_IDENTITY_QUERY_TIMEOUT_MS,
    maxBuffer: OWNER_IDENTITY_QUERY_MAX_BYTES,
  })
  const exact = String(result.stdout ?? '').trim()
  if (result.error || result.status !== 0 || result.signal != null || !CANONICAL_FILETIME_PATTERN.test(exact)) {
    throw new Error('owner process creation identity query failed')
  }
  return exact
}

function matchedSourceSection(source, pattern) {
  return source.match(pattern)?.[0] ?? ''
}

function numericTsConstant(source, name) {
  const match = source.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*(\\d+)`))
  return match ? Number(match[1]) : null
}

function stringTsConstant(source, name) {
  const match = source.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*['\"]([^'\"]+)['\"]`))
  return match?.[1] ?? null
}

function numericPowerShellConstant(source, name) {
  const match = source.match(new RegExp(`\\$script:${name}\\s*=\\s*(\\d+)`, 'i'))
  return match ? Number(match[1]) : null
}

function stringPowerShellConstant(source, name) {
  const match = source.match(new RegExp(`\\$script:${name}\\s*=\\s*['\"]([^'\"]+)['\"]`, 'i'))
  return match?.[1] ?? null
}

function numericCSharpConstant(source, name) {
  const match = source.match(new RegExp(`private\\s+const\\s+int\\s+${name}\\s*=\\s*(\\d+)`))
  return match ? Number(match[1]) : null
}

function stringCSharpConstant(source, name) {
  const match = source.match(new RegExp(`private\\s+const\\s+string\\s+${name}\\s*=\\s*\"([^\"]+)\"`))
  return match?.[1] ?? null
}

export function decideComputerUsePackageGate({ haveSetup, payloadTreeDir, smokeUnpacked }) {
  if (payloadTreeDir && existsSync(join(payloadTreeDir, 'Verstak.exe'))) {
    return { kind: 'run', sourceDir: payloadTreeDir }
  }
  if (haveSetup) {
    return {
      kind: 'fail',
      reason: 'Setup.exe exists but its verified computer helper payload tree is unavailable',
    }
  }
  if (existsSync(join(smokeUnpacked, 'Verstak.exe'))) {
    return { kind: 'run', sourceDir: smokeUnpacked }
  }
  return { kind: 'skip', reason: 'Setup.exe is not built and release/win-unpacked is unavailable' }
}

export function auditComputerHelperSource(source) {
  const failures = []
  const challengeMarkers = [
    'verify you are human', 'human verification', 'security check', 'challenge',
    'turnstile', 'just a moment', 'подтвердите, что вы человек', 'проверка безопасности',
    "i'm not a robot", 'i am not a robot', 'not a robot', 'are you a robot', 'я не робот',
    'i am human', "i'm human", 'я человек',
    'otp code', 'totp', 'mfa', 'two-step verification', 'two step verification',
    'one-time password', 'one time password', 'verification pin', '6-digit code', '6 digit code',
    'authenticator code', 'код аутентификатора', 'двухэтап',
    'код из приложения',
  ]
  const missingWindowOrControlChallengeMarker = challengeMarkers.some(
    marker => source.split(`"${marker}"`).length - 1 < 2,
  )
  const supportedActionsImplementation = source.match(
    /private\s+static\s+List<string>\s+SupportedActions[\s\S]*?(?=\n\s*private\s+static\s+string\s+SafeElementState)/,
  )?.[0] ?? ''
  const chooseMethodImplementation = source.match(
    /private\s+static\s+string\s+ChooseMethod[\s\S]*?(?=\n\s*private\s+static\s+void\s+RequireExpected)/,
  )?.[0] ?? ''
  const executeClickImplementation = source.match(
    /private\s+static\s+ExecutionOutcome\s+ExecuteClick[\s\S]*?(?=\n\s*private\s+static\s+ExecutionOutcome\s+ExecuteType)/,
  )?.[0] ?? ''
  const surfaceStateImplementation = source.match(
    /private\s+static\s+string\s+SurfaceStateFingerprint[\s\S]*?(?=\n\s*private\s+static\s+string\s+ChooseMethod)/,
  )?.[0] ?? ''
  const prepareImplementation = source.match(
    /private\s+static\s+void\s+HandlePrepare[\s\S]*?(?=\n\s*private\s+static\s+void\s+HandleCommit)/,
  )?.[0] ?? ''
  const executePreparedImplementation = source.match(
    /private\s+static\s+ExecutionOutcome\s+ExecutePrepared[\s\S]*?(?=\n\s*private\s+static\s+ExecutionOutcome\s+ExecuteClick)/,
  )?.[0] ?? ''
  const commitImplementation = source.match(
    /private\s+static\s+void\s+HandleCommit[\s\S]*?(?=\n\s*private\s+static\s+void\s+HandleCancel)/,
  )?.[0] ?? ''
  const executeTypeImplementation = source.match(
    /private\s+static\s+ExecutionOutcome\s+ExecuteType[\s\S]*?(?=\n\s*private\s+static\s+ExecutionOutcome\s+ExecuteKey)/,
  )?.[0] ?? ''
  const executeKeyImplementation = source.match(
    /private\s+static\s+ExecutionOutcome\s+ExecuteKey[\s\S]*?(?=\n\s*private\s+static\s+ExecutionOutcome\s+ExecuteScroll)/,
  )?.[0] ?? ''
  const executeScrollImplementation = source.match(
    /private\s+static\s+ExecutionOutcome\s+ExecuteScroll[\s\S]*?(?=\n\s*private\s+static\s+ExecutionOutcome\s+Outcome)/,
  )?.[0] ?? ''
  const sendTargetImplementation = source.match(
    /private\s+static\s+void\s+RequireSendInputTarget[\s\S]*?(?=\n\s*private\s+static\s+void\s+RequireNoHeldInputState)/,
  )?.[0] ?? ''
  const executeObserveImplementation = source.match(
    /private\s+static\s+IDictionary<string,\s*object>\s+ExecuteObserve[\s\S]*?(?=\n\s*private\s+static\s+void\s+RequireObservationBudget)/,
  )?.[0] ?? ''
  const exactWindowCaptureImplementation = source.match(
    /private\s+static\s+string\s+CaptureExactWindowPng[\s\S]*?(?=\n\s*private\s+static\s+byte\[\]\s+EncodeWindowPng)/,
  )?.[0] ?? ''
  const secureSurfaceImplementation = source.match(
    /private\s+static\s+bool\s+IsSecureSurface\s*\(\s*IntPtr\s+hwnd,\s*string\s+title,\s*int\s+maxElements[\s\S]*?(?=\n\s*private\s+static\s+bool\s+IsPassword)/,
  )?.[0] ?? ''
  const authenticationControlImplementation = source.match(
    /private\s+static\s+bool\s+IsAuthenticationControl[\s\S]*?(?=\n\s*private\s+static\s+bool\s+ContainsStandaloneOtpOrPin)/,
  )?.[0] ?? ''
  if (!source.startsWith('\uFEFF')
    || !/private\s+static\s+bool\s+IsAuthenticationControl\s*\(/.test(source)
    || !/blocked\.Any\s*\(\s*value\s*=>\s*marker\.Contains\s*\(\s*value\s*\)\s*\)/.test(source)
    || !/IsAuthenticationControl\s*\(\s*element\s*\)\s*\)\s*throw\s+new\s+SafeError\s*\(\s*"authentication_surface"/.test(source)
    || !/"captcha"/.test(source)
    || !/"two-factor"/.test(source)
    || !/"verification code"/.test(source)
    || !/ContainsStandaloneOtpOrPin\s*\(\s*joined\s*\)/.test(secureSurfaceImplementation)
    || !/ContainsStandaloneOtpOrPin\s*\(\s*marker\s*\)/.test(authenticationControlImplementation)
    || /\.Contains\s*\(\s*"(?:otp|пин)"\s*\)/.test(secureSurfaceImplementation)
    || /"(?:otp|пин)"\s*,/.test(authenticationControlImplementation)
    || !/private\s+static\s+bool\s+ContainsUnicodeToken[\s\S]*Char\.IsLetterOrDigit\s*\(\s*value,\s*previous\s*\)[\s\S]*Char\.IsLetterOrDigit\s*\(\s*value,\s*index\s*\)/.test(source)
    || !/ValidateAuthenticationTokenBoundaryContract\s*\(\s*\)\s*;/.test(source)
    || !/"Спинка"[\s\S]*"Пинтерест"[\s\S]*"prototype"[\s\S]*"desktop"/.test(source)
    || missingWindowOrControlChallengeMarker) {
    failures.push('authentication/CAPTCHA/2FA fail-closed guard missing')
  }
  if (/RequireActionCurrent\s*\(\s*action\s*,\s*expectedInput\s*,\s*false\s*,\s*cancellation\s*\)/.test(source)
    || !/if\s*\(\s*!expected\.Foreground\s*\|\|\s*!current\.Foreground\s*\)/.test(source)
    || !/RequireTimelyActionCurrent\s*\(\s*action\s*,\s*expectedInput\s*,\s*cancellation\s*\)/.test(source)
    || !/ElapsedMilliseconds\s*>\s*MaxTargetCheckIntervalMs/.test(source)
    || !/RequireDispatchWithinInterval\s*\(\s*chunkTimer\s*\)/.test(source)) {
    failures.push('UIA chunk guard must require exact foreground target')
  }
  if (!/private\s+const\s+int\s+MaxUiaValueScalars\s*=\s*32768\s*;/.test(source)
    || !/String\.IsNullOrEmpty\s*\(\s*chunk\s*\)\s*\|\|\s*UnicodeScalarCount\s*\(\s*chunk\s*\)\s*>\s*16/.test(prepareImplementation)
    || !/totalBytes\s*>\s*32768/.test(prepareImplementation)
    || !/kind\s*==\s*"type"\s*&&\s*parsedTextChunks\.Count\s*==\s*0/.test(prepareImplementation)
    || !/PrepareExpectedAfterValueState\s*\(\s*prepared\s*,\s*entry\s*\)/.test(prepareImplementation)
    || !/kind\s*==\s*"type"\s*&&\s*!prepared\.HasExpectedValueState/.test(prepareImplementation)
    || !/if\s*\(\s*action\.Method\s*==\s*"uia"\s*\)/.test(executeTypeImplementation)
    || !/CanUseBoundedValuePattern\s*\(\s*action\s*,\s*\(ValuePattern\)pattern\s*\)/.test(executeTypeImplementation)
    || !/foreach\s*\(\s*string\s+chunk\s+in\s+action\.TextChunks\s*\)/.test(executeTypeImplementation)
    || !/RequireExpectedValueState\s*\(\s*action\s*,\s*currentValue\s*\)/.test(executeTypeImplementation)
    || !/else\s+if\s*\(\s*!String\.Equals\s*\(\s*currentValue\s*,\s*accumulated\s*,\s*StringComparison\.Ordinal\s*\)\s*\)/.test(executeTypeImplementation)
    || !/accumulated\s*\+=\s*chunk\s*;[\s\S]{0,180}valuePattern\.SetValue\s*\(\s*accumulated\s*\)/.test(executeTypeImplementation)
    || !/MatchesExpectedAfterValueState\s*\(\s*action\s*,\s*afterValue\s*\)/.test(executeTypeImplementation)
    || !/ExpectedAfterValueFingerprint\s*=\s*Hash\s*\(\s*Salt\s*\+\s*":value-state:"\s*\+\s*expectedAfter\s*\)/.test(source)) {
    failures.push('UIA ValuePattern append/chunk/state contract missing')
  }
  if (!/prepared\.PreparedStopEpoch\s*!=\s*Interlocked\.Read\s*\(\s*ref\s+StopEpoch\s*\)/.test(source)
    || !/PreparedActions\.TryRemove\s*\(\s*preparedId/.test(source)) {
    failures.push('prepared action must be Stop-scoped and one-shot')
  }
  if (!supportedActionsImplementation
    || !/TogglePattern\.Pattern[\s\S]*SelectionItemPattern\.Pattern[\s\S]*InvokePattern\.Pattern[\s\S]*result\.Add\s*\(\s*"click"\s*\)/.test(supportedActionsImplementation)
    || !/ValuePattern\.Pattern[\s\S]*!\(\(ValuePattern\)ignored\)\.Current\.IsReadOnly[\s\S]*result\.Add\s*\(\s*"type"\s*\)/.test(supportedActionsImplementation)
    || !/ScrollPattern\.Pattern[\s\S]*result\.Add\s*\(\s*"scroll"\s*\)/.test(supportedActionsImplementation)
    || /result\.Add\s*\(\s*"key"\s*\)/.test(supportedActionsImplementation)) {
    failures.push('reduced UIA action surface contract missing')
  }
  if (!/\{\s*"text"\s*,\s*aggregateText\.ToString\s*\(\s*\)\s*\}/.test(source)
    || !/action\.Expected\.UserInputEpoch\s*=\s*expectedInput/.test(source)) {
    failures.push('observable text and post-action input epoch contract missing')
  }
  if (!/private\s+const\s+int\s+MaxScreenshotBytes\s*=\s*16384\s*;/.test(source)
    || !/private\s+const\s+int\s+MaxScreenshotWidth\s*=\s*512\s*;/.test(source)
    || !/private\s+const\s+int\s+MaxScreenshotHeight\s*=\s*384\s*;/.test(source)
    || !/PrintWindow\s*\(\s*expected\.Hwnd\s*,\s*hdc\s*,\s*PrintWindowRenderFullContent\s*\)/.test(exactWindowCaptureImplementation)
    || !/SameIdentity\s*\(\s*expected\s*,\s*probe\.Identity\s*\)/.test(exactWindowCaptureImplementation)
    || !/!probe\.Foreground/.test(exactWindowCaptureImplementation)
    || !/probe\.ScreenLocked\s*\|\|\s*probe\.Elevated\s*\|\|\s*probe\.ProtectedProcess\s*\|\|\s*probe\.SecureSurface/.test(exactWindowCaptureImplementation)
    || !/HasUnsafeSurfaceDescendant\s*\(\s*expected\.Hwnd/.test(exactWindowCaptureImplementation)
    || !/cancellation\.ThrowIfCancellationRequested\s*\(\s*\)/.test(exactWindowCaptureImplementation)
    || !/ProbeExact\s*\(\s*expected\s*,\s*true\s*,\s*MaxSurfaceInspectionElements\s*,\s*ObservationSurfaceInspectionTimeoutMs\s*\)/.test(exactWindowCaptureImplementation)
    || !/result\["screenshotDataUrl"\]\s*=\s*screenshotDataUrl/.test(executeObserveImplementation)
    || /(?:CopyFromScreen|BitBlt|GetDesktopWindow|GetDC\s*\(\s*IntPtr\.Zero|GetWindowDC)/.test(source)) {
    failures.push('exact-window privacy-safe visual observation missing')
  }
  if (!/\[Parameter\s*\(\s*Mandatory\s*=\s*\$true\s*\)\][\s\S]{0,160}\[int\]\$OwnerPid/.test(source)
    || !/actual\.Pid\s*==\s*OwnerPid/.test(source)
    || !/blockedProcesses\s*=\s*\{[\s\S]*"powershell"[\s\S]*"windowsterminal"[\s\S]*"putty"[\s\S]*"wezterm"[\s\S]*"alacritty"[\s\S]*"code"[\s\S]*"cursor"[\s\S]*"antigravity"[\s\S]*"idea64"[\s\S]*"explorer"/.test(source)) {
    failures.push('owner/terminal/development-surface exclusion missing')
  }
  if (!/private\s+static\s+bool\s+HasUnsafeSurfaceDescendant\s*\(/.test(source)
    || !/return\s+inspectSurfaceDescendants\s*&&\s*HasUnsafeSurfaceDescendant\s*\(\s*hwnd\s*,\s*maxElements\s*,\s*maxMilliseconds\s*\)\s*;/.test(source)
    || !/IsPassword\s*\(\s*element\s*\)\s*\|\|\s*IsAuthenticationControl\s*\(\s*element\s*\)\s*\|\|\s*IsLaunchSurfaceControl\s*\(\s*element\s*\)/.test(source)
    || !/"address bar"[\s\S]*"location bar"[\s\S]*"run"[\s\S]*"выполнить"/.test(source)
    || !/if\s*\(\s*secure\s*\)\s*return\s+true\s*;/.test(source)
    || !/listingTimer\.ElapsedMilliseconds\s*>\s*2000/.test(source)) {
    failures.push('whole-surface credential/auth/launch guard missing')
  }
  if (!/SetWindowsHookEx\s*\(\s*WhKeyboardLl/.test(source)
    || !/SetWindowsHookEx\s*\(\s*WhMouseLl/.test(source)
    || !/data\.Flags\s*&\s*LlkhfInjected/.test(source)
    || !/data\.Flags\s*&\s*LlmhfInjected/.test(source)
    || !/return\s+HooksReady\s*\?\s*Interlocked\.Read\s*\(\s*ref\s+PhysicalInputEpoch\s*\)\s*:\s*-1L/.test(source)) {
    failures.push('low-level physical-input monitor missing')
  }
  if (!/SetWinEventHook\s*\(\s*EventSystemForeground\s*,\s*EventSystemForeground/.test(source)
    || !/prepareForegroundEpoch\s*=\s*Interlocked\.Read\s*\(\s*ref\s+ForegroundEventEpoch\s*\)/.test(source)
    || !/PreparedForegroundEpoch\s*=\s*prepareForegroundEpoch/.test(source)
    || !/action\.PreparedForegroundEpoch\s*!=\s*Interlocked\.Read\s*\(\s*ref\s+ForegroundEventEpoch\s*\)/.test(source)
    || !/ForegroundBarrierAck\.WaitOne\s*\(\s*MaxTargetCheckIntervalMs\s*\)/.test(source)
    || !/UserInputEpoch\s*\(\s*\)\s*!=\s*action\.Expected\.UserInputEpoch/.test(source)
    || !/RequireActionCurrent\s*\(\s*action\s*,\s*expectedInput\s*,\s*true\s*,\s*cancellation\s*\)/.test(source)
    || !/DrainForegroundEvents\s*\(\s*\)\s*;\s*WindowProbe\s+after\s*=\s*ProbeExact[\s\S]{0,260}DrainForegroundEvents\s*\(\s*\)\s*;\s*long\s+postForegroundEpoch\s*=\s*Interlocked\.Read\s*\(\s*ref\s+ForegroundEventEpoch\s*\)[\s\S]{0,520}prepared\.PreparedForegroundEpoch\s*==\s*postForegroundEpoch/.test(commitImplementation)) {
    failures.push('foreground epoch and UIA dispatch boundary missing')
  }
  if (!/DateTime\.UtcNow\.AddMilliseconds\s*\(\s*450\s*\)/.test(source)
    || !/ActiveActions\.Count\s*>\s*0\s*\|\|\s*InputQueue\.CurrentCount\s*==\s*0/.test(source)
    || !/"stop_timeout"/.test(source)) {
    failures.push('Stop ACK active-queue drain barrier missing')
  }
  const ownerWatchdogImplementation = source.match(
    /private\s+static\s+void\s+StartOwnerWatchdog[\s\S]*?(?=\n\s*private\s+static\s+void\s+StartInputHooks)/,
  )?.[0] ?? ''
  const ownerWait = ownerWatchdogImplementation.indexOf('WaitForSingleObject(OwnerProcessHandle, Infinite)')
  const cancelObservations = ownerWatchdogImplementation.indexOf('CancelAllObservations()', ownerWait)
  const cancelActions = ownerWatchdogImplementation.indexOf('CancelAllActions()', cancelObservations)
  const ownerKill = ownerWatchdogImplementation.indexOf('Process.GetCurrentProcess().Kill()', cancelActions)
  if (!/StartOwnerWatchdog\s*\(\s*ownerPid\s*,\s*ownerStartTime100ns\s*\)\s*;/.test(source)
    || !/OpenProcess\s*\(\s*ProcessQueryLimitedInformation\s*\|\s*Synchronize\s*,\s*false\s*,\s*\(uint\)ownerPid\s*\)/.test(ownerWatchdogImplementation)
    || !/GetProcessTimes\s*\(\s*owner\s*,/.test(ownerWatchdogImplementation)
    || ownerWait < 0 || cancelObservations <= ownerWait || cancelActions <= cancelObservations || ownerKill <= cancelActions) {
    failures.push('exact owner-process watchdog/self-exit missing')
  }
  const ownerCreationQuery = ownerWatchdogImplementation.indexOf('GetProcessTimes(owner, out creation')
  const ownerCreationCompare = ownerWatchdogImplementation.indexOf(
    'String.Equals(actualOwnerStartTime100ns, ownerStartTime100ns, StringComparison.Ordinal)',
    ownerCreationQuery,
  )
  const ownerHandleSave = ownerWatchdogImplementation.indexOf('OwnerProcessHandle = owner;', ownerCreationCompare)
  if (!/\[ValidatePattern\('\^\[1-9\]\[0-9\]\*\$'\)\][\s\S]{0,80}\[string\]\$OwnerStartTime100ns/.test(source)
    || !/public\s+static\s+void\s+Run\s*\(\s*int\s+ownerPid,\s*string\s+ownerStartTime100ns\s*\)/.test(source)
    || !/private\s+static\s+string\s+FileTime100ns\s*\(\s*FILETIME\s+value\s*\)/.test(source)
    || !/\[VerstakComputerUse\.Helper\]::Run\(\$OwnerPid,\s*\$OwnerStartTime100ns\)/.test(source)
    || ownerCreationQuery < 0
    || ownerCreationCompare <= ownerCreationQuery
    || !/CloseHandle\s*\(\s*owner\s*\)[\s\S]*owner process identity changed/.test(ownerWatchdogImplementation)
    || ownerHandleSave <= ownerCreationCompare) {
    failures.push('exact owner-process creation identity pin missing')
  }
  if (!/\{\s*"dispatchAccepted"\s*,\s*dispatchAccepted\s*\}/.test(source)
    || !/\{\s*"effectMatched"\s*,\s*effectMatched\s*\}/.test(source)
    || !/beforeValue\s*!=\s*accumulated\s*&&\s*afterValue\s*==\s*accumulated/.test(source)
    || !/MatchesExpectedAfterValueState\s*\(\s*action\s*,\s*afterValue\s*\)/.test(source)
    || /inputSha256/.test(source)) {
    failures.push('action-specific secret-free effect readback missing')
  }
  if (!/RequireExpectedElementTransition\s*\(\s*action\s*,\s*"toggle"\s*,\s*SafeToggleState\s*\(\s*before\s*\)\s*\)/.test(executeClickImplementation)
    || !/MatchesExpectedElementTransition\s*\(\s*action\s*,\s*"toggle"\s*,\s*SafeToggleState\s*\(\s*after\s*\)\s*\)/.test(executeClickImplementation)
    || !/RequireExpectedElementTransition\s*\(\s*action\s*,\s*"selection"\s*,\s*before\s*\?\s*"selected"\s*:\s*"not-selected"\s*\)/.test(executeClickImplementation)
    || !/MatchesExpectedElementTransition\s*\(\s*action\s*,\s*"selection"\s*,\s*after\s*\?\s*"selected"\s*:\s*"not-selected"\s*\)/.test(executeClickImplementation)
    || !/before\s*==\s*"off"\s*&&\s*after\s*==\s*"on"[\s\S]*before\s*==\s*"on"\s*&&\s*after\s*==\s*"off"[\s\S]*before\s*==\s*"not-selected"\s*&&\s*after\s*==\s*"selected"/.test(source)) {
    failures.push('UIA Toggle/Selection exact-transition contract missing')
  }
  const discreteScrollParses = prepareImplementation.match(/OptionalInt\s*\([^\n]+,\s*-1\s*,\s*1\s*\)/g)?.length ?? 0
  if (discreteScrollParses < 4
    || !/kind\s*==\s*"scroll"\s*&&\s*prepared\.DeltaX\s*==\s*0\s*&&\s*prepared\.DeltaY\s*==\s*0/.test(prepareImplementation)
    || !/kind\s*==\s*"scroll"\s*&&\s*prepared\.Method\s*==\s*"uia"\s*&&\s*!prepared\.HasExpectedScrollState/.test(prepareImplementation)
    || !/RequireExpectedScrollState\s*\(\s*action\s*,\s*beforeHorizontal\s*,\s*beforeVertical\s*\)/.test(executeScrollImplementation)
    || !/requestedAnyAxis[\s\S]{0,180}&&\s*ScrollDirectionMatched\s*\(\s*action\.DeltaX\s*,\s*beforeHorizontal\s*,\s*afterHorizontal\s*\)[\s\S]{0,180}&&\s*ScrollDirectionMatched\s*\(\s*action\.DeltaY\s*,\s*beforeVertical\s*,\s*afterVertical\s*\)/.test(executeScrollImplementation)
    || !/return\s+delta\s*>\s*0\s*\?\s*after\s*>\s*before\s*:\s*after\s*<\s*before/.test(source)) {
    failures.push('UIA ScrollPattern one-step state/direction contract missing')
  }
  if (!supportedActionsImplementation
    || !chooseMethodImplementation
    || !executeClickImplementation
    || !surfaceStateImplementation
    || !/InvokePattern\.Pattern[\s\S]*result\.Add\s*\(\s*"click"\s*\)/.test(supportedActionsImplementation)
    || !/action\.Kind\s*==\s*"click"[\s\S]*InvokePattern\.Pattern[\s\S]*return\s+"coordinates"/.test(chooseMethodImplementation)
    || !/InvokePattern\.Pattern[\s\S]*RequireTimelyActionCurrent\s*\(\s*action\s*,\s*expectedInput\s*,\s*cancellation\s*\)[\s\S]*RequireElementCurrent\s*\(\s*entry\s*\)[\s\S]*beforeSurface\s*=\s*SurfaceStateFingerprint\s*\(\s*action\.Identity\s*,\s*cancellation\s*\)[\s\S]*\(\(InvokePattern\)pattern\)\.Invoke\s*\(\s*\)[\s\S]*action\.DispatchAccepted\s*=\s*true[\s\S]*DateTime\.UtcNow\.AddMilliseconds\s*\(\s*1200\s*\)[\s\S]*afterSurface\s*=\s*SurfaceStateFingerprint\s*\(\s*action\.Identity\s*,\s*cancellation\s*\)[\s\S]*!String\.Equals\s*\(\s*beforeSurface\s*,\s*afterSurface\s*,\s*StringComparison\.Ordinal\s*\)[\s\S]*return\s+Outcome\s*\(\s*true\s*,\s*true\s*\)[\s\S]*return\s+Outcome\s*\(\s*true\s*,\s*false\s*\)/.test(executeClickImplementation)
    || !/ActionEffectFingerprintElements\s*=\s*64/.test(source)
    || !/count\+\+\s*>=\s*ActionEffectFingerprintElements\s*\)\s*break/.test(surfaceStateImplementation)
    || !/timer\.ElapsedMilliseconds\s*>\s*750/.test(surfaceStateImplementation)
    || !/HasKeyboardFocus/.test(surfaceStateImplementation)
    || !/element\.Current\.IsPassword\s*\|\|\s*IsAuthenticationControl\s*\(\s*element\s*\)\s*\|\|\s*IsLaunchSurfaceControl\s*\(\s*element\s*\)/.test(surfaceStateImplementation)
    || !/ValuePattern\.Pattern[\s\S]*Current\.Value/.test(surfaceStateImplementation)
    || !/IdentityKey\s*\(\s*identity\s*\)/.test(surfaceStateImplementation)
    || !/pointerBeforeSurface\s*=\s*SurfaceStateFingerprint[\s\S]*SendMouseClick\s*\(\s*action\s*,\s*entry\s*,\s*point\s*\)[\s\S]*pointerAfterSurface\s*=\s*SurfaceStateFingerprint[\s\S]*!String\.Equals\s*\(\s*pointerBeforeSurface\s*,\s*pointerAfterSurface\s*,\s*StringComparison\.Ordinal\s*\)[\s\S]*return\s+Outcome\s*\(\s*true\s*,\s*true\s*\)/.test(executeClickImplementation)
    || (executeClickImplementation.match(/SendMouseClick\s*\(/g)?.length ?? 0) !== 1
    || !/RequireSendInputTarget\s*\(\s*action\s*,\s*entry\s*,\s*point\s*\)[\s\S]*RequireNoHeldInputState[\s\S]*RequireSendInputTarget\s*\(\s*action\s*,\s*entry\s*,\s*point\s*\)[\s\S]*dispatchTimer\s*=\s*Stopwatch\.StartNew[\s\S]*SendInput[\s\S]*action\.DispatchAccepted\s*=\s*true[\s\S]*RequireDispatchWithinInterval\s*\(\s*dispatchTimer\s*\)[\s\S]*RequireSendInputTarget\s*\(\s*action\s*,\s*entry\s*,\s*point\s*\)/.test(source)) {
    failures.push('UIA InvokePattern bounded surface readback contract missing')
  }
  const elementRevalidations = source.match(/RequireElementCurrent\s*\(\s*entry\s*\)\s*;/g)?.length ?? 0
  if (!/public\s+string\s+Fingerprint\s*;/.test(source)
    || !/private\s+static\s+string\s+CaptureElementFingerprint\s*\(/.test(source)
    || !/GetRuntimeId\s*\(\s*\)/.test(source)
    || !/controlType\.Id/.test(source)
    || !/Current\.AutomationId/.test(source)
    || !/Current\.Name/.test(source)
    || !/Current\.BoundingRectangle/.test(source)
    || !/GetParent\s*\(/.test(source)
    || !/Automation\.Compare\s*\(/.test(source)
    || !/ElementPatternSignature\s*\(\s*current\s*\)/.test(source)
    || !/\{\s*"semanticFingerprint"\s*,\s*fingerprint\s*\}/.test(source)
    || elementRevalidations < 6
    || !/RequireElementCurrent\s*\(\s*entry\s*\)\s*;/.test(prepareImplementation)
    || !/RequireElementCurrent\s*\(\s*entry\s*\)\s*;/.test(executePreparedImplementation)
    || (executeClickImplementation.match(/RequireElementCurrent\s*\(\s*entry\s*\)\s*;/g)?.length ?? 0) < 2
    || (executeTypeImplementation.match(/RequireElementCurrent\s*\(\s*entry\s*\)\s*;/g)?.length ?? 0) < 1
    || !/RequireElementCurrent\s*\(\s*entry\s*\)\s*;/.test(executeScrollImplementation)) {
    failures.push('stable UIA element fingerprint/revalidation missing')
  }
  const observationCancellationCalls = source.match(/CancelAllObservations\s*\(\s*\)\s*;/g)?.length ?? 0
  if (!/ConcurrentDictionary<string,\s*CancellationTokenSource>\s+ActiveObservations/.test(source)
    || !/private\s+static\s+void\s+HandleObserve[\s\S]{0,1600}Task\.Run/.test(source)
    || !/Task\.Delay\s*\(\s*ObservationTimeoutMs\s*\)/.test(source)
    || !/TreeWalker\.ControlViewWalker/.test(source)
    || observationCancellationCalls < 3
    || /\.FindAll\s*\(\s*TreeScope\.Descendants/.test(source)) {
    failures.push('bounded asynchronous observation/Stop isolation missing')
  }
  if (!executeObserveImplementation
    || /(?:GetForegroundWindow|ForegroundEventEpoch|SetFocus|SetForegroundWindow|RequireExpected|RequireActionCurrent|\b(?:probe|finalProbe)\.Foreground\b)/.test(executeObserveImplementation)
    || (executeObserveImplementation.match(/ProbeExact\s*\(\s*expected\s*,\s*true\s*,\s*MaxSurfaceInspectionElements\s*,\s*MaxTargetCheckIntervalMs\s*,\s*false\s*\)/g)?.length ?? 0) < 2
    || (executeObserveImplementation.match(/\.ScreenLocked\s*\)\s*throw\s+new\s+SafeError\s*\(\s*"screen_locked"/g)?.length ?? 0) < 2
    || !/SameGeometry\s*\(\s*probe\.Geometry\s*,\s*finalProbe\.Geometry\s*\)/.test(executeObserveImplementation)
    || !/probe\.Dpi\s*!=\s*finalProbe\.Dpi/.test(executeObserveImplementation)
    || !/\{\s*"probe"\s*,\s*ProbeObject\s*\(\s*finalProbe\s*\)\s*\}/.test(executeObserveImplementation)
    || !/RequireExpected\s*\(\s*expected\s*,\s*current\s*,\s*true\s*\)\s*;/.test(prepareImplementation)
    || !/RequireExpected\s*\(\s*prepared\.Expected\s*,\s*before\s*,\s*true\s*\)\s*;/.test(source)) {
    failures.push('read-only observation must allow exact background windows while effectful actions require foreground')
  }
  return failures
}

/**
 * Cross-file release contract for the reduced R2 action surface. The helper
 * may retain reviewed legacy SendInput code, but production cannot advertise
 * it, opt into it, or transfer a non-UIA prepare to commit.
 */
export function auditComputerReducedActionSources({ helper, controller, main, tools, handler }) {
  const failures = []
  const supportedActions = matchedSourceSection(helper,
    /private\s+static\s+List<string>\s+SupportedActions[\s\S]*?(?=\n\s*private\s+static\s+string\s+SafeElementState)/,
  )
  const typeTool = matchedSourceSection(tools,
    /name:\s*['"]computer_type['"][\s\S]*?(?=\n\s*\{\n\s*name:\s*['"]computer_key['"])/,
  )
  const dispatchInput = matchedSourceSection(handler,
    /function\s+dispatchInput[\s\S]*?(?=\n}\n\nexport\s+const\s+computerHandler)/,
  )
  const mainControllerStart = main.indexOf('createComputerController({')
  const mainControllerEnd = main.indexOf('configureComputerHandler', mainControllerStart)
  const mainController = mainControllerStart >= 0 && mainControllerEnd > mainControllerStart
    ? main.slice(mainControllerStart, mainControllerEnd)
    : ''
  const exactElementCoordinateClick = matchedSourceSection(controller,
    /function\s+acceptsExactElementCoordinateClick[\s\S]*?(?=\n}\n\nfunction\s+assertCoordinateFallback)/,
  )

  if (!/const\s+allowUnverifiedGlobalInput\s*=\s*deps\.testOnlyAllowUnverifiedGlobalInput\s*===\s*true/.test(controller)
    || /testOnlyAllowUnverifiedGlobalInput/.test(mainController)
    || !/if\s*\(\s*!allowUnverifiedGlobalInput\s*&&\s*requiresUnverifiedGlobalInput\s*\(\s*input\.action\s*,\s*element\s*\)\s*\)/.test(controller)
    || !/return\s+action\s*===\s*['"]key['"]\s*\|\|\s*!element\?\.backend\.supportedActions\.includes\s*\(\s*action\s*\)/.test(controller)
    || !/const\s+exactElementCoordinateClick\s*=\s*acceptsExactElementCoordinateClick\s*\(\s*input\.action\s*,\s*element\s*\)/.test(controller)
    || !/const\s+uiaRequired[\s\S]{0,220}&&\s*!exactElementCoordinateClick/.test(controller)
    || !/if\s*\(\s*uiaRequired\s*&&\s*prepared\.method\s*!==\s*['"]uia['"]\s*\)/.test(controller)
    || !/if\s*\(\s*prepared\.method\s*!==\s*['"]uia['"]\s*&&\s*!allowUnverifiedGlobalInput\s*&&\s*!\(\s*exactElementCoordinateClick\s*&&\s*prepared\.method\s*===\s*['"]coordinates['"]\s*\)\s*\)/.test(controller)
    || !/action\s*===\s*['"]click['"][\s\S]*!!element\?\.backend\.bounds[\s\S]*supportedActions\.includes\s*\(\s*['"]click['"]\s*\)[\s\S]*!isStatefulClickState\s*\(\s*element\.backend\.state\s*\)/.test(exactElementCoordinateClick)
    || /result\.Add\s*\(\s*"key"\s*\)/.test(supportedActions)) {
    failures.push('production global input/key/coordinates boundary missing')
  }

  if (!/if\s*\(\s*input\.action\s*===\s*['"]type['"]\s*&&\s*input\.clearFirst\s*!==\s*undefined\s*\)/.test(controller)
    || !/input\.action\s*===\s*['"]type['"][\s\S]{0,180}typeof\s+input\.text\s*!==\s*['"]string['"][\s\S]{0,180}Array\.from\s*\(\s*input\.text\s*\)\.length\s*===\s*0[\s\S]{0,180}input\.clearFirst\s*!==\s*undefined/.test(controller)
    || !/kind\s*==\s*"type"\s*&&\s*\(\s*action\.ContainsKey\s*\(\s*"clearFirst"\s*\)\s*\|\|\s*message\.ContainsKey\s*\(\s*"clearFirst"\s*\)\s*\)/.test(helper)
    || !/kind\s*==\s*"type"\s*&&\s*parsedTextChunks\.Count\s*==\s*0/.test(helper)
    || /clearFirst/.test(typeTool)
    || /clearFirst/.test(dispatchInput)) {
    failures.push('clearFirst or empty type boundary missing')
  }

  if (!/expectedValueState:\s*\{\s*\.\.\.element\.backend\.valueState\s*\}/.test(controller)
    || !/prepared\.expectedAfterValueState\.scalarLength\s*!==\s*expectedAfterLength/.test(controller)
    || !/!postObservationMatchesValueState\s*\(/.test(controller)) {
    failures.push('controller ValuePattern independent readback contract missing')
  }
  if (!/await\s+delayWithAbort\s*\(\s*postconditionSettleMs\s*,\s*attempt\s*\)/.test(controller)
    || !/settledObservation\s*=\s*await\s+captureObservation\s*\(\s*browserTaskId\s*,\s*runId\s*,\s*false\s*,\s*attempt\s*\)/.test(controller)
    || !/assertStablePostObservation\s*\(\s*postObservation\s*,\s*settledObservation\s*\)/.test(controller)
    || (controller.match(/assertPostActionObservation\s*\(/g)?.length ?? 0) < 3
    || !/Math\.min\s*\(\s*MAX_POSTCONDITION_SETTLE_MS/.test(controller)) {
    failures.push('controller stable two-observation postcondition contract missing')
  }
  if (!/expectedTransition:\s*\{\s*\.\.\.expectedElementTransition\s*\}/.test(controller)
    || !/!postObservationMatchesTransition\s*\(/.test(controller)) {
    failures.push('controller Toggle/Selection independent readback contract missing')
  }
  if (!/!discreteScrollStep\s*\(\s*deltaX\s*\)\s*\|\|\s*!discreteScrollStep\s*\(\s*deltaY\s*\)/.test(handler)
    || !/deltaX\s*===\s*0\s*&&\s*deltaY\s*===\s*0/.test(handler)
    || !/deltaX\s*==\s*null\s*\|\|\s*deltaY\s*==\s*null\s*\|\|\s*\(\s*deltaX\s*===\s*0\s*&&\s*deltaY\s*===\s*0\s*\)/.test(controller)
    || !/expectedScrollState:\s*\{\s*\.\.\.element\.backend\.scrollState\s*\}/.test(controller)
    || !/!postObservationMatchesScroll\s*\(/.test(controller)) {
    failures.push('controller/handler ScrollPattern one-step readback contract missing')
  }
  return failures
}

export function auditComputerCandidateLeaseSources({ helper, protocol, types, client, backend, controller }) {
  const failures = []
  const listCandidates = matchedSourceSection(helper,
    /private\s+static\s+void\s+HandleListCandidates[\s\S]*?(?=\n\s*private\s+static\s+void\s+HandleProbe)/,
  )
  const probe = matchedSourceSection(helper,
    /private\s+static\s+void\s+HandleProbe[\s\S]*?(?=\n\s*private\s+static\s+void\s+HandleObserve)/,
  )
  const destroy = matchedSourceSection(helper,
    /private\s+static\s+void\s+DestroyEventProc[\s\S]*?(?=\n\s*private\s+static\s+CandidateLease\s+ConsumeCandidateLease)/,
  )
  const consume = matchedSourceSection(helper,
    /private\s+static\s+CandidateLease\s+ConsumeCandidateLease[\s\S]*?(?=\n\s*private\s+static\s+void\s+InvalidateCandidateLeases)/,
  )
  const invalidate = matchedSourceSection(helper,
    /private\s+static\s+void\s+InvalidateCandidateLeases[\s\S]*?(?=\n\s*private\s+static\s+bool\s+IsCandidateToken)/,
  )
  const stop = matchedSourceSection(helper,
    /private\s+static\s+void\s+HandleStop[\s\S]*?(?=\n\s*private\s+static\s+void\s+HandleShutdown)/,
  )
  const shutdown = matchedSourceSection(helper,
    /private\s+static\s+void\s+HandleShutdown[\s\S]*?(?=\n\s*private\s+static\s+ExecutionOutcome)/,
  )
  const publicCandidate = matchedSourceSection(types,
    /export\s+interface\s+ComputerCandidate[\s\S]*?\n}/,
  )
  const controllerList = matchedSourceSection(controller,
    /async\s+function\s+listCandidates[\s\S]*?(?=\n\s*async\s+function\s+bindCandidate)/,
  )
  const publicResult = matchedSourceSection(controllerList, /result\.push\s*\(\s*\{[\s\S]*?\}\s*\)/)
  const listDrains = listCandidates.match(/DrainForegroundEvents\s*\(\s*\)\s*;/g)?.length ?? 0
  const candidateCallback = listCandidates.slice(listCandidates.indexOf('EnumWindows(delegate'))
  const prefilterIdentity = candidateCallback.indexOf('TryIdentity(hwnd, out prefilteredIdentity)')
  const prefilterTitle = candidateCallback.indexOf('string prefilteredTitle = NormalizeWindowTitle(WindowText(hwnd));')
  const prefilterBlocked = candidateCallback.indexOf('IsBlockedApplication(prefilteredIdentity, prefilteredTitle)')
  const lifecycleArmLock = candidateCallback.indexOf('lock (WindowLifecycleLock)', prefilterBlocked)
  const lifecycleWatch = candidateCallback.indexOf('TryWatchWindowLifecycle(hwnd, out destroyGeneration)', lifecycleArmLock)
  const armedIdentity = candidateCallback.indexOf('TryIdentity(hwnd, out armedIdentity)', lifecycleWatch)
  const armedSameIdentity = candidateCallback.indexOf('SameIdentity(armedIdentity, prefilteredIdentity)', armedIdentity)
  const armedTitle = candidateCallback.indexOf('armedTitle = NormalizeWindowTitle(WindowText(hwnd));', armedSameIdentity)
  const armedSameTitle = candidateCallback.indexOf('String.Equals(armedTitle, prefilteredTitle, StringComparison.Ordinal)', armedTitle)
  const armedBlocked = candidateCallback.indexOf('IsBlockedApplication(armedIdentity, armedTitle)', armedTitle)
  const elevatedScan = candidateCallback.indexOf('IsElevated(armedIdentity.Pid', armedBlocked)
  const secureScan = candidateCallback.indexOf('IsSecureSurface(armedIdentity.Hwnd, armedTitle, 64, 500)', elevatedScan)
  const enumerationEnd = listCandidates.indexOf('}, IntPtr.Zero);')
  const postEnumerationDrain = listCandidates.indexOf('DrainForegroundEvents();', enumerationEnd)
  const snapshotGenerationCheck = listCandidates.indexOf('snapshot.DestroyGeneration != WindowDestroyGeneration(snapshot.Identity.Hwnd)')
  const identityRecheck = listCandidates.indexOf('TryIdentity(snapshot.Identity.Hwnd, out actual)')
  const tokenConsume = probe.indexOf('ConsumeCandidateLease(candidateToken, expected);')
    >= 0
    ? probe.indexOf('ConsumeCandidateLease(candidateToken, expected);')
    : probe.indexOf('ConsumeCandidateLease(candidateToken, expected).DestroyGeneration;')
  const pendingArm = probe.indexOf('PendingProbeWindowInstance = expected;')

  const helperChecks = [
    /private\s+const\s+int\s+MaxCandidateLeases\s*=\s*128\s*;/.test(helper),
    /private\s+const\s+int\s+MaxTrackedWindowLifecycles\s*=\s*MaxCandidateLeases\s*\+\s*2\s*;/.test(helper),
    /private\s+const\s+int\s+CandidateLeaseTtlSeconds\s*=\s*30\s*;/.test(helper),
    /ConcurrentDictionary<string,\s*CandidateLease>\s+CandidateLeases/.test(helper),
    /ConcurrentDictionary<long,\s*long>\s+TrackedWindowDestroyGenerations/.test(helper),
    /CandidateLeases\.Clear\s*\(\s*\)/.test(listCandidates),
    /ResetWindowLifecycleWatches\s*\(\s*\)/.test(listCandidates),
    listDrains >= 2,
    prefilterIdentity >= 0,
    prefilterTitle > prefilterIdentity,
    prefilterBlocked > prefilterTitle,
    lifecycleArmLock > prefilterBlocked,
    lifecycleWatch > lifecycleArmLock,
    armedIdentity > lifecycleWatch,
    armedSameIdentity > armedIdentity,
    armedTitle > armedSameIdentity,
    armedSameTitle > armedTitle,
    armedBlocked > armedTitle,
    elevatedScan > armedBlocked,
    secureScan > elevatedScan,
    (candidateCallback.match(/IsElevated\(/g)?.length ?? 0) === 1,
    (candidateCallback.match(/IsSecureSurface\(/g)?.length ?? 0) === 1,
    postEnumerationDrain > enumerationEnd,
    /DestroyGeneration\s*=\s*destroyGeneration/.test(listCandidates),
    snapshotGenerationCheck > postEnumerationDrain && identityRecheck > snapshotGenerationCheck,
    /TryIdentity\s*\(\s*snapshot\.Identity\.Hwnd[\s\S]*SameIdentity\s*\(\s*actual,\s*snapshot\.Identity\s*\)/.test(listCandidates),
    /CandidateLeases\.Count\s*>=\s*MaxCandidateLeases/.test(listCandidates),
    /Opaque\s*\(\s*"candidate-lease"[\s\S]*Guid\.NewGuid\s*\(\s*\)/.test(listCandidates),
    /CandidateLeases\s*\[\s*candidateToken\s*\][\s\S]*DestroyGeneration\s*=\s*snapshot\.DestroyGeneration[\s\S]*DateTime\.UtcNow\.AddSeconds\s*\(\s*CandidateLeaseTtlSeconds\s*\)/.test(listCandidates),
    /"candidateToken"\s*,\s*candidateToken/.test(listCandidates),
    !/"candidateId"/.test(listCandidates),
    !/WindowDestroyEventEpoch|listDestroyEpoch/.test(listCandidates),
    /message\.TryGetValue\s*\(\s*"candidateToken"/.test(probe),
    tokenConsume >= 0 && pendingArm > tokenConsume,
    /private\s+const\s+int\s+BindingSurfaceInspectionTimeoutMs\s*=\s*1500\s*;/.test(helper),
    /ProbeExact\s*\(\s*expected,\s*true,\s*MaxSurfaceInspectionElements,\s*BindingSurfaceInspectionTimeoutMs\s*\)/.test(probe),
    /return\s+ProbeExact\s*\(\s*expected,\s*blockUnsafe,\s*MaxSurfaceInspectionElements,\s*MaxTargetCheckIntervalMs\s*\)\s*;/.test(helper),
    /IsSecureSurface\s*\(\s*actual\.Hwnd,\s*title,\s*surfaceMaxElements,\s*surfaceMaxMilliseconds,\s*inspectSurfaceDescendants\s*\)/.test(helper),
    /private\s+const\s+int\s+ActionSurfaceInspectionTimeoutMs\s*=\s*1500\s*;/.test(helper),
    /ProbeExact\s*\(\s*action\.Identity,\s*true,\s*MaxSurfaceInspectionElements,\s*ActionSurfaceInspectionTimeoutMs\s*\)[\s\S]*?Stopwatch\s+timer\s*=\s*Stopwatch\.StartNew\s*\(\s*\)[\s\S]*?RequireActionCurrent\s*\(\s*action,\s*expectedInput,\s*true,\s*cancellation\s*\)/.test(helper),
    /ProbeExact\s*\(\s*action\.Identity,\s*true,\s*MaxSurfaceInspectionElements,\s*MaxTargetCheckIntervalMs,\s*false\s*\)/.test(helper),
    /SelectedWindowInstance\s*==\s*null\s*\|\|\s*!SameIdentity\s*\(\s*SelectedWindowInstance,\s*expected\s*\)/.test(probe),
    /CandidateLeases\.TryRemove\s*\(\s*candidateToken/.test(consume),
    /lease\.ExpiresUtc\s*<=\s*DateTime\.UtcNow/.test(consume),
    /SameIdentity\s*\(\s*lease\.Identity,\s*expected\s*\)/.test(consume),
    /lease\.DestroyGeneration\s*!=\s*WindowDestroyGeneration\s*\(\s*expected\.Hwnd\s*\)/.test(consume),
    /lock\s*\(\s*WindowLifecycleLock\s*\)[\s\S]*AdvanceWindowDestroyGeneration\s*\(\s*hwnd\s*\)[\s\S]*InvalidateCandidateLeases\s*\(\s*hwnd\s*\)[\s\S]*selected\.Hwnd\s*!=\s*hwnd/.test(destroy),
    /pair\.Value\.Identity\.Hwnd\s*==\s*hwnd[\s\S]*CandidateLeases\.TryRemove/.test(invalidate),
    /TrackedWindowDestroyGenerations\.Count\s*>=\s*MaxTrackedWindowLifecycles/.test(invalidate),
    /TrackedWindowDestroyGenerations\.TryUpdate\s*\(\s*key,\s*generation\s*\+\s*1,\s*generation\s*\)/.test(invalidate),
    (helper.match(/CandidateLeases\.Clear\s*\(\s*\)/g)?.length ?? 0) >= 3,
    !/lock\s*\(\s*WindowLifecycleLock\s*\)\s*\{\s*DrainForegroundEvents\s*\(\s*\)/.test(listCandidates),
  ]
  if (helperChecks.includes(false)) failures.push('fresh one-shot bounded helper candidate lease lifecycle missing')
  if (/SelectedWindowInstance\s*=\s*null/.test(stop)
    || !/SelectedWindowInstance\s*=\s*null/.test(shutdown)) {
    failures.push('Stop must preserve exact selected window while shutdown clears it')
  }

  const boundaryChecks = [
    /interface\s+ComputerCandidate[\s\S]*candidateToken:\s*string/.test(protocol),
    /interface\s+BackendCandidate[\s\S]*candidateToken:\s*string/.test(types),
    /candidateId:\s*string/.test(publicCandidate) && !/candidateToken/.test(publicCandidate),
    /CANDIDATE_TOKEN_PATTERN/.test(client),
    /candidateToken:\s*value\.candidateToken/.test(client),
    /this\.request\s*\(\s*'probe_binding'[\s\S]*candidateToken/.test(client),
    /candidateToken:\s*candidate\.candidateToken/.test(backend),
    /client\.probeBinding\s*\(\s*identity,\s*candidateToken\s*\)/.test(backend),
    /candidates\.clear\s*\(\s*\)[\s\S]*backend\.listCandidates/.test(controllerList),
    /candidates\.delete\s*\(\s*candidateId\s*\)[\s\S]*backend\.probeBinding\s*\(\s*listed\.candidate\.identity,\s*listed\.candidate\.candidateToken\s*\)/.test(controller),
    Boolean(publicResult) && !/candidateToken|identity|titleFingerprint/.test(publicResult),
  ]
  if (boundaryChecks.includes(false)) failures.push('helper candidate lease crossed or was dropped at the main-process boundary')

  const completeTitleChecks = [
    /private\s+const\s+int\s+MaxWindowTitleChars\s*=\s*32767\s*;/.test(helper),
    /GetWindowTextLength\s*\(\s*hwnd\s*\)/.test(helper),
    /copied\s*!=\s*afterLength/.test(helper),
    /TitleFingerprint\s*=\s*WindowTitleFingerprint\s*\(\s*armedTitle\s*\)/.test(listCandidates),
    /"titleFingerprint"\s*,\s*snapshot\.TitleFingerprint/.test(listCandidates),
    /bindExpectedTitleFingerprint[\s\S]*probe\.TitleFingerprint/.test(probe),
    /Hash\s*\(\s*"window-title\|"\s*\+\s*normalizedTitle\s*\)/.test(helper),
    /"titleFingerprint"\s*,\s*probe\.TitleFingerprint/.test(helper),
    /RequiredString\s*\(\s*value\s*,\s*"titleFingerprint"\s*,\s*64\s*\)/.test(helper),
    /expected\.TitleFingerprint\s*,\s*current\.TitleFingerprint/.test(helper),
    /action\.Expected\.TitleFingerprint\s*,\s*current\.TitleFingerprint/.test(helper),
    /interface\s+ComputerWindowProbe[\s\S]*titleFingerprint:\s*string/.test(protocol),
    /interface\s+ComputerCandidate[\s\S]*titleFingerprint:\s*string/.test(protocol),
    /interface\s+ComputerExpectedState[\s\S]*titleFingerprint:\s*string/.test(protocol),
    /interface\s+BackendCandidate[\s\S]*titleFingerprint:\s*string/.test(types),
    /interface\s+ComputerProbe[\s\S]*titleFingerprint:\s*string/.test(types),
    /expected:\s*\{[\s\S]*titleFingerprint:\s*string/.test(types),
    /SHA256_PATTERN\.test\s*\(\s*value\.titleFingerprint\s*\)/.test(client),
    (client.match(/titleFingerprint:\s*value\.titleFingerprint/g)?.length ?? 0) >= 2,
    /titleFingerprint:\s*candidate\.titleFingerprint/.test(backend),
    /listed\.candidate\.titleFingerprint\s*!==\s*probe\.titleFingerprint/.test(controller),
    /titleFingerprint:\s*snapshot\.probe\.titleFingerprint/.test(controller),
    /expected\.titleFingerprint\s*!==\s*actual\.titleFingerprint/.test(controller),
  ]
  if (completeTitleChecks.includes(false)) failures.push('complete bounded window title fingerprint contract missing')
  return failures
}

export function checkComputerUsePackage({ root, sourceDir }) {
  const failures = []
  const evidence = {}
  const fail = message => failures.push(message)
  const sourceHelperPath = join(root, 'resources', 'computer-use', 'helper.ps1')
  const packagedHelperPath = join(sourceDir, 'resources', 'computer-use', 'helper.ps1')
  const protocolPath = join(root, 'electron', 'ai', 'computer', 'protocol.ts')
  const typesPath = join(root, 'electron', 'ai', 'computer', 'types.ts')
  const clientPath = join(root, 'electron', 'ai', 'computer', 'helper-client.ts')
  const backendPath = join(root, 'electron', 'ai', 'computer', 'helper-backend.ts')
  const controllerPath = join(root, 'electron', 'ai', 'computer', 'controller.ts')
  const toolsPath = join(root, 'electron', 'ai', 'tools.ts')
  const handlerPath = join(root, 'electron', 'ipc', 'tool-handlers', 'computer.ts')
  const mainPath = join(root, 'electron', 'main.ts')
  const packagePath = join(root, 'package.json')
  const exePath = join(sourceDir, 'Verstak.exe')

  if (!existsSync(exePath)) fail('Verstak.exe missing')
  if (!existsSync(sourceHelperPath)) fail('reviewed computer-use/helper.ps1 missing')
  if (!existsSync(packagedHelperPath)) fail('computer-use/helper.ps1 missing')
  if (!existsSync(protocolPath)) fail('computer protocol source missing')
  if (!existsSync(typesPath)) fail('computer types source missing')
  if (!existsSync(clientPath)) fail('computer helper client source missing')
  if (!existsSync(backendPath)) fail('computer helper backend source missing')
  if (!existsSync(controllerPath)) fail('computer controller source missing')
  if (!existsSync(toolsPath)) fail('computer tool definitions source missing')
  if (!existsSync(handlerPath)) fail('computer tool handler source missing')
  if (!existsSync(mainPath)) fail('desktop main source missing')
  if (!existsSync(packagePath)) fail('package.json missing')
  if (failures.length) return { ok: false, failures, evidence }

  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
  const protocol = readFileSync(protocolPath, 'utf8')
  const types = readFileSync(typesPath, 'utf8')
  const client = readFileSync(clientPath, 'utf8')
  const backend = readFileSync(backendPath, 'utf8')
  const controller = readFileSync(controllerPath, 'utf8')
  const tools = readFileSync(toolsPath, 'utf8')
  const handler = readFileSync(handlerPath, 'utf8')
  const main = readFileSync(mainPath, 'utf8')
  const sourceHelper = readFileSync(sourceHelperPath)
  const packagedHelper = readFileSync(packagedHelperPath)
  const sourceText = sourceHelper.toString('utf8')
  const packagedText = packagedHelper.toString('utf8')

  if (!sourceHelper.equals(packagedHelper)) {
    fail('computer-use/helper.ps1 differs from reviewed source')
  }
  const forbiddenTestSwitch = /(?:--test(?:-only)?\b|VERSTAK_[A-Z0-9_]*TEST\b|\btestOnly\b|\bmockDesktop\b)/i
  if (forbiddenTestSwitch.test(sourceText)) fail('source helper contains forbidden test-only switch')
  if (forbiddenTestSwitch.test(packagedText)) fail('packaged helper contains forbidden test-only switch')
  for (const message of auditComputerHelperSource(sourceText)) fail(`source helper: ${message}`)
  for (const message of auditComputerHelperSource(packagedText)) fail(`packaged helper: ${message}`)
  for (const message of auditComputerCandidateLeaseSources({
    helper: sourceText, protocol, types, client, backend, controller,
  })) fail(`candidate lease: ${message}`)
  for (const message of auditComputerReducedActionSources({
    helper: sourceText, controller, main, tools, handler,
  })) fail(`reduced action surface: ${message}`)
  if (!/MAX_COMPUTER_SCREENSHOT_BYTES\s*=\s*16\s*\*\s*1024/.test(protocol)
    || !/MAX_COMPUTER_SCREENSHOT_WIDTH\s*=\s*512/.test(protocol)
    || !/MAX_COMPUTER_SCREENSHOT_HEIGHT\s*=\s*384/.test(protocol)
    || !/function\s+readScreenshotDataUrl\s*\(/.test(client)
    || !/bytes\.length\s*>\s*MAX_COMPUTER_SCREENSHOT_BYTES/.test(client)
    || !/bytes\.readUInt32BE\s*\(\s*16\s*\)/.test(client)
    || !/width\s*>\s*MAX_COMPUTER_SCREENSHOT_WIDTH/.test(client)
    || !/height\s*>\s*MAX_COMPUTER_SCREENSHOT_HEIGHT/.test(client)
    || !/screenshotDataUrl:\s*readScreenshotDataUrl\s*\(\s*observation\.screenshotDataUrl\s*\)/.test(client)) {
    fail('desktop screenshot transport bounds missing')
  }
  const ensureChildImplementation = client.match(
    /private\s+ensureChild\s*\(\s*\)[\s\S]*?(?=\n\s*private\s+nextRequestId)/,
  )?.[0] ?? ''
  const ownerIdentityResolve = ensureChildImplementation.indexOf('const ownerStartTime100ns = requireCanonicalOwnerStartTime100ns(')
  const firstHelperSpawn = ensureChildImplementation.indexOf('this.spawnImpl(')
  const helperSpawn = ensureChildImplementation.indexOf('this.spawnImpl(this.systemPowerShellPath,', ownerIdentityResolve)
  if (!/const\s+ownerPid\s*=\s*this\.options\.ownerPid\s*\?\?\s*process\.pid/.test(ensureChildImplementation)
    || !/['"]-OwnerPid['"]\s*,\s*String\s*\(\s*ownerPid\s*\)/.test(ensureChildImplementation)) {
    fail('desktop helper launch must pass exact owner PID')
  }
  const ownerQueryImplementation = client.match(
    /export\s+function\s+queryOwnerStartTime100ns[\s\S]*?(?=\nfunction\s+normalizeWindowTitle)/,
  )?.[0] ?? ''
  if (!/spawnSyncImpl\s*\(\s*resolveSystemPowerShellPath\s*\(\s*\)\s*,/.test(ownerQueryImplementation)
    || !/Get-Process\s+-Id/.test(ownerQueryImplementation)
    || !/StartTime\.ToFileTimeUtc\s*\(\s*\)/.test(ownerQueryImplementation)
    || !/timeout:\s*OWNER_IDENTITY_QUERY_TIMEOUT_MS/.test(ownerQueryImplementation)
    || !/CANONICAL_FILETIME_PATTERN\s*=\s*\/\^\[1-9\]\[0-9\]\*\$\//.test(client)
    || /(?:Number|parseInt)\s*\(\s*(?:String\s*\()?result\.stdout/.test(ownerQueryImplementation)
    || ownerIdentityResolve < 0
    || firstHelperSpawn <= ownerIdentityResolve
    || helperSpawn <= ownerIdentityResolve
    || !/['"]-OwnerStartTime100ns['"]\s*,\s*ownerStartTime100ns/.test(ensureChildImplementation)) {
    fail('desktop helper launch must pin exact owner creation FILETIME before spawn')
  }
  if (!/const\s+SYSTEM_POWERSHELL_PARTS\s*=\s*\[[\s\S]*['"]System32['"][\s\S]*['"]WindowsPowerShell['"][\s\S]*['"]v1\.0['"][\s\S]*['"]powershell\.exe['"]/.test(client)
    || !/export\s+function\s+requireSystemPowerShellPath[\s\S]*win32\.isAbsolute[\s\S]*realpathSync\.native[\s\S]*win32\.relative[\s\S]*statSync\s*\(\s*expected\s*\)\.isFile/.test(client)
    || !/spawnSyncImpl\s*\(\s*resolveSystemPowerShellPath\s*\(\s*\)\s*,/.test(ownerQueryImplementation)
    || !/this\.systemPowerShellPath\s*\?\?=\s*resolveSystemPowerShellPath\s*\(\s*\)/.test(ensureChildImplementation)
    || !/this\.spawnImpl\s*\(\s*this\.systemPowerShellPath\s*,/.test(ensureChildImplementation)
    || /(?:spawnSyncImpl|this\.spawnImpl)\s*\(\s*['"]powershell\.exe['"]/.test(client)) {
    fail('desktop helper launch must use pinned System32 PowerShell')
  }
  if (!/semanticFingerprint:\s*string/.test(protocol)
    || !/\^\[a-f0-9\]\{64\}\$/.test(client)) {
    fail('stable opaque element semantic fingerprint wire contract missing')
  }
  const stopImplementation = client.match(/async\s+stop\s*\(\s*\)[\s\S]*?(?=\n\s*async\s+shutdown\s*\()/)?.[0] ?? ''
  if (!/await\s+this\.terminateExactChildAndWait\s*\(/.test(stopImplementation)
    || !/private\s+async\s+terminateExactChildAndWait\s*\(/.test(client)
    || !/exact child exit \$\{exitConfirmed \? 'confirmed' : 'unconfirmed'\}/.test(client)) {
    fail('desktop Stop timeout must await exact helper child exit')
  }
  if (/await\s+this\.hello\s*\(\s*\)/.test(stopImplementation)
    || !/const\s+exactChild\s*=\s*this\.child/.test(stopImplementation)
    || !/if\s*\(\s*!exactChild\s*\)\s*\{[\s\S]{0,360}await\s+this\.waitForTerminatingExactChild\s*\(\s*\)[\s\S]{0,120}return\s*\{\s*stopped:\s*true\s*\}[\s\S]{0,80}\}/.test(stopImplementation)
    || !/Math\.min\s*\(\s*500\s*,/.test(stopImplementation)
    || !/response\.stopped\s*!==\s*true/.test(stopImplementation)
    || !/this\.request\s*\(\s*['"]stop['"][\s\S]{0,220}skipHello:\s*true[\s\S]{0,160}exactChild[\s\S]{0,120}exactGeneration:\s*generation/.test(stopImplementation)) {
    fail('desktop Stop must use the existing exact child without handshake or spawn and stay within 500ms')
  }

  const protocolVersion = numericTsConstant(protocol, 'COMPUTER_PROTOCOL_VERSION')
  const declaredHelperVersion = stringTsConstant(protocol, 'COMPUTER_HELPER_VERSION')
  const sourceProtocolVersion = numericPowerShellConstant(sourceText, 'ProtocolVersion')
  const sourceHelperVersion = stringPowerShellConstant(sourceText, 'HelperVersion')
  const sourceAppVersion = stringPowerShellConstant(sourceText, 'AppVersion')
  const packagedProtocolVersion = numericPowerShellConstant(packagedText, 'ProtocolVersion')
  const packagedHelperVersion = stringPowerShellConstant(packagedText, 'HelperVersion')
  const packagedAppVersion = stringPowerShellConstant(packagedText, 'AppVersion')
  const sourceRuntimeProtocolVersion = numericCSharpConstant(sourceText, 'ProtocolVersion')
  const sourceRuntimeHelperVersion = stringCSharpConstant(sourceText, 'HelperVersion')
  const sourceRuntimeAppVersion = stringCSharpConstant(sourceText, 'AppVersion')
  const packagedRuntimeProtocolVersion = numericCSharpConstant(packagedText, 'ProtocolVersion')
  const packagedRuntimeHelperVersion = stringCSharpConstant(packagedText, 'HelperVersion')
  const packagedRuntimeAppVersion = stringCSharpConstant(packagedText, 'AppVersion')

  if (protocolVersion == null || declaredHelperVersion == null) fail('computer protocol constants missing')
  if (sourceProtocolVersion !== protocolVersion) fail('source helper protocol version mismatch')
  if (packagedProtocolVersion !== protocolVersion) fail('packaged helper protocol version mismatch')
  if (sourceHelperVersion !== declaredHelperVersion) fail('source helper version mismatch')
  if (packagedHelperVersion !== declaredHelperVersion) fail('packaged helper version mismatch')
  if (sourceAppVersion !== pkg.version) fail('source helper app version mismatch')
  if (packagedAppVersion !== pkg.version) fail('packaged helper app version mismatch')
  if (sourceRuntimeProtocolVersion !== protocolVersion) fail('source helper runtime protocol version mismatch')
  if (packagedRuntimeProtocolVersion !== protocolVersion) fail('packaged helper runtime protocol version mismatch')
  if (sourceRuntimeHelperVersion !== declaredHelperVersion) fail('source helper runtime version mismatch')
  if (packagedRuntimeHelperVersion !== declaredHelperVersion) fail('packaged helper runtime version mismatch')
  if (sourceRuntimeAppVersion !== pkg.version) fail('source helper runtime app version mismatch')
  if (packagedRuntimeAppVersion !== pkg.version) fail('packaged helper runtime app version mismatch')

  // These command cases and state transitions must exist in executable helper
  // code. Exact source-byte matching prevents replacing them in packaging.
  for (const command of [
    'hello', 'ping', 'list_candidates', 'probe_binding', 'observe',
    'prepare_action', 'commit_action', 'cancel', 'stop', 'shutdown',
  ]) {
    if (!new RegExp(`['\"]${command}['\"]`, 'i').test(sourceText)) {
      fail(`source helper command missing: ${command}`)
    }
  }
  if (!/PreparedActions/i.test(sourceText) || !/TryRemove/i.test(sourceText)) {
    fail('helper prepared-action one-shot state machine missing')
  }

  evidence.versionTriplet = {
    protocolVersion,
    appVersion: pkg.version,
    helperVersion: declaredHelperVersion,
  }
  evidence.helperSha256 = sha256(packagedHelper)
  evidence.helperBytes = statSync(packagedHelperPath).size
  evidence.exeSha256 = sha256(readFileSync(exePath))
  return { ok: failures.length === 0, failures, evidence }
}

/** Optional, read-only packaged smoke. Never sends observe/prepare/commit. */
export async function smokeComputerUsePackage({
  sourceDir,
  timeoutMs = 15_000,
  expectedProtocolVersion = 1,
  expectedHelperVersion,
  expectedAppVersion,
}) {
  const helperPath = join(sourceDir, 'resources', 'computer-use', 'helper.ps1')
  if (!existsSync(helperPath)) throw new Error('computer-use/helper.ps1 missing')
  const ownerStartTime100ns = queryWindowsProcessStartTime100ns(process.pid)
  const child = spawn(resolveSystemPowerShellPath(), [
    '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
    '-OwnerPid', String(process.pid),
    '-OwnerStartTime100ns', ownerStartTime100ns,
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = Buffer.alloc(0)
  let sequence = 0
  const pending = new Map()
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
  const rejectPending = error => {
    for (const item of pending.values()) item.reject(error)
    pending.clear()
  }
  child.on('error', rejectPending)
  child.on('exit', code => {
    if (pending.size) rejectPending(new Error(`helper smoke exited before ACK (${String(code)})`))
  })
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)])
    if (buffer.length > MAX_LINE_BYTES && buffer.indexOf(0x0a) < 0) {
      child.kill('SIGTERM')
      rejectPending(new Error('helper smoke line oversize'))
      return
    }
    while (true) {
      const newline = buffer.indexOf(0x0a)
      if (newline < 0) break
      const line = buffer.subarray(0, newline).toString('utf8').trim()
      buffer = buffer.subarray(newline + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { message = null }
      const item = message && pending.get(message.requestId)
      if (item) {
        pending.delete(message.requestId)
        if (message.ok === true) item.resolve(message)
        else item.reject(new Error('helper smoke rejected request'))
      }
    }
  })
  const request = (type, payload = {}) => new Promise((resolve, reject) => {
    sequence += 1
    const requestId = `package-smoke:${sequence}`
    pending.set(requestId, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ v: 1, type, requestId, ...payload })}\n`)
  })
  try {
    const hello = await request('hello', {
      appVersion: expectedAppVersion ?? null,
      protocolVersion: expectedProtocolVersion,
    })
    if (hello.protocolVersion !== expectedProtocolVersion
      || (expectedHelperVersion && hello.helperVersion !== expectedHelperVersion)
      || (expectedAppVersion && hello.appVersion !== expectedAppVersion)
      || hello.inputMonitorReady !== true) {
      throw new Error('helper smoke version/input-monitor handshake mismatch')
    }
    await request('ping')
    await request('shutdown')
    return { ok: true, hello }
  } finally {
    clearTimeout(timer)
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM')
  }
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = arg('root', process.cwd())
  const sourceDir = arg('source', join(root, 'release', 'win-unpacked'))
  try {
    const result = checkComputerUsePackage({ root, sourceDir })
    if (!result.ok) {
      console.error(`[computer-package] FAIL ${result.failures.join('; ')}`)
      process.exit(1)
    }
    console.log(`[computer-package] PASS ${JSON.stringify(result.evidence)}`)
    if (process.argv.includes('--smoke')) {
      await smokeComputerUsePackage({
        sourceDir,
        expectedProtocolVersion: result.evidence.versionTriplet.protocolVersion,
        expectedHelperVersion: result.evidence.versionTriplet.helperVersion,
        expectedAppVersion: result.evidence.versionTriplet.appVersion,
      })
      console.log('[computer-package] READ_ONLY_SMOKE PASS')
    }
  } catch (error) {
    console.error(`[computer-package] FAIL ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
