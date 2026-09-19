import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// @ts-expect-error Runtime release checker is intentionally plain ESM.
import * as checkerModule from '../../scripts/check-computer-use-package.mjs'

const checker = checkerModule as unknown as {
  checkComputerUsePackage(input: { root: string; sourceDir: string }): {
    ok: boolean
    failures: string[]
    evidence: Record<string, unknown>
  }
  decideComputerUsePackageGate(input: {
    haveSetup: boolean
    payloadTreeDir: string | null
    smokeUnpacked: string
  }): { kind: 'run'; sourceDir: string } | { kind: 'fail' | 'skip'; reason: string }
  auditComputerHelperSource(source: string): string[]
  auditComputerCandidateLeaseSources(sources: {
    helper: string
    protocol: string
    types: string
    client: string
    backend: string
    controller: string
  }): string[]
  auditComputerReducedActionSources(sources: {
    helper: string
    controller: string
    main: string
    tools: string
    handler: string
  }): string[]
  queryWindowsProcessStartTime100ns(
    ownerPid: number,
    spawnSyncImpl?: (...args: unknown[]) => {
      stdout?: string
      stderr?: string
      status: number | null
      signal: string | null
      error?: Error
    },
  ): string
}

const ROOT = process.cwd()
const temps: string[] = []

function fixture(root = ROOT): string {
  const sourceDir = mkdtempSync(join(tmpdir(), 'verstak-computer-package-'))
  temps.push(sourceDir)
  writeFileSync(join(sourceDir, 'Verstak.exe'), 'MZ-fixture')
  const helperDir = join(sourceDir, 'resources', 'computer-use')
  mkdirSync(helperDir, { recursive: true })
  cpSync(join(root, 'resources', 'computer-use', 'helper.ps1'), join(helperDir, 'helper.ps1'))
  return sourceDir
}

function sourceFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'verstak-computer-source-'))
  temps.push(root)
  for (const relativePath of [
    'package.json',
    'electron/ai/computer/protocol.ts',
    'electron/ai/computer/types.ts',
    'electron/ai/computer/helper-client.ts',
    'electron/ai/computer/helper-backend.ts',
    'electron/ai/computer/controller.ts',
    'electron/ai/tools.ts',
    'electron/ipc/tool-handlers/computer.ts',
    'electron/main.ts',
    'resources/computer-use/helper.ps1',
  ]) {
    const target = join(root, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(ROOT, relativePath), target)
  }
  return root
}

function matchedSourceSection(source: string, pattern: RegExp): string {
  return source.match(pattern)?.[0] ?? ''
}

function auditHelperLifecyclePins(source: string): string[] {
  const failures: string[] = []
  const probeExact = matchedSourceSection(source,
    /private\s+static\s+WindowProbe\s+ProbeExact[\s\S]*?(?=\n\s*private\s+static\s+bool\s+IsDestroyedWindowInstance)/,
  )
  const handleProbe = matchedSourceSection(source,
    /private\s+static\s+void\s+HandleProbe[\s\S]*?(?=\n\s*private\s+static\s+void\s+HandleObserve)/,
  )
  const destroyEventProc = matchedSourceSection(source,
    /private\s+static\s+void\s+DestroyEventProc[\s\S]*?(?=\n\s*private\s+static\s+bool\s+IsSecureSurface)/,
  )
  const observeTimeout = matchedSourceSection(source,
    /Task\.Delay\s*\(\s*ObservationTimeoutMs\s*\)\.ContinueWith[\s\S]*?(?=\n\s*}\);\n\s*})/,
  )
  const stop = matchedSourceSection(source,
    /private\s+static\s+void\s+HandleStop[\s\S]*?(?=\n\s*private\s+static\s+void\s+HandleShutdown)/,
  )
  const shutdown = matchedSourceSection(source,
    /private\s+static\s+void\s+HandleShutdown[\s\S]*?(?=\n\s*private\s+static\s+ExecutionOutcome)/,
  )

  const lifecycleChecks = [
    /private\s+const\s+uint\s+EventObjectDestroy\s*=\s*0x8001\s*;/.test(source),
    /private\s+const\s+int\s+MaxDestroyedWindowTombstones\s*=\s*256\s*;/.test(source),
    /ConcurrentDictionary<string,\s*byte>\s+DestroyedWindowInstances/.test(source),
    /ConcurrentQueue<string>\s+DestroyedWindowOrder/.test(source),
    !/ConcurrentDictionary<long,\s*byte>\s+DestroyedWindowHandles/.test(source),
    /DestroyHook\s*=\s*SetWinEventHook\s*\(\s*EventObjectDestroy\s*,\s*EventObjectDestroy/.test(source),
    /eventType\s*!=\s*EventObjectDestroy[\s\S]*objectId\s*!=\s*ObjIdWindow[\s\S]*childId\s*!=\s*ChildIdSelf/.test(destroyEventProc),
    /selected\.Hwnd\s*!=\s*hwnd[\s\S]*PendingProbeWindowInstance[\s\S]*RememberDestroyedWindowInstance\s*\(\s*destroyed\s*\)/.test(destroyEventProc),
    /private\s+static\s+void\s+RememberDestroyedWindowInstance[\s\S]*IdentityKey\s*\(\s*identity\s*\)[\s\S]*DestroyedWindowInstances\.TryAdd[\s\S]*DestroyedWindowOrder\.Enqueue[\s\S]*DestroyedWindowInstances\.Count\s*>\s*MaxDestroyedWindowTombstones[\s\S]*DestroyedWindowInstances\.TryRemove/.test(source),
    /private\s+static\s+bool\s+IsDestroyedWindowInstance[\s\S]*DestroyedWindowInstances\.ContainsKey\s*\(\s*IdentityKey\s*\(\s*identity\s*\)\s*\)/.test(source),
    /private\s+static\s+string\s+IdentityKey\s*\(\s*WindowIdentity\s+identity\s*\)[^\n]*identity\.Pid[^\n]*identity\.Start[^\n]*identity\.Hwnd\.ToInt64\s*\(\s*\)/.test(source),
    /IsDestroyedWindowInstance\s*\(\s*expected\s*\)/.test(probeExact),
    (probeExact.match(/IsDestroyedWindowInstance\s*\(\s*actual\s*\)/g)?.length ?? 0) >= 2,
    /UnhookWinEvent\s*\(\s*DestroyHook\s*\)/.test(source),
    /ConcurrentDictionary<long,\s*long>\s+TrackedWindowDestroyGenerations/.test(source),
    /ChildIdSelf\s*\)\s*return\s*;[\s\S]*lock\s*\(\s*WindowLifecycleLock\s*\)[\s\S]*if\s*\(\s*!AdvanceWindowDestroyGeneration\s*\(\s*hwnd\s*\)\s*\)\s*return\s*;[\s\S]*selected\.Hwnd\s*!=\s*hwnd/.test(destroyEventProc),
    !/WindowDestroyEventEpoch/.test(source),
    /private\s+static\s+readonly\s+object\s+WindowLifecycleLock/.test(source),
    /private\s+static\s+WindowIdentity\s+PendingProbeWindowInstance\s*;/.test(source),
  ]
  const firstDrain = probeExact.indexOf('DrainForegroundEvents();')
  const expectedTombstoneCheck = probeExact.indexOf('IsDestroyedWindowInstance(expected)')
  const identityRead = probeExact.indexOf('TryIdentity(expected.Hwnd, out actual)')
  const postIdentityDrain = probeExact.indexOf('DrainForegroundEvents();', identityRead)
  const firstActualTombstoneCheck = probeExact.indexOf('IsDestroyedWindowInstance(actual)', postIdentityDrain)
  const finalDrain = probeExact.lastIndexOf('DrainForegroundEvents();')
  const finalActualTombstoneCheck = probeExact.lastIndexOf('IsDestroyedWindowInstance(actual)')
  const destroyGenerationCapture = probeExact.indexOf('long destroyGeneration = WindowDestroyGeneration(expected.Hwnd);')
  const destroyGenerationChecks = probeExact.match(/destroyGeneration != WindowDestroyGeneration\(expected\.Hwnd\)/g)?.length ?? 0
  lifecycleChecks.push(
    /private\s+static\s+readonly\s+object\s+WinEventBarrierLock/.test(source),
    /private\s+static\s+void\s+DrainForegroundEvents[\s\S]*lock\s*\(\s*WinEventBarrierLock\s*\)[\s\S]*PostThreadMessage[\s\S]*ForegroundBarrierAck\.WaitOne/.test(source),
    firstDrain >= 0,
    expectedTombstoneCheck > firstDrain,
    identityRead > expectedTombstoneCheck,
    postIdentityDrain > identityRead,
    firstActualTombstoneCheck > postIdentityDrain,
    finalDrain > firstActualTombstoneCheck,
    finalActualTombstoneCheck > finalDrain,
    destroyGenerationCapture > firstDrain,
    destroyGenerationChecks >= 2,
  )
  const armDrain = handleProbe.indexOf('DrainForegroundEvents();')
  const bindGenerationCapture = handleProbe.indexOf('long bindDestroyGeneration;', armDrain)
  const armLock = handleProbe.indexOf('lock (WindowLifecycleLock)', armDrain)
  const inlineTokenGeneration = handleProbe.indexOf('ConsumeCandidateLease(candidateToken, expected).DestroyGeneration', armLock)
  const leasedTokenGeneration = handleProbe.indexOf('CandidateLease lease = ConsumeCandidateLease(candidateToken, expected);', armLock)
  const tokenGeneration = inlineTokenGeneration >= 0 ? inlineTokenGeneration : leasedTokenGeneration
  const pendingArm = handleProbe.indexOf('PendingProbeWindowInstance = expected;', tokenGeneration)
  const bindProbe = handleProbe.indexOf(
    'WindowProbe probe = ProbeExact(\n                    expected, true, MaxSurfaceInspectionElements, BindingSurfaceInspectionTimeoutMs);',
    pendingArm,
  )
  const assignmentDrain = handleProbe.indexOf('DrainForegroundEvents();', bindProbe)
  const assignmentLock = handleProbe.indexOf('lock (WindowLifecycleLock)', assignmentDrain)
  const assignmentGenerationCheck = handleProbe.indexOf('bindDestroyGeneration != WindowDestroyGeneration(expected.Hwnd)', assignmentLock)
  const selectedAssignment = handleProbe.indexOf('SelectedWindowInstance = probe.Identity;', assignmentGenerationCheck)
  const pendingClear = handleProbe.indexOf('PendingProbeWindowInstance = null;', selectedAssignment)
  lifecycleChecks.push(
    armDrain >= 0,
    bindGenerationCapture > armDrain,
    armLock > bindGenerationCapture,
    tokenGeneration > armLock,
    pendingArm > tokenGeneration,
    bindProbe > pendingArm,
    assignmentDrain > bindProbe,
    assignmentLock > assignmentDrain,
    assignmentGenerationCheck > assignmentLock,
    selectedAssignment > assignmentGenerationCheck,
    pendingClear > selectedAssignment,
    !/lock\s*\(\s*WindowLifecycleLock\s*\)\s*\{\s*DrainForegroundEvents\s*\(\s*\)\s*;/.test(handleProbe),
  )
  const destroyLifecycleLock = destroyEventProc.indexOf('lock (WindowLifecycleLock)')
  const destroyGenerationAdvance = destroyEventProc.indexOf('AdvanceWindowDestroyGeneration(hwnd)', destroyLifecycleLock)
  lifecycleChecks.push(
    destroyLifecycleLock >= 0,
    destroyGenerationAdvance > destroyLifecycleLock,
  )
  if (lifecycleChecks.includes(false)) {
    failures.push('exact HWND instance destroy lifecycle pin missing')
  }

  const observationStopChecks = [
    Boolean(stop),
    /ActiveObservations\.Count\s*>\s*0/.test(stop),
    /ObservationQueue\.CurrentCount\s*==\s*0/.test(stop),
    /"stop_timeout"/.test(stop),
    !/ActiveObservations\.TryRemove/.test(observeTimeout),
  ]
  if (observationStopChecks.includes(false)) {
    failures.push('Stop does not retain and drain timed-out observation workers')
  }
  if (/SelectedWindowInstance\s*=\s*null/.test(stop)
    || !/SelectedWindowInstance\s*=\s*null/.test(shutdown)) {
    failures.push('Stop must preserve exact selected window while shutdown clears it')
  }

  return failures
}

function auditHelperCredentialSurfacePins(source: string): string[] {
  const failures: string[] = []
  const secureSurface = source.match(
    /private\s+static\s+bool\s+IsSecureSurface\s*\(\s*IntPtr\s+hwnd,\s*string\s+title,\s*int\s+maxElements[\s\S]*?(?=\n\s*private\s+static\s+bool\s+IsPassword)/,
  )?.[0] ?? ''
  const executeObserve = source.match(
    /private\s+static\s+IDictionary<string,\s*object>\s+ExecuteObserve[\s\S]*?(?=\n\s*private\s+static\s+void\s+RequireObservationBudget)/,
  )?.[0] ?? ''

  if (!/private\s+static\s+readonly\s+string\[\]\s+CredentialMarkers[\s\S]*"api key"[\s\S]*"api-key"[\s\S]*"apikey"[\s\S]*"access token"[\s\S]*"client secret"[\s\S]*"secret key"[\s\S]*"private key"[\s\S]*"authorization"[\s\S]*"api ключ"[\s\S]*"ключ api"[\s\S]*"токен доступа"[\s\S]*"секрет"[\s\S]*"приватный ключ"/.test(source)
    || !/ContainsCredentialMarker\s*\(\s*joined\s*\)/.test(secureSurface)
    || !/ContainsCredentialMarker\s*\(\s*marker\s*\)/.test(source)) {
    failures.push('top-level title/root credential marker classification missing')
  }
  if (!/if\s*\(\s*IsAuthenticationControl\s*\(\s*root\s*\)\s*\)\s*throw\s+new\s+SafeError\s*\(\s*"authentication_surface"/.test(executeObserve)) {
    failures.push('observe root credential surface guard missing')
  }
  return failures
}

function ownerExitDeadlineStartsAfterHandshake(source: string): boolean {
  const caseStart = source.indexOf('self-exits when its exact temporary owner process ends')
  const ownerCase = caseStart >= 0 ? source.slice(caseStart) : ''
  const hello = ownerCase.indexOf('await client.hello()')
  const deadline = ownerCase.indexOf('crashTimeout = setTimeout(')
  const ownerKill = ownerCase.indexOf("owner.kill('SIGTERM')")
  return hello >= 0 && deadline > hello && ownerKill > deadline
}

afterEach(() => {
  for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('computer use packaged artifact checker', () => {
  it('pins exact helper bytes and app/helper/protocol versions', () => {
    const result = checker.checkComputerUsePackage({ root: ROOT, sourceDir: fixture() })
    expect(result.ok, result.failures.join('; ')).toBe(true)
    expect(result.evidence).toMatchObject({
      versionTriplet: { protocolVersion: 1, appVersion: '2.9.1', helperVersion: '2.9.1' },
      helperBytes: expect.any(Number),
      helperSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
  })

  it('fails on missing, byte-drifted or test-enabled helper payload', () => {
    const missing = fixture()
    rmSync(join(missing, 'resources', 'computer-use', 'helper.ps1'))
    expect(checker.checkComputerUsePackage({ root: ROOT, sourceDir: missing }).failures)
      .toContain('computer-use/helper.ps1 missing')

    const drifted = fixture()
    const driftedPath = join(drifted, 'resources', 'computer-use', 'helper.ps1')
    writeFileSync(driftedPath, `${readFileSync(driftedPath, 'utf8')}\n# drift\n`)
    expect(checker.checkComputerUsePackage({ root: ROOT, sourceDir: drifted }).failures)
      .toContain('computer-use/helper.ps1 differs from reviewed source')

    const root = sourceFixture()
    const testEnabled = fixture()
    for (const helperPath of [
      join(root, 'resources', 'computer-use', 'helper.ps1'),
      join(testEnabled, 'resources', 'computer-use', 'helper.ps1'),
    ]) writeFileSync(helperPath, `${readFileSync(helperPath, 'utf8')}\n# --test-only\n`)
    const result = checker.checkComputerUsePackage({ root, sourceDir: testEnabled })
    expect(result.ok).toBe(false)
    expect(result.failures).toContain('source helper contains forbidden test-only switch')
    expect(result.failures).toContain('packaged helper contains forbidden test-only switch')
  })

  it('fails closed when a built Setup has no verified payload tree', () => {
    expect(checker.decideComputerUsePackageGate({
      haveSetup: true,
      payloadTreeDir: null,
      smokeUnpacked: fixture(),
    })).toEqual({
      kind: 'fail',
      reason: 'Setup.exe exists but its verified computer helper payload tree is unavailable',
    })
  })

  it('does not trust display-only PowerShell versions when embedded runtime drifts', () => {
    const root = sourceFixture()
    const sourceHelper = join(root, 'resources', 'computer-use', 'helper.ps1')
    writeFileSync(sourceHelper, readFileSync(sourceHelper, 'utf8').replace(
      'private const string HelperVersion = "2.9.1";',
      'private const string HelperVersion = "2.9.2";',
    ))
    const result = checker.checkComputerUsePackage({ root, sourceDir: fixture(root) })
    expect(result.ok).toBe(false)
    expect(result.failures).toContain('source helper runtime version mismatch')
    expect(result.failures).toContain('packaged helper runtime version mismatch')
  })

  it('packages the helper and wires a fail-closed check into the real release gate', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      build?: { win?: { extraResources?: Array<{ from?: string; to?: string }> } }
    }
    expect(pkg.build?.win?.extraResources).toContainEqual({
      from: 'resources/computer-use/helper.ps1',
      to: 'computer-use/helper.ps1',
    })

    const releaseGate = readFileSync(join(ROOT, 'scripts', 'release-gate.mjs'), 'utf8')
    expect(releaseGate).toMatch(/import\s*\{\s*decideComputerUsePackageGate\s*\}/)
    expect(releaseGate).toContain('const computerPackageDecision = decideComputerUsePackageGate({')
    expect(releaseGate).toContain("'check-computer-use-package.mjs'")
    expect(releaseGate).not.toContain('Computer Use package check пропущен: нет дерева артефакта')
  })

  it('pins login/CAPTCHA/2FA and per-chunk foreground guards against mutation', () => {
    const source = readFileSync(join(ROOT, 'resources', 'computer-use', 'helper.ps1'), 'utf8')
    expect(checker.auditComputerHelperSource(source)).toEqual([])

    const authMutation = source.replace(
      '|| ContainsStandaloneOtpOrPin(marker)',
      '|| false /* mutated: standalone OTP/PIN not classified */',
    )
    expect(authMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(authMutation))
      .toContain('authentication/CAPTCHA/2FA fail-closed guard missing')

    const ansiDecodedMutation = source.replace(/^\uFEFF/, '')
    expect(ansiDecodedMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(ansiDecodedMutation))
      .toContain('authentication/CAPTCHA/2FA fail-closed guard missing')

    const chunkMutation = source.replaceAll(
      'RequireDispatchWithinInterval(chunkTimer);',
      '/* mutated: no bounded chunk interval */',
    )
    expect(chunkMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(chunkMutation))
      .toContain('UIA chunk guard must require exact foreground target')
  })

  it('pins reduced UIA action advertising and the post-action input epoch', () => {
    const source = readFileSync(join(ROOT, 'resources', 'computer-use', 'helper.ps1'), 'utf8')
    const keyMutation = source.replace(
      'if (element.TryGetCurrentPattern(ScrollPattern.Pattern, out ignored)) result.Add("scroll");',
      'if (element.Current.IsKeyboardFocusable) result.Add("key");\n            if (element.TryGetCurrentPattern(ScrollPattern.Pattern, out ignored)) result.Add("scroll");',
    )
    expect(keyMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(keyMutation))
      .toContain('reduced UIA action surface contract missing')

    const epochMutation = source.replace(
      'action.Expected.UserInputEpoch = expectedInput;',
      'action.Expected.UserInputEpoch = action.Expected.UserInputEpoch;',
    )
    expect(epochMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(epochMutation))
      .toContain('observable text and post-action input epoch contract missing')
  })

  it('pins visual observation to the exact selected HWND without desktop capture APIs', () => {
    const source = readFileSync(join(ROOT, 'resources', 'computer-use', 'helper.ps1'), 'utf8')
    expect(checker.auditComputerHelperSource(source)).not.toContain(
      'exact-window privacy-safe visual observation missing',
    )

    const desktopMutation = source.replace(
      'PrintWindow(expected.Hwnd, hdc, PrintWindowRenderFullContent)',
      'CopyFromScreen(0, 0, 0, 0, source.Size)',
    )
    expect(desktopMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(desktopMutation))
      .toContain('exact-window privacy-safe visual observation missing')

    const root = sourceFixture()
    const clientPath = join(root, 'electron', 'ai', 'computer', 'helper-client.ts')
    writeFileSync(clientPath, readFileSync(clientPath, 'utf8').replace(
      'bytes.length > MAX_COMPUTER_SCREENSHOT_BYTES',
      'false /* mutated: unbounded screenshot transport */',
    ))
    const result = checker.checkComputerUsePackage({ root, sourceDir: fixture(root) })
    expect(result.failures).toContain('desktop screenshot transport bounds missing')
  })

  it('pins owner/terminal exclusion, physical hooks, drained Stop and the production global-input boundary', () => {
    const source = readFileSync(join(ROOT, 'resources', 'computer-use', 'helper.ps1'), 'utf8')
    const ownerMutation = source.replace('actual.Pid == OwnerPid', 'false')
    expect(ownerMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(ownerMutation))
      .toContain('owner/terminal/development-surface exclusion missing')

    const hookMutation = source.replace(
      'return HooksReady ? Interlocked.Read(ref PhysicalInputEpoch) : -1L;',
      'return 0L;',
    )
    expect(checker.auditComputerHelperSource(hookMutation))
      .toContain('low-level physical-input monitor missing')

    const stopMutation = source.replace('DateTime.UtcNow.AddMilliseconds(450)', 'DateTime.UtcNow')
    expect(checker.auditComputerHelperSource(stopMutation))
      .toContain('Stop ACK active-queue drain barrier missing')

    const actionSources = {
      helper: source,
      controller: readFileSync(join(ROOT, 'electron', 'ai', 'computer', 'controller.ts'), 'utf8'),
      main: readFileSync(join(ROOT, 'electron', 'main.ts'), 'utf8'),
      tools: readFileSync(join(ROOT, 'electron', 'ai', 'tools.ts'), 'utf8'),
      handler: readFileSync(join(ROOT, 'electron', 'ipc', 'tool-handlers', 'computer.ts'), 'utf8'),
    }
    expect(checker.auditComputerReducedActionSources(actionSources)).toEqual([])

    const globalFallbackMutation = {
      ...actionSources,
      controller: actionSources.controller.replace(
        'const allowUnverifiedGlobalInput = deps.testOnlyAllowUnverifiedGlobalInput === true',
        'const allowUnverifiedGlobalInput = true /* mutated: production SendInput enabled */',
      ),
    }
    expect(globalFallbackMutation.controller).not.toBe(actionSources.controller)
    expect(checker.auditComputerReducedActionSources(globalFallbackMutation))
      .toContain('production global input/key/coordinates boundary missing')

    const postPrepareFallbackMutation = {
      ...actionSources,
      controller: actionSources.controller.replace(
        "&& !(exactElementCoordinateClick && prepared.method === 'coordinates')) {",
        "&& false /* mutated: any helper fallback may commit */) {",
      ),
    }
    expect(postPrepareFallbackMutation.controller).not.toBe(actionSources.controller)
    expect(checker.auditComputerReducedActionSources(postPrepareFallbackMutation))
      .toContain('production global input/key/coordinates boundary missing')

    const unboundedCoordinateMutation = {
      ...actionSources,
      controller: actionSources.controller.replace(
        '&& !isStatefulClickState(element.backend.state)',
        '|| true /* mutated: any click may use coordinates */',
      ),
    }
    expect(unboundedCoordinateMutation.controller).not.toBe(actionSources.controller)
    expect(checker.auditComputerReducedActionSources(unboundedCoordinateMutation))
      .toContain('production global input/key/coordinates boundary missing')

    const mainBypassMutation = {
      ...actionSources,
      main: actionSources.main.replace(
        'backend: computerBackend,',
        'backend: computerBackend,\n      testOnlyAllowUnverifiedGlobalInput: true,',
      ),
    }
    expect(mainBypassMutation.main).not.toBe(actionSources.main)
    expect(checker.auditComputerReducedActionSources(mainBypassMutation))
      .toContain('production global input/key/coordinates boundary missing')

    const controllerClearMutation = {
      ...actionSources,
      controller: actionSources.controller.replace(
        "if (input.action === 'type' && input.clearFirst !== undefined)",
        "if (false /* mutated: legacy clearFirst accepted */)",
      ),
    }
    expect(controllerClearMutation.controller).not.toBe(actionSources.controller)
    expect(checker.auditComputerReducedActionSources(controllerClearMutation))
      .toContain('clearFirst or empty type boundary missing')

    const helperClearMutation = {
      ...actionSources,
      helper: actionSources.helper.replace(
        'if (kind == "type" && (action.ContainsKey("clearFirst") || message.ContainsKey("clearFirst")))',
        'if (false /* mutated: direct helper clearFirst accepted */)',
      ),
    }
    expect(helperClearMutation.helper).not.toBe(actionSources.helper)
    expect(checker.auditComputerReducedActionSources(helperClearMutation))
      .toContain('clearFirst or empty type boundary missing')

    const oneShotReadbackMutation = {
      ...actionSources,
      controller: actionSources.controller.replace(
        'assertStablePostObservation(postObservation, settledObservation)',
        '/* mutated: a transient first read is enough */',
      ),
    }
    expect(oneShotReadbackMutation.controller).not.toBe(actionSources.controller)
    expect(checker.auditComputerReducedActionSources(oneShotReadbackMutation))
      .toContain('controller stable two-observation postcondition contract missing')
  })

  it('pins whole-surface exclusion and exact UIA Value/Toggle/Selection/Scroll proof semantics', () => {
    const source = readFileSync(join(ROOT, 'resources', 'computer-use', 'helper.ps1'), 'utf8')

    const surfaceMutation = source.replace(
      'return inspectSurfaceDescendants && HasUnsafeSurfaceDescendant(hwnd, maxElements, maxMilliseconds);',
      'return false;',
    )
    expect(surfaceMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(surfaceMutation))
      .toContain('whole-surface credential/auth/launch guard missing')

    const turnstileMutation = source
      .replaceAll('"verify you are human"', '"ordinary prompt"')
      .replaceAll('"just a moment"', '"ordinary title"')
    expect(turnstileMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(turnstileMutation))
      .toContain('authentication/CAPTCHA/2FA fail-closed guard missing')

    const recaptchaMutation = source.replaceAll('"not a robot"', '"ordinary statement"')
    expect(recaptchaMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(recaptchaMutation))
      .toContain('authentication/CAPTCHA/2FA fail-closed guard missing')

    const otpMutation = source.replaceAll('"otp code"', '"ordinary code"')
    expect(otpMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(otpMutation))
      .toContain('authentication/CAPTCHA/2FA fail-closed guard missing')

    const standaloneOtpMutation = source
      .replaceAll('"otp"', '"ordinary field"')
      .replaceAll('"код из приложения"', '"обычное поле"')
    expect(standaloneOtpMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(standaloneOtpMutation))
      .toContain('authentication/CAPTCHA/2FA fail-closed guard missing')

    const terminalMutation = source.replace('"putty", "puttytel", "kitty", "wezterm"', '"puttytel"')
    expect(terminalMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(terminalMutation))
      .toContain('owner/terminal/development-surface exclusion missing')

    const noOpMutation = source.replace(
      'beforeValue != accumulated && afterValue == accumulated',
      'afterValue == accumulated',
    )
    expect(noOpMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(noOpMutation))
      .toContain('action-specific secret-free effect readback missing')

    const secretDigestMutation = source.replace(
      'result["inputLength"] = scalarLength;',
      'result["inputLength"] = scalarLength; result["inputSha256"] = Hash("secret");',
    )
    expect(secretDigestMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(secretDigestMutation))
      .toContain('action-specific secret-free effect readback missing')

    const foregroundMutation = source.replace(
      'ForegroundHook = SetWinEventHook(EventSystemForeground, EventSystemForeground, IntPtr.Zero, ForegroundCallback, 0, 0, WineventOutOfContext);',
      'ForegroundHook = IntPtr.Zero;',
    )
    expect(foregroundMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(foregroundMutation))
      .toContain('foreground epoch and UIA dispatch boundary missing')

    const focusReturnMutation = source.replace(
      '&& prepared.PreparedForegroundEpoch == postForegroundEpoch',
      '&& true /* mutated: focus switched away and back */',
    )
    expect(focusReturnMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(focusReturnMutation))
      .toContain('foreground epoch and UIA dispatch boundary missing')

    const staleValueMutation = source.replace(
      'else if (!String.Equals(currentValue, accumulated, StringComparison.Ordinal))',
      'else if (false /* mutated: external edit between chunks accepted */)',
    )
    expect(staleValueMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(staleValueMutation))
      .toContain('UIA ValuePattern append/chunk/state contract missing')

    const toggleMutation = source.replace(
      'RequireExpectedElementTransition(action, "toggle", SafeToggleState(before));',
      '/* mutated: stale toggle pre-state accepted */',
    )
    expect(toggleMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(toggleMutation))
      .toContain('UIA Toggle/Selection exact-transition contract missing')

    const selectionMutation = source.replace(
      'return Outcome(true, MatchesExpectedElementTransition(action, "selection", after ? "selected" : "not-selected"));',
      'return Outcome(true, after); /* mutated: wrong selection transition accepted */',
    )
    expect(selectionMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(selectionMutation))
      .toContain('UIA Toggle/Selection exact-transition contract missing')

    const partialScrollMutation = source.replace(
      '&& ScrollDirectionMatched(action.DeltaY, beforeVertical, afterVertical);',
      '|| ScrollDirectionMatched(action.DeltaY, beforeVertical, afterVertical);',
    )
    expect(partialScrollMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(partialScrollMutation))
      .toContain('UIA ScrollPattern one-step state/direction contract missing')

    const oversizedScrollMutation = source.replaceAll(
      'OptionalInt(scroll, "deltaY", 0, -1, 1)',
      'OptionalInt(scroll, "deltaY", 0, -2000, 2000)',
    ).replaceAll(
      'OptionalInt(action, "deltaY", 0, -1, 1)',
      'OptionalInt(action, "deltaY", 0, -2000, 2000)',
    )
    expect(oversizedScrollMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(oversizedScrollMutation))
      .toContain('UIA ScrollPattern one-step state/direction contract missing')

    const invokeReadbackMutation = source.replace(
      'string pointerBeforeSurface = SurfaceStateFingerprint(action.Identity, cancellation);',
      'string pointerBeforeSurface = "unverified"; /* mutated: click has no before-state */',
    )
    expect(invokeReadbackMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(invokeReadbackMutation))
      .toContain('exact stateless coordinate click bounded surface readback contract missing')
  })

  it('pins the desktop client Stop timeout to exact-child exit confirmation', () => {
    const root = sourceFixture()
    const clientPath = join(root, 'electron', 'ai', 'computer', 'helper-client.ts')
    writeFileSync(clientPath, readFileSync(clientPath, 'utf8').replace(
      'exitConfirmed = await this.terminateExactChildAndWait(',
      'exitConfirmed = (this.terminateExactChild(), true) && await Promise.resolve(',
    ))
    const result = checker.checkComputerUsePackage({ root, sourceDir: fixture(root) })
    expect(result.ok).toBe(false)
    expect(result.failures).toContain('desktop Stop timeout must await exact helper child exit')
  })

  it('pins cold Stop to the existing exact child without a handshake or spawn', () => {
    const root = sourceFixture()
    const clientPath = join(root, 'electron', 'ai', 'computer', 'helper-client.ts')
    writeFileSync(clientPath, readFileSync(clientPath, 'utf8').replace(
      'await this.waitForTerminatingExactChild()\n      return { stopped: true }',
      'await this.hello()\n      return { stopped: true }',
    ))
    const result = checker.checkComputerUsePackage({ root, sourceDir: fixture(root) })
    expect(result.ok).toBe(false)
    expect(result.failures).toContain(
      'desktop Stop must use the existing exact child without handshake or spawn and stay within 500ms',
    )

    const malformedAckRoot = sourceFixture()
    const malformedAckClientPath = join(malformedAckRoot, 'electron', 'ai', 'computer', 'helper-client.ts')
    writeFileSync(malformedAckClientPath, readFileSync(malformedAckClientPath, 'utf8').replace(
      'response.stopped !== true',
      'false',
    ))
    const malformedAckResult = checker.checkComputerUsePackage({
      root: malformedAckRoot,
      sourceDir: fixture(malformedAckRoot),
    })
    expect(malformedAckResult.ok).toBe(false)
    expect(malformedAckResult.failures).toContain(
      'desktop Stop must use the existing exact child without handshake or spawn and stay within 500ms',
    )
  })

  it('pins stable UIA element identity and asynchronous bounded observation', () => {
    const source = readFileSync(join(ROOT, 'resources', 'computer-use', 'helper.ps1'), 'utf8')
    expect(checker.auditComputerHelperSource(source)).toEqual([])

    const prepareOnlyMutation = source.replace(
      'RequireElementCurrent(entry);',
      '/* mutated: no prepare-time semantic revalidation */',
    )
    expect(prepareOnlyMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(prepareOnlyMutation))
      .toContain('stable UIA element fingerprint/revalidation missing')

    const fingerprintMutation = source.replaceAll(
      'RequireElementCurrent(entry);',
      '/* mutated: recycled UIA element accepted */',
    )
    expect(fingerprintMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(fingerprintMutation))
      .toContain('stable UIA element fingerprint/revalidation missing')

    const semanticWireMutation = source.replace(
      '{ "semanticFingerprint", fingerprint },',
      '{ "semanticFingerprint", "unstable" },',
    )
    expect(semanticWireMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(semanticWireMutation))
      .toContain('stable UIA element fingerprint/revalidation missing')

    const blockingObserveMutation = source.replace(
      'Task.Run(delegate {\n                bool queueHeld = false;',
      '/* mutated: observe runs on stdin loop */\n            delegate {\n                bool queueHeld = false;',
    )
    expect(blockingObserveMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(blockingObserveMutation))
      .toContain('bounded asynchronous observation/Stop isolation missing')

    const foregroundObserveMutation = source.replace(
      /(WindowProbe probe = ProbeExact\(\s*expected,\s*true,\s*MaxSurfaceInspectionElements,\s*MaxTargetCheckIntervalMs,\s*false\s*\);)/,
      '$1\n            if (!probe.Foreground) throw new SafeError("stale_focus", "mutated");',
    )
    expect(foregroundObserveMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(foregroundObserveMutation))
      .toContain('read-only observation must allow exact background windows while effectful actions require foreground')

    const focusChangingObserveMutation = source.replace(
      'if (root == null) throw new SafeError("uia_unavailable", "UI Automation root unavailable");',
      'if (root == null) throw new SafeError("uia_unavailable", "UI Automation root unavailable");\n            root.SetFocus(); /* mutated: observation steals focus */',
    )
    expect(focusChangingObserveMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(focusChangingObserveMutation))
      .toContain('read-only observation must allow exact background windows while effectful actions require foreground')

    const unlockedObserveMutation = source.replaceAll(
      'if (probe.ScreenLocked) throw new SafeError("screen_locked", "interactive desktop unavailable");',
      '/* mutated: observe ignores locked desktop */',
    ).replaceAll(
      'if (finalProbe.ScreenLocked) throw new SafeError("screen_locked", "interactive desktop unavailable");',
      '/* mutated: observe ignores locked desktop */',
    )
    expect(unlockedObserveMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(unlockedObserveMutation))
      .toContain('read-only observation must allow exact background windows while effectful actions require foreground')
  })

  it('pins exact owner-process watchdog self-exit', () => {
    const source = readFileSync(join(ROOT, 'resources', 'computer-use', 'helper.ps1'), 'utf8')
    expect(checker.auditComputerHelperSource(source)).toEqual([])

    const orphanMutation = source.replace(
      'StartOwnerWatchdog(ownerPid, ownerStartTime100ns);',
      '/* mutated: helper may outlive owner */',
    )
    expect(orphanMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(orphanMutation))
      .toContain('exact owner-process watchdog/self-exit missing')

    const pidReuseMutation = source.replace(
      'if (!String.Equals(actualOwnerStartTime100ns, ownerStartTime100ns, StringComparison.Ordinal))',
      'if (false /* mutated: PID reuse accepted */)',
    )
    expect(pidReuseMutation).not.toBe(source)
    expect(checker.auditComputerHelperSource(pidReuseMutation))
      .toContain('exact owner-process creation identity pin missing')

    const smokeSource = readFileSync(join(ROOT, 'tests', 'ai', 'computer', 'helper-windows-smoke.test.ts'), 'utf8')
    expect(ownerExitDeadlineStartsAfterHandshake(smokeSource)).toBe(true)
    expect(ownerExitDeadlineStartsAfterHandshake(`
      self-exits when its exact temporary owner process ends
      crashTimeout = setTimeout(() => reject(new Error('late')), 5_000)
      await client.hello()
      owner.kill('SIGTERM')
    `)).toBe(false)
  })

  it('pins a bounded canonical owner FILETIME query before every helper spawn', () => {
    const calls: unknown[][] = []
    const exact = checker.queryWindowsProcessStartTime100ns(4242, ((...args: unknown[]) => {
      calls.push(args)
      return {
        stdout: '134047193123456789', stderr: '', status: 0, signal: null,
      }
    }) as never)
    expect(exact).toBe('134047193123456789')
    expect(calls[0]).toEqual([
      expect.stringMatching(/[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i),
      expect.arrayContaining([
        '-NoProfile', '-NonInteractive', '-Command',
        expect.stringMatching(/Get-Process -Id 4242[\s\S]*StartTime\.ToFileTimeUtc\(\)/),
      ]),
      expect.objectContaining({ windowsHide: true, encoding: 'utf8', timeout: 3_000 }),
    ])

    expect(() => checker.queryWindowsProcessStartTime100ns(4242, (() => ({
      stdout: '0134047193123456789', stderr: '', status: 0, signal: null,
    })) as never)).toThrow(/identity query failed/i)

    const checkerSource = readFileSync(join(ROOT, 'scripts', 'check-computer-use-package.mjs'), 'utf8')
    expect(checkerSource).not.toMatch(/(?:spawnSyncImpl|spawn)\s*\(\s*['"]powershell\.exe['"]/)

    const root = sourceFixture()
    const clientPath = join(root, 'electron', 'ai', 'computer', 'helper-client.ts')
    const client = readFileSync(clientPath, 'utf8')
    const afterSpawnMutation = client.replace(
      'const ownerStartTime100ns = requireCanonicalOwnerStartTime100ns(',
      "const childBeforeOwnerIdentity = this.spawnImpl(this.systemPowerShellPath!, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })\n    void childBeforeOwnerIdentity\n    const ownerStartTime100ns = requireCanonicalOwnerStartTime100ns(",
    )
    expect(afterSpawnMutation).not.toBe(client)
    writeFileSync(clientPath, afterSpawnMutation)
    const result = checker.checkComputerUsePackage({ root, sourceDir: fixture(root) })
    expect(result.failures)
      .toContain('desktop helper launch must pin exact owner creation FILETIME before spawn')

    const barePathRoot = sourceFixture()
    const barePathClient = join(barePathRoot, 'electron', 'ai', 'computer', 'helper-client.ts')
    writeFileSync(barePathClient, readFileSync(barePathClient, 'utf8')
      .replace('spawnSyncImpl(resolveSystemPowerShellPath(),', "spawnSyncImpl('powershell.exe',")
      .replace('this.spawnImpl(this.systemPowerShellPath,', "this.spawnImpl('powershell.exe',"))
    const barePathResult = checker.checkComputerUsePackage({ root: barePathRoot, sourceDir: fixture(barePathRoot) })
    expect(barePathResult.failures)
      .toContain('desktop helper launch must use pinned System32 PowerShell')
  })

  it('pins exact HWND destroy lifecycle and hung-observation Stop drain semantics', () => {
    const source = readFileSync(join(ROOT, 'resources', 'computer-use', 'helper.ps1'), 'utf8')
    expect(auditHelperLifecyclePins(source)).toEqual([])

    const reusedHwndMutation = source
      .replaceAll('IsDestroyedWindowInstance(actual)', 'false /* mutated: same identity reuse accepted */')
    expect(reusedHwndMutation).not.toBe(source)
    expect(auditHelperLifecyclePins(reusedHwndMutation))
      .toContain('exact HWND instance destroy lifecycle pin missing')

    const hwndOnlyMutation = source.replace(
      'DestroyedWindowInstances.ContainsKey(IdentityKey(identity))',
      'DestroyedWindowInstances.ContainsKey(identity.Hwnd.ToInt64().ToString())',
    )
    expect(hwndOnlyMutation).not.toBe(source)
    expect(auditHelperLifecyclePins(hwndOnlyMutation))
      .toContain('exact HWND instance destroy lifecycle pin missing')

    const collapsedIdentityMutation = source.replace(
      'identity.Pid + ":" + identity.Start + ":" + identity.Hwnd.ToInt64()',
      'identity.Hwnd.ToInt64().ToString()',
    )
    expect(collapsedIdentityMutation).not.toBe(source)
    expect(auditHelperLifecyclePins(collapsedIdentityMutation))
      .toContain('exact HWND instance destroy lifecycle pin missing')

    const delayedDestroyMutation = source.replace(
      'DrainForegroundEvents();\n            long destroyGeneration = WindowDestroyGeneration(expected.Hwnd);',
      '/* mutated: delayed EVENT_OBJECT_DESTROY not drained before identity read */\n            long destroyGeneration = WindowDestroyGeneration(expected.Hwnd);',
    )
    expect(delayedDestroyMutation).not.toBe(source)
    expect(auditHelperLifecyclePins(delayedDestroyMutation))
      .toContain('exact HWND instance destroy lifecycle pin missing')

    const concurrentBarrierMutation = source.replace(
      'lock (WinEventBarrierLock)',
      'if (true) /* mutated: shared AutoResetEvent ACK is not serialized */',
    )
    expect(concurrentBarrierMutation).not.toBe(source)
    expect(auditHelperLifecyclePins(concurrentBarrierMutation))
      .toContain('exact HWND instance destroy lifecycle pin missing')

    const resetDestroyRaceMutation = source.replace(
      'lock (WindowLifecycleLock)\n            {\n                // Serialize watch reset with EVENT_OBJECT_DESTROY registration.\n                // No barrier/wait is allowed under this lock.\n                if (!AdvanceWindowDestroyGeneration(hwnd)) return;',
      'if (!AdvanceWindowDestroyGeneration(hwnd)) return;\n            lock (WindowLifecycleLock)\n            {\n                /* mutated: destroy can race Clear/re-arm */',
    )
    expect(resetDestroyRaceMutation).not.toBe(source)
    expect(auditHelperLifecyclePins(resetDestroyRaceMutation))
      .toContain('exact HWND instance destroy lifecycle pin missing')

    const assignmentGapMutation = source.replace(
      'PendingProbeWindowInstance = expected;',
      '/* mutated: exact expected instance is not armed before ProbeExact */',
    )
    expect(assignmentGapMutation).not.toBe(source)
    expect(auditHelperLifecyclePins(assignmentGapMutation))
      .toContain('exact HWND instance destroy lifecycle pin missing')

    const deadlockingBarrierMutation = source.replace(
      'DrainForegroundEvents();\n            long bindDestroyGeneration;\n            string bindExpectedTitle = null;\n            string bindExpectedTitleFingerprint = null;\n            lock (WindowLifecycleLock)',
      'long bindDestroyGeneration;\n            string bindExpectedTitle = null;\n            string bindExpectedTitleFingerprint = null;\n            lock (WindowLifecycleLock)\n            {\n                DrainForegroundEvents();\n            }\n            lock (WindowLifecycleLock)',
    )
    expect(deadlockingBarrierMutation).not.toBe(source)
    expect(auditHelperLifecyclePins(deadlockingBarrierMutation))
      .toContain('exact HWND instance destroy lifecycle pin missing')

    const unboundedTombstoneMutation = source.replace(
      'while (DestroyedWindowInstances.Count > MaxDestroyedWindowTombstones)',
      'while (false /* mutated: tombstones grow forever */)',
    )
    expect(unboundedTombstoneMutation).not.toBe(source)
    expect(auditHelperLifecyclePins(unboundedTombstoneMutation))
      .toContain('exact HWND instance destroy lifecycle pin missing')

    const earlyObserveRemovalMutation = source.replace(
      'try { cancellation.Cancel(); } catch { }',
      'try { cancellation.Cancel(); } catch { }\n                CancellationTokenSource removed;\n                ActiveObservations.TryRemove(requestId, out removed);',
    )
    expect(earlyObserveRemovalMutation).not.toBe(source)
    expect(auditHelperLifecyclePins(earlyObserveRemovalMutation))
      .toContain('Stop does not retain and drain timed-out observation workers')

    const blindStopMutation = source
      .replaceAll('ActiveObservations.Count > 0 || ObservationQueue.CurrentCount == 0 || ', '')
    expect(blindStopMutation).not.toBe(source)
    expect(auditHelperLifecyclePins(blindStopMutation))
      .toContain('Stop does not retain and drain timed-out observation workers')

    const stopDropsSelectionMutation = source.replace(
      'CandidateLeases.Clear();\n                PendingProbeWindowInstance = null;\n            }\n            PreparedActions.Clear();',
      'CandidateLeases.Clear();\n                PendingProbeWindowInstance = null;\n                SelectedWindowInstance = null;\n            }\n            PreparedActions.Clear();',
    )
    expect(stopDropsSelectionMutation).not.toBe(source)
    expect(auditHelperLifecyclePins(stopDropsSelectionMutation))
      .toContain('Stop must preserve exact selected window while shutdown clears it')
  })

  it('pins fresh one-shot helper candidate leases across the private main-process boundary', () => {
    const helper = readFileSync(join(ROOT, 'resources', 'computer-use', 'helper.ps1'), 'utf8')
    const sources = {
      protocol: readFileSync(join(ROOT, 'electron', 'ai', 'computer', 'protocol.ts'), 'utf8'),
      types: readFileSync(join(ROOT, 'electron', 'ai', 'computer', 'types.ts'), 'utf8'),
      client: readFileSync(join(ROOT, 'electron', 'ai', 'computer', 'helper-client.ts'), 'utf8'),
      backend: readFileSync(join(ROOT, 'electron', 'ai', 'computer', 'helper-backend.ts'), 'utf8'),
      controller: readFileSync(join(ROOT, 'electron', 'ai', 'computer', 'controller.ts'), 'utf8'),
    }
    expect(checker.auditComputerCandidateLeaseSources({ helper, ...sources })).toEqual([])

    const clippedTitleDigestMutation = helper.replace(
      'return Hash("window-title|" + normalizedTitle);',
      'return Hash("window-title|" + DisplayWindowTitle(normalizedTitle));',
    )
    expect(clippedTitleDigestMutation).not.toBe(helper)
    expect(checker.auditComputerCandidateLeaseSources({ helper: clippedTitleDigestMutation, ...sources }))
      .toContain('complete bounded window title fingerprint contract missing')

    const droppedControllerTitleDigestMutation = {
      ...sources,
      controller: sources.controller.replace(
        '|| listed.candidate.titleFingerprint !== probe.titleFingerprint',
        '|| false /* mutated: full-title digest ignored at bind */',
      ),
    }
    expect(droppedControllerTitleDigestMutation.controller).not.toBe(sources.controller)
    expect(checker.auditComputerCandidateLeaseSources({ helper, ...droppedControllerTitleDigestMutation }))
      .toContain('complete bounded window title fingerprint contract missing')

    const armBeforePrefilterMutation = helper.replace(
      'if (!TryIdentity(hwnd, out prefilteredIdentity)',
      'if (false /* mutated: ineligible HWNDs consume lifecycle watches */',
    )
    expect(armBeforePrefilterMutation).not.toBe(helper)
    expect(checker.auditComputerCandidateLeaseSources({ helper: armBeforePrefilterMutation, ...sources }))
      .toContain('fresh one-shot bounded helper candidate lease lifecycle missing')

    const postArmIdentityMutation = helper.replace(
      '|| !SameIdentity(armedIdentity, prefilteredIdentity)',
      '|| false /* mutated: lifecycle arm has no authoritative identity recheck */',
    )
    expect(postArmIdentityMutation).not.toBe(helper)
    expect(checker.auditComputerCandidateLeaseSources({ helper: postArmIdentityMutation, ...sources }))
      .toContain('fresh one-shot bounded helper candidate lease lifecycle missing')

    const postArmTitleMutation = helper.replace(
      '|| !String.Equals(armedTitle, prefilteredTitle, StringComparison.Ordinal)',
      '|| false /* mutated: lifecycle arm has no authoritative title recheck */',
    )
    expect(postArmTitleMutation).not.toBe(helper)
    expect(checker.auditComputerCandidateLeaseSources({ helper: postArmTitleMutation, ...sources }))
      .toContain('fresh one-shot bounded helper candidate lease lifecycle missing')

    const postArmBlockedMutation = helper.replace(
      '|| IsBlockedApplication(armedIdentity, armedTitle)',
      '|| false /* mutated: lifecycle arm has no authoritative block recheck */',
    )
    expect(postArmBlockedMutation).not.toBe(helper)
    expect(checker.auditComputerCandidateLeaseSources({ helper: postArmBlockedMutation, ...sources }))
      .toContain('fresh one-shot bounded helper candidate lease lifecycle missing')

    const reusableTokenMutation = helper.replace(
      'CandidateLeases.TryRemove(candidateToken, out lease)',
      'CandidateLeases.TryGetValue(candidateToken, out lease)',
    )
    expect(reusableTokenMutation).not.toBe(helper)
    expect(checker.auditComputerCandidateLeaseSources({ helper: reusableTokenMutation, ...sources }))
      .toContain('fresh one-shot bounded helper candidate lease lifecycle missing')

    const destroyGapMutation = helper.replace(
      'InvalidateCandidateLeases(hwnd);',
      '/* mutated: listed candidate survives EVENT_OBJECT_DESTROY */',
    )
    expect(destroyGapMutation).not.toBe(helper)
    expect(checker.auditComputerCandidateLeaseSources({ helper: destroyGapMutation, ...sources }))
      .toContain('fresh one-shot bounded helper candidate lease lifecycle missing')

    const unrelatedDestroyGlobalMutation = helper.replace(
      'snapshot.DestroyGeneration != WindowDestroyGeneration(snapshot.Identity.Hwnd)',
      'snapshot.DestroyGeneration != TrackedWindowDestroyGenerations.Values.Max()',
    )
    expect(unrelatedDestroyGlobalMutation).not.toBe(helper)
    expect(checker.auditComputerCandidateLeaseSources({ helper: unrelatedDestroyGlobalMutation, ...sources }))
      .toContain('fresh one-shot bounded helper candidate lease lifecycle missing')

    const listedCandidateGenerationGapMutation = helper.replace(
      'if (snapshot.DestroyGeneration != WindowDestroyGeneration(snapshot.Identity.Hwnd)) continue;',
      '/* mutated: destroyed snapshot may receive a lease */',
    )
    expect(listedCandidateGenerationGapMutation).not.toBe(helper)
    expect(checker.auditComputerCandidateLeaseSources({ helper: listedCandidateGenerationGapMutation, ...sources }))
      .toContain('fresh one-shot bounded helper candidate lease lifecycle missing')

    const deterministicTokenMutation = helper.replace(
      'IdentityKey(actual) + ":" + Guid.NewGuid().ToString("N")',
      'IdentityKey(actual)',
    )
    expect(deterministicTokenMutation).not.toBe(helper)
    expect(checker.auditComputerCandidateLeaseSources({ helper: deterministicTokenMutation, ...sources }))
      .toContain('fresh one-shot bounded helper candidate lease lifecycle missing')

    const droppedMainTokenMutation = {
      ...sources,
      controller: sources.controller.replace(
        'deps.backend.probeBinding(listed.candidate.identity, listed.candidate.candidateToken)',
        'deps.backend.probeBinding(listed.candidate.identity)',
      ),
    }
    expect(droppedMainTokenMutation.controller).not.toBe(sources.controller)
    expect(checker.auditComputerCandidateLeaseSources({ helper, ...droppedMainTokenMutation }))
      .toContain('helper candidate lease crossed or was dropped at the main-process boundary')

    const stopDropsSelectionMutation = helper.replace(
      'CandidateLeases.Clear();\n                PendingProbeWindowInstance = null;\n            }\n            PreparedActions.Clear();',
      'CandidateLeases.Clear();\n                PendingProbeWindowInstance = null;\n                SelectedWindowInstance = null;\n            }\n            PreparedActions.Clear();',
    )
    expect(stopDropsSelectionMutation).not.toBe(helper)
    expect(checker.auditComputerCandidateLeaseSources({ helper: stopDropsSelectionMutation, ...sources }))
      .toContain('Stop must preserve exact selected window while shutdown clears it')

    const rendererLeakMutation = {
      ...sources,
      controller: sources.controller.replace(
        'candidateId,\n          processName:',
        'candidateId,\n          candidateToken: candidate.candidateToken,\n          processName:',
      ),
    }
    expect(rendererLeakMutation.controller).not.toBe(sources.controller)
    expect(checker.auditComputerCandidateLeaseSources({ helper, ...rendererLeakMutation }))
      .toContain('helper candidate lease crossed or was dropped at the main-process boundary')
  })

  it('blocks credential-labelled top-level titles and observation roots before disclosure', () => {
    const source = readFileSync(join(ROOT, 'resources', 'computer-use', 'helper.ps1'), 'utf8')
    expect(auditHelperCredentialSurfacePins(source)).toEqual([])

    const titleMutation = source.replace(
      'ContainsCredentialMarker(joined)',
      'false /* mutated: credential-bearing title exposed */',
    )
    expect(titleMutation).not.toBe(source)
    expect(auditHelperCredentialSurfacePins(titleMutation))
      .toContain('top-level title/root credential marker classification missing')

    const rootMutation = source.replace(
      'if (IsAuthenticationControl(root)) throw new SafeError("authentication_surface", "credential-labelled root surface blocked");',
      '/* mutated: root name disclosed without credential classification */',
    )
    expect(rootMutation).not.toBe(source)
    expect(auditHelperCredentialSurfacePins(rootMutation))
      .toContain('observe root credential surface guard missing')

    const markerMutation = source.replace('"access token",', '"ordinary label",')
    expect(markerMutation).not.toBe(source)
    expect(auditHelperCredentialSurfacePins(markerMutation))
      .toContain('top-level title/root credential marker classification missing')
  })
})
