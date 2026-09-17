param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$OwnerPid,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[1-9][0-9]*$')]
    [string]$OwnerStartTime100ns
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:ProtocolVersion = 1
$script:HelperVersion = '2.8.2'
$script:AppVersion = '2.8.2'

$helperSource = @'
using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace VerstakComputerUse
{
    public static class Helper
    {
        private const int ProtocolVersion = 1;
        private const string HelperVersion = "2.8.2";
        private const string AppVersion = "2.8.2";
        private const int MaxMessageBytes = 65536;
        private const int MaxCandidates = 128;
        private const int MaxCandidateLeases = 128;
        private const int MaxTrackedWindowLifecycles = MaxCandidateLeases + 2;
        private const int CandidateLeaseTtlSeconds = 30;
        private const int MaxElements = 300;
        private const int MaxPrepared = 32;
        private const int PreparedTtlSeconds = 30;
        private const int MaxTargetCheckIntervalMs = 50;
        private const int MaxUiaValueScalars = 32768;
        private const int MaxWindowTitleChars = 32767;
        private const int MaxWindowTitleDisplayChars = 300;
        private const int MaxSurfaceInspectionElements = 512;
        private const int BindingSurfaceInspectionTimeoutMs = 1500;
        private const int ObservationTimeoutMs = 1500;
        private const int MaxScreenshotBytes = 16384;
        private const int MaxScreenshotWidth = 512;
        private const int MaxScreenshotHeight = 384;
        private const int MaxScreenshotSourceDimension = 4096;
        private const long MaxScreenshotSourcePixels = 8388608;
        private const uint PrintWindowRenderFullContent = 2;
        private const int MaxDestroyedWindowTombstones = 256;
        private const uint ProcessQueryLimitedInformation = 0x1000;
        private const uint Synchronize = 0x00100000;
        private const uint Infinite = 0xffffffff;
        private const uint TokenQuery = 0x0008;
        private const int TokenElevation = 20;
        private const uint GaRoot = 2;
        private const uint InputMouse = 0;
        private const uint InputKeyboard = 1;
        private const uint KeyeventfKeyup = 0x0002;
        private const uint KeyeventfUnicode = 0x0004;
        private const uint MouseeventfMove = 0x0001;
        private const uint MouseeventfLeftdown = 0x0002;
        private const uint MouseeventfLeftup = 0x0004;
        private const uint MouseeventfWheel = 0x0800;
        private const uint MouseeventfAbsolute = 0x8000;
        private const uint MouseeventfVirtualdesk = 0x4000;
        private const uint DwmwaExtendedFrameBounds = 9;
        private const int WhKeyboardLl = 13;
        private const int WhMouseLl = 14;
        private const uint LlkhfInjected = 0x10;
        private const uint LlmhfInjected = 0x01;
        private const uint WmQuit = 0x0012;
        private const uint WmForegroundBarrier = 0x8001;
        private const uint EventSystemForeground = 0x0003;
        private const uint EventObjectDestroy = 0x8001;
        private const uint WineventOutOfContext = 0x0000;
        private const int ObjIdWindow = 0;
        private const int ChildIdSelf = 0;

        private static readonly string[] CredentialMarkers = {
            "api key", "api-key", "apikey", "access token", "client secret", "secret key", "private key",
            "authorization", "api ключ", "ключ api", "токен доступа", "секрет", "приватный ключ"
        };
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaxMessageBytes };
        private static readonly object OutputLock = new object();
        private static readonly object WinEventBarrierLock = new object();
        private static readonly object WindowLifecycleLock = new object();
        private static readonly ConcurrentDictionary<string, CandidateLease> CandidateLeases = new ConcurrentDictionary<string, CandidateLease>();
        private static readonly ConcurrentDictionary<long, long> TrackedWindowDestroyGenerations = new ConcurrentDictionary<long, long>();
        private static readonly ConcurrentDictionary<string, PreparedAction> PreparedActions = new ConcurrentDictionary<string, PreparedAction>();
        private static readonly ConcurrentDictionary<string, ElementEntry> Elements = new ConcurrentDictionary<string, ElementEntry>();
        private static readonly ConcurrentDictionary<string, CancellationTokenSource> ActiveActions = new ConcurrentDictionary<string, CancellationTokenSource>();
        private static readonly ConcurrentDictionary<string, CancellationTokenSource> ActiveObservations = new ConcurrentDictionary<string, CancellationTokenSource>();
        private static readonly ConcurrentDictionary<string, byte> DestroyedWindowInstances = new ConcurrentDictionary<string, byte>();
        private static readonly ConcurrentQueue<string> DestroyedWindowOrder = new ConcurrentQueue<string>();
        private static readonly ConcurrentDictionary<string, byte> SeenRequestIds = new ConcurrentDictionary<string, byte>();
        private static readonly ConcurrentQueue<string> SeenRequestOrder = new ConcurrentQueue<string>();
        private static readonly SemaphoreSlim InputQueue = new SemaphoreSlim(1, 1);
        private static readonly SemaphoreSlim ObservationQueue = new SemaphoreSlim(1, 1);
        private static readonly string Salt = Guid.NewGuid().ToString("N");
        private static readonly ManualResetEventSlim HookStartup = new ManualResetEventSlim(false);
        private static readonly AutoResetEvent ForegroundBarrierAck = new AutoResetEvent(false);
        private static volatile bool Running = true;
        private static volatile bool HooksReady;
        private static long ObservationVersion;
        private static long StopEpoch;
        private static long PhysicalInputEpoch;
        private static long ForegroundEventEpoch;
        private static int OwnerPid;
        private static IntPtr OwnerProcessHandle;
        private static uint HookThreadId;
        private static Thread HookThread;
        private static Thread OwnerWatchdogThread;
        private static IntPtr KeyboardHook;
        private static IntPtr MouseHook;
        private static IntPtr ForegroundHook;
        private static IntPtr DestroyHook;
        private static WindowIdentity SelectedWindowInstance;
        private static WindowIdentity PendingProbeWindowInstance;
        private static readonly LowLevelHookProc KeyboardCallback = KeyboardHookProc;
        private static readonly LowLevelHookProc MouseCallback = MouseHookProc;
        private static readonly WinEventProc ForegroundCallback = ForegroundEventProc;
        private static readonly WinEventProc DestroyCallback = DestroyEventProc;

        private sealed class CandidateLease
        {
            public WindowIdentity Identity;
            public long DestroyGeneration;
            public string Title;
            public string TitleFingerprint;
            public DateTime ExpiresUtc;
        }

        private sealed class CandidateSnapshot
        {
            public WindowIdentity Identity;
            public long DestroyGeneration;
            public string ProcessName;
            public string ProductName;
            public string TopLevelClassName;
            public string Title;
            public string TitleFingerprint;
            public bool Elevated;
            public bool ProtectedProcess;
            public bool SecureSurface;
        }

        private sealed class PreparedAction
        {
            public string PreparedId;
            public string AttemptId;
            public WindowIdentity Identity;
            public string Kind;
            public string Method;
            public string BackendRef;
            public int PointX;
            public int PointY;
            public bool HasPoint;
            public List<string> TextChunks;
            public string TransitionKind;
            public string ExpectedStateBefore;
            public string ExpectedStateAfter;
            public bool HasExpectedValueState;
            public string ExpectedValueFingerprint;
            public int ExpectedValueScalarLength;
            public bool HasExpectedAfterValueState;
            public string ExpectedAfterValueFingerprint;
            public int ExpectedAfterValueScalarLength;
            public bool HasExpectedScrollState;
            public double ExpectedHorizontalScrollPercent;
            public double ExpectedVerticalScrollPercent;
            public string Key;
            public int DeltaX;
            public int DeltaY;
            public WindowProbe Expected;
            public DateTime ExpiresUtc;
            public long PreparedStopEpoch;
            public long PreparedForegroundEpoch;
            public bool DispatchAccepted;
            public bool EffectMatched;
        }

        private sealed class ExecutionOutcome
        {
            public bool DispatchAccepted;
            public bool EffectMatched;
        }

        private sealed class ElementEntry
        {
            public string BackendRef;
            public WindowIdentity Identity;
            public AutomationElement Element;
            public bool IsPassword;
            public string Fingerprint;
            public DateTime ExpiresUtc;
        }

        private sealed class WindowIdentity
        {
            public int Pid;
            public string Start;
            public IntPtr Hwnd;
        }

        private sealed class WindowProbe
        {
            public WindowIdentity Identity;
            public string Title;
            public string TitleFingerprint;
            public RECT Geometry;
            public int Dpi;
            public bool Foreground;
            public bool ScreenLocked;
            public long UserInputEpoch;
            public bool Occluded;
            public bool HitTestOwnWindow;
            public bool Elevated;
            public bool ProtectedProcess;
            public bool SecureSurface;
        }

        private sealed class BoundedLine
        {
            public string Value;
            public bool Oversize;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT { public int X, Y; }

        [StructLayout(LayoutKind.Sequential)]
        private struct FILETIME { public uint LowDateTime, HighDateTime; }

        [StructLayout(LayoutKind.Sequential)]
        private struct TOKEN_ELEVATION { public int TokenIsElevated; }

        [StructLayout(LayoutKind.Sequential)]
        private struct KBDLLHOOKSTRUCT
        {
            public uint VkCode, ScanCode, Flags, Time;
            public UIntPtr DwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MSLLHOOKSTRUCT
        {
            public POINT Point;
            public uint MouseData, Flags, Time;
            public UIntPtr DwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MSG
        {
            public IntPtr Hwnd;
            public uint Message;
            public UIntPtr WParam;
            public IntPtr LParam;
            public uint Time;
            public POINT Point;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT
        {
            public uint Type;
            public InputUnion U;
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct InputUnion
        {
            [FieldOffset(0)] public MOUSEINPUT Mi;
            [FieldOffset(0)] public KEYBDINPUT Ki;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT
        {
            public int Dx, Dy;
            public uint MouseData, DwFlags, Time;
            public UIntPtr DwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT
        {
            public ushort WVk, WScan;
            public uint DwFlags, Time;
            public UIntPtr DwExtraInfo;
        }

        private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
        private delegate IntPtr LowLevelHookProc(int code, IntPtr wParam, IntPtr lParam);
        private delegate void WinEventProc(IntPtr hook, uint eventType, IntPtr hwnd, int objectId, int childId, uint eventThread, uint eventTime);

        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr hwnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint flags);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(POINT point);
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint desiredAccess);
        [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll")] private static extern bool SwitchDesktop(IntPtr desktop);
        [DllImport("user32.dll")] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int virtualKey);
        [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int hook, LowLevelHookProc callback, IntPtr module, uint threadId);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module, WinEventProc callback, uint processId, uint threadId, uint flags);
        [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
        [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] private static extern int GetMessage(out MSG message, IntPtr hwnd, uint min, uint max);
        [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint threadId, uint message, UIntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string moduleName);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int infoClass, out TOKEN_ELEVATION info, int length, out int returned);
        [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, uint attribute, out RECT rect, int size);

        public static void Run(int ownerPid, string ownerStartTime100ns)
        {
            if (ownerPid <= 0) throw new InvalidOperationException("owner PID required");
            if (!IsCanonicalUnsignedDecimal(ownerStartTime100ns)) throw new InvalidOperationException("owner process identity required");
            OwnerPid = ownerPid;
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            ValidateAuthenticationTokenBoundaryContract();
            StartOwnerWatchdog(ownerPid, ownerStartTime100ns);
            StartInputHooks();
            while (Running)
            {
                BoundedLine line = ReadBoundedLine(Console.In);
                if (line == null) break;
                if (line.Oversize) WriteError("none", "oversize", "message exceeds limit");
                else HandleLine(line.Value);
            }
            CancelAllObservations();
            CancelAllActions();
            StopInputHooks();
        }

        private static void HandleLine(string line)
        {
            string requestId = "none";
            try
            {
                if (Encoding.UTF8.GetByteCount(line) > MaxMessageBytes) throw new SafeError("oversize", "message exceeds limit");
                object parsed = Json.DeserializeObject(line);
                IDictionary<string, object> message = parsed as IDictionary<string, object>;
                if (message == null) throw new SafeError("malformed", "object required");
                requestId = RequiredString(message, "requestId", 160);
                if (!SeenRequestIds.TryAdd(requestId, 0)) throw new SafeError("duplicate_request", "requestId already used");
                SeenRequestOrder.Enqueue(requestId);
                while (SeenRequestIds.Count > 2048)
                {
                    string oldest;
                    byte ignored;
                    if (!SeenRequestOrder.TryDequeue(out oldest)) break;
                    SeenRequestIds.TryRemove(oldest, out ignored);
                }
                if (Convert.ToInt32(Required(message, "v"), CultureInfo.InvariantCulture) != ProtocolVersion) throw new SafeError("bad_version", "protocol version mismatch");
                string type = RequiredString(message, "type", 64);
                foreach (string forbidden in new[] { "shell", "exec", "script", "command", "powershell", "argv", "environment" })
                    if (message.ContainsKey(forbidden)) throw new SafeError("forbidden_field", "forbidden field");
                CleanupExpired();
                switch (type)
                {
                    case "hello": HandleHello(requestId, message); break;
                    case "ping": WriteOk(type, requestId, null); break;
                    case "list_candidates": HandleListCandidates(requestId); break;
                    case "probe_binding": HandleProbe(requestId, message); break;
                    case "observe": HandleObserve(requestId, message); break;
                    case "prepare_action": HandlePrepare(requestId, message); break;
                    case "commit_action": HandleCommit(requestId, message); break;
                    case "cancel": HandleCancel(requestId, message); break;
                    case "stop": HandleStop(requestId); break;
                    case "shutdown": HandleShutdown(requestId); break;
                    default: throw new SafeError("unknown_type", "unknown request type");
                }
            }
            catch (SafeError error) { WriteError(requestId, error.Code, error.Message); }
            catch { WriteError(requestId, "internal_error", "helper rejected request"); }
        }

        private static void HandleHello(string requestId, IDictionary<string, object> message)
        {
            int requestedProtocol = Convert.ToInt32(Required(message, "protocolVersion"), CultureInfo.InvariantCulture);
            object appValue;
            string requestedApp = message.TryGetValue("appVersion", out appValue) && appValue != null ? Convert.ToString(appValue, CultureInfo.InvariantCulture) : null;
            if (requestedProtocol != ProtocolVersion) throw new SafeError("bad_version", "protocol version mismatch");
            if (!String.IsNullOrEmpty(requestedApp) && requestedApp != AppVersion) throw new SafeError("bad_app_version", "app version mismatch");
            WriteOk("hello", requestId, new Dictionary<string, object> {
                { "protocolVersion", ProtocolVersion }, { "helperVersion", HelperVersion }, { "appVersion", AppVersion },
                { "inputMonitorReady", HooksReady }
            });
        }

        private static void HandleListCandidates(string requestId)
        {
            lock (WindowLifecycleLock)
            {
                CandidateLeases.Clear();
                ResetWindowLifecycleWatches();
            }
            DrainForegroundEvents();
            var snapshots = new List<CandidateSnapshot>();
            var candidates = new List<object>();
            Stopwatch listingTimer = Stopwatch.StartNew();
            EnumWindows(delegate(IntPtr hwnd, IntPtr ignored) {
                if (listingTimer.ElapsedMilliseconds > 2000) return false;
                if (snapshots.Count >= MaxCandidates || !IsWindowVisible(hwnd)) return true;
                WindowIdentity prefilteredIdentity;
                if (!TryIdentity(hwnd, out prefilteredIdentity)
                    || prefilteredIdentity.Pid == Process.GetCurrentProcess().Id
                    || prefilteredIdentity.Pid == OwnerPid) return true;
                string prefilteredTitle = NormalizeWindowTitle(WindowText(hwnd));
                if (String.IsNullOrWhiteSpace(prefilteredTitle)) return true;
                if (IsBlockedApplication(prefilteredIdentity, prefilteredTitle)) return true;

                long destroyGeneration;
                WindowIdentity armedIdentity;
                string armedTitle;
                lock (WindowLifecycleLock)
                {
                    if (!TryWatchWindowLifecycle(hwnd, out destroyGeneration)) return true;
                    if (!TryIdentity(hwnd, out armedIdentity)
                        || !SameIdentity(armedIdentity, prefilteredIdentity)
                        || armedIdentity.Pid == Process.GetCurrentProcess().Id
                        || armedIdentity.Pid == OwnerPid) return true;
                    armedTitle = NormalizeWindowTitle(WindowText(hwnd));
                    if (String.IsNullOrWhiteSpace(armedTitle)
                        || !String.Equals(armedTitle, prefilteredTitle, StringComparison.Ordinal)
                        || IsBlockedApplication(armedIdentity, armedTitle)) return true;
                }
                bool protectedProcess;
                bool elevated = IsElevated(armedIdentity.Pid, out protectedProcess);
                string processName = "unknown";
                try { processName = Process.GetProcessById(armedIdentity.Pid).ProcessName; } catch { protectedProcess = true; }
                string productName = ProcessProductName(armedIdentity.Pid);
                string topLevelClassName = WindowClass(armedIdentity.Hwnd);
                // Candidate discovery is read-only and globally bounded. Any
                // surface that cannot be classified inside the small budget is
                // omitted; exact probe/observe still run the deeper guard.
                bool secure = IsSecureSurface(armedIdentity.Hwnd, armedTitle, 64, 500);
                if (secure) return true;
                snapshots.Add(new CandidateSnapshot {
                    Identity = armedIdentity, DestroyGeneration = destroyGeneration,
                    ProcessName = SafeDisplay(processName, 120),
                    ProductName = SafeDisplay(productName, 160),
                    TopLevelClassName = SafeDisplay(topLevelClassName, 160),
                    Title = DisplayWindowTitle(armedTitle),
                    TitleFingerprint = WindowTitleFingerprint(armedTitle),
                    Elevated = elevated, ProtectedProcess = protectedProcess, SecureSurface = secure
                });
                return true;
            }, IntPtr.Zero);
            DrainForegroundEvents();
            lock (WindowLifecycleLock)
            {
                foreach (CandidateSnapshot snapshot in snapshots)
                {
                    if (CandidateLeases.Count >= MaxCandidateLeases) break;
                    if (snapshot.DestroyGeneration != WindowDestroyGeneration(snapshot.Identity.Hwnd)) continue;
                    WindowIdentity actual;
                    if (!TryIdentity(snapshot.Identity.Hwnd, out actual) || !SameIdentity(actual, snapshot.Identity)
                        || IsDestroyedWindowInstance(actual)) continue;
                    string candidateToken = Opaque("candidate-lease", IdentityKey(actual) + ":" + Guid.NewGuid().ToString("N"));
                    CandidateLeases[candidateToken] = new CandidateLease {
                        Identity = actual, DestroyGeneration = snapshot.DestroyGeneration,
                        Title = snapshot.Title, TitleFingerprint = snapshot.TitleFingerprint,
                        ExpiresUtc = DateTime.UtcNow.AddSeconds(CandidateLeaseTtlSeconds)
                    };
                    candidates.Add(new Dictionary<string, object> {
                        { "candidateToken", candidateToken }, { "identity", IdentityObject(actual) },
                        { "processName", snapshot.ProcessName }, { "title", snapshot.Title },
                        { "productName", snapshot.ProductName }, { "topLevelClassName", snapshot.TopLevelClassName },
                        { "titleFingerprint", snapshot.TitleFingerprint },
                        { "elevated", snapshot.Elevated }, { "protectedProcess", snapshot.ProtectedProcess },
                        { "secureSurface", snapshot.SecureSurface }
                    });
                }
            }
            WriteOk("list_candidates", requestId, new Dictionary<string, object> { { "candidates", candidates.ToArray() } });
        }

        private static void HandleProbe(string requestId, IDictionary<string, object> message)
        {
            WindowIdentity expected = ParseIdentity(RequiredDictionary(message, "identity"));
            object candidateTokenValue;
            bool hasCandidateToken = message.TryGetValue("candidateToken", out candidateTokenValue);
            string candidateToken = hasCandidateToken && candidateTokenValue != null
                ? Convert.ToString(candidateTokenValue, CultureInfo.InvariantCulture) : null;
            if (hasCandidateToken && !IsCandidateToken(candidateToken))
                throw new SafeError("bad_candidate_token", "fresh helper candidate token required");
            DrainForegroundEvents();
            long bindDestroyGeneration;
            string bindExpectedTitle = null;
            string bindExpectedTitleFingerprint = null;
            lock (WindowLifecycleLock)
            {
                if (hasCandidateToken)
                {
                    CandidateLease lease = ConsumeCandidateLease(candidateToken, expected);
                    bindDestroyGeneration = lease.DestroyGeneration;
                    bindExpectedTitle = lease.Title;
                    bindExpectedTitleFingerprint = lease.TitleFingerprint;
                }
                else if (SelectedWindowInstance == null || !SameIdentity(SelectedWindowInstance, expected))
                    throw new SafeError("candidate_token_required", "binding requires a fresh listed candidate token");
                else bindDestroyGeneration = WindowDestroyGeneration(expected.Hwnd);
                PendingProbeWindowInstance = expected;
            }
            try
            {
                WindowProbe probe = ProbeExact(
                    expected, true, MaxSurfaceInspectionElements, BindingSurfaceInspectionTimeoutMs);
                DrainForegroundEvents();
                lock (WindowLifecycleLock)
                {
                    if (bindDestroyGeneration != WindowDestroyGeneration(expected.Hwnd)
                        || IsDestroyedWindowInstance(probe.Identity))
                        throw new SafeError("target_destroyed", "selected HWND instance was destroyed during binding");
                    if (hasCandidateToken && (!String.Equals(bindExpectedTitle, probe.Title, StringComparison.Ordinal)
                        || !String.Equals(bindExpectedTitleFingerprint, probe.TitleFingerprint, StringComparison.Ordinal)))
                        throw new SafeError("target_title_changed", "selected window title changed during binding");
                    SelectedWindowInstance = probe.Identity;
                    PendingProbeWindowInstance = null;
                }
                WriteOk("probe_binding", requestId, new Dictionary<string, object> { { "probe", ProbeObject(probe) } });
            }
            finally
            {
                lock (WindowLifecycleLock)
                {
                    if (PendingProbeWindowInstance != null && SameIdentity(PendingProbeWindowInstance, expected))
                        PendingProbeWindowInstance = null;
                }
            }
        }

        private static void HandleObserve(string requestId, IDictionary<string, object> message)
        {
            WindowIdentity expected = ParseIdentity(RequiredDictionary(message, "identity"));
            var cancellation = new CancellationTokenSource();
            if (!ActiveObservations.TryAdd(requestId, cancellation)) throw new SafeError("observe_active", "observation already active");
            int responseSent = 0;
            Task.Run(delegate {
                bool queueHeld = false;
                try
                {
                    ObservationQueue.Wait(cancellation.Token);
                    queueHeld = true;
                    IDictionary<string, object> observation = ExecuteObserve(expected, cancellation.Token);
                    if (Interlocked.CompareExchange(ref responseSent, 1, 0) == 0)
                        WriteOk("observe", requestId, new Dictionary<string, object> { { "observation", observation } });
                }
                catch (OperationCanceledException)
                {
                    if (Interlocked.CompareExchange(ref responseSent, 1, 0) == 0)
                        WriteError(requestId, "observe_cancelled", "observation cancelled");
                }
                catch (SafeError error)
                {
                    if (Interlocked.CompareExchange(ref responseSent, 1, 0) == 0)
                        WriteError(requestId, error.Code, error.Message);
                }
                catch
                {
                    if (Interlocked.CompareExchange(ref responseSent, 1, 0) == 0)
                        WriteError(requestId, "observe_failed", "observation failed closed");
                }
                finally
                {
                    if (queueHeld) ObservationQueue.Release();
                    CancellationTokenSource removed;
                    ActiveObservations.TryRemove(requestId, out removed);
                    cancellation.Dispose();
                }
            });
            Task.Delay(ObservationTimeoutMs).ContinueWith(delegate {
                if (Interlocked.CompareExchange(ref responseSent, 1, 0) != 0) return;
                try { cancellation.Cancel(); } catch { }
                WriteError(requestId, "observe_timeout", "observation exceeded bounded deadline");
            });
        }

        private static IDictionary<string, object> ExecuteObserve(WindowIdentity expected, CancellationToken cancellation)
        {
            Stopwatch timer = Stopwatch.StartNew();
            RequireObservationBudget(cancellation, timer);
            WindowProbe probe = ProbeExact(expected, true);
            if (probe.ScreenLocked) throw new SafeError("screen_locked", "interactive desktop unavailable");
            AutomationElement root;
            try { root = AutomationElement.FromHandle(expected.Hwnd); }
            catch { throw new SafeError("uia_unavailable", "UI Automation root unavailable"); }
            if (root == null) throw new SafeError("uia_unavailable", "UI Automation root unavailable");
            try
            {
                if (root.Current.IsPassword) throw new SafeError("password_surface", "password surface blocked");
                if (IsAuthenticationControl(root)) throw new SafeError("authentication_surface", "credential-labelled root surface blocked");
            }
            catch (ElementNotAvailableException) { throw new SafeError("target_changed", "target changed"); }

            var observedElements = new Dictionary<string, ElementEntry>();
            var output = new List<object>();
            var omissions = new HashSet<string>();
            var aggregateText = new StringBuilder();
            int aggregateTextBytes = 0;
            long version = Interlocked.Increment(ref ObservationVersion);
            string observationId = Opaque("observation", IdentityKey(expected) + ":" + version.ToString(CultureInfo.InvariantCulture));
            TreeWalker walker = TreeWalker.ControlViewWalker;
            var pending = new Queue<AutomationElement>();
            AutomationElement first;
            try { first = walker.GetFirstChild(root); }
            catch { throw new SafeError("uia_unavailable", "UI Automation traversal failed"); }
            if (first != null) pending.Enqueue(first);
            int index = 0;
            while (pending.Count > 0)
            {
                RequireObservationBudget(cancellation, timer);
                if (index >= MaxElements) { omissions.Add("element-limit"); break; }
                AutomationElement element = pending.Dequeue();
                int elementIndex = index++;
                try
                {
                    if (element.Current.IsPassword) throw new SafeError("password_surface", "password descendant makes the whole surface unavailable");
                    if (IsAuthenticationControl(element)) throw new SafeError("authentication_surface", "login, CAPTCHA or 2FA surface blocked");
                    if (IsLaunchSurfaceControl(element)) throw new SafeError("launch_surface", "terminal, Run or address launch surface blocked");
                    AutomationElement child = walker.GetFirstChild(element);
                    if (child != null) pending.Enqueue(child);
                    AutomationElement sibling = walker.GetNextSibling(element);
                    if (sibling != null) pending.Enqueue(sibling);
                    if (element.Current.IsOffscreen || !element.Current.IsEnabled) continue;
                    string label = SafeDisplay(element.Current.Name, 300);
                    if (!String.IsNullOrWhiteSpace(label))
                    {
                        int labelBytes = Encoding.UTF8.GetByteCount(label) + 1;
                        if (aggregateTextBytes + labelBytes <= 16384)
                        {
                            if (aggregateText.Length > 0) aggregateText.Append('\n');
                            aggregateText.Append(label);
                            aggregateTextBytes += labelBytes;
                        }
                        else omissions.Add("text-limit");
                    }
                    var actions = SupportedActions(element);
                    if (actions.Count == 0) continue;
                    string fingerprint = CaptureElementFingerprint(element, expected);
                    string backendRef = Opaque("element", observationId + ":" + elementIndex.ToString(CultureInfo.InvariantCulture));
                    observedElements[backendRef] = new ElementEntry {
                        BackendRef = backendRef, Identity = expected, Element = element, IsPassword = false,
                        Fingerprint = fingerprint,
                        ExpiresUtc = DateTime.UtcNow.AddSeconds(PreparedTtlSeconds)
                    };
                    var bounds = element.Current.BoundingRectangle;
                    var item = new Dictionary<string, object> {
                        { "backendRef", backendRef },
                        { "semanticFingerprint", fingerprint },
                        { "role", SafeDisplay(element.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""), 80) },
                        { "label", label },
                        { "isPassword", false },
                        { "supportedActions", actions.ToArray() }
                    };
                    if (!bounds.IsEmpty && !Double.IsInfinity(bounds.Left) && !Double.IsNaN(bounds.Left))
                        item["bounds"] = GeometryObject((int)Math.Round(bounds.Left), (int)Math.Round(bounds.Top), (int)Math.Round(bounds.Width), (int)Math.Round(bounds.Height));
                    string state = SafeElementState(element);
                    if (!String.IsNullOrEmpty(state)) item["state"] = state;
                    item["valueState"] = ValueStateObject(element);
                    item["scrollState"] = ScrollStateObject(element);
                    output.Add(item);
                }
                catch (ElementNotAvailableException) { omissions.Add("stale-element-omitted"); }
                catch (UnauthorizedAccessException) { throw new SafeError("protected_surface", "inaccessible UI Automation descendant blocked"); }
            }
            RequireObservationBudget(cancellation, timer);
            WindowProbe finalProbe = ProbeExact(expected, true);
            RequireObservationBudget(cancellation, timer);
            if (finalProbe.ScreenLocked) throw new SafeError("screen_locked", "interactive desktop unavailable");
            if (!String.Equals(probe.Title, finalProbe.Title, StringComparison.Ordinal)
                || !String.Equals(probe.TitleFingerprint, finalProbe.TitleFingerprint, StringComparison.Ordinal)
                || !SameGeometry(probe.Geometry, finalProbe.Geometry) || probe.Dpi != finalProbe.Dpi)
                throw new SafeError("target_changed", "window title, geometry or DPI changed during observation");
            RequireObservationBudget(cancellation, timer);
            string screenshotDataUrl = CaptureExactWindowPng(expected, finalProbe, cancellation, timer);
            if (String.IsNullOrEmpty(screenshotDataUrl)) omissions.Add("screenshot-unavailable-or-not-foreground");
            RequireObservationBudget(cancellation, timer);
            Elements.Clear();
            foreach (var pair in observedElements) Elements[pair.Key] = pair.Value;
            var result = new Dictionary<string, object> {
                { "probe", ProbeObject(finalProbe) }, { "elements", output.ToArray() },
                { "omissions", omissions.ToArray() }, { "observationId", observationId },
                { "observationVersion", version }, { "text", aggregateText.ToString() }
            };
            if (!String.IsNullOrEmpty(screenshotDataUrl)) result["screenshotDataUrl"] = screenshotDataUrl;
            return result;
        }

        private static void RequireObservationBudget(CancellationToken cancellation, Stopwatch timer)
        {
            cancellation.ThrowIfCancellationRequested();
            if (timer.ElapsedMilliseconds > ObservationTimeoutMs)
                throw new SafeError("observe_timeout", "observation exceeded bounded deadline");
        }

        private static string CaptureExactWindowPng(
            WindowIdentity expected, WindowProbe probe, CancellationToken cancellation, Stopwatch timer)
        {
            cancellation.ThrowIfCancellationRequested();
            RequireObservationBudget(cancellation, timer);
            if (!SameIdentity(expected, probe.Identity)) throw new SafeError("target_changed", "visual target identity changed");
            if (!probe.Foreground) return null;
            if (probe.ScreenLocked || probe.Elevated || probe.ProtectedProcess || probe.SecureSurface)
                throw new SafeError("protected_surface", "visual capture blocked for unsafe surface");
            if (HasUnsafeSurfaceDescendant(expected.Hwnd, MaxSurfaceInspectionElements, MaxTargetCheckIntervalMs))
                throw new SafeError("protected_surface", "visual capture blocked for password, credential or launch surface");

            int sourceWidth = probe.Geometry.Right - probe.Geometry.Left;
            int sourceHeight = probe.Geometry.Bottom - probe.Geometry.Top;
            if (sourceWidth < 1 || sourceHeight < 1
                || sourceWidth > MaxScreenshotSourceDimension || sourceHeight > MaxScreenshotSourceDimension
                || (long)sourceWidth * sourceHeight > MaxScreenshotSourcePixels) return null;

            byte[] encoded = null;
            using (var source = new Bitmap(sourceWidth, sourceHeight, PixelFormat.Format24bppRgb))
            {
                cancellation.ThrowIfCancellationRequested();
                bool captured;
                using (Graphics graphics = Graphics.FromImage(source))
                {
                    IntPtr hdc = graphics.GetHdc();
                    try { captured = PrintWindow(expected.Hwnd, hdc, PrintWindowRenderFullContent); }
                    finally { graphics.ReleaseHdc(hdc); }
                }
                cancellation.ThrowIfCancellationRequested();
                RequireObservationBudget(cancellation, timer);
                if (!captured) return null;

                double scale = Math.Min(1.0, Math.Min(
                    (double)MaxScreenshotWidth / sourceWidth,
                    (double)MaxScreenshotHeight / sourceHeight));
                int targetWidth = Math.Max(1, (int)Math.Floor(sourceWidth * scale));
                int targetHeight = Math.Max(1, (int)Math.Floor(sourceHeight * scale));
                while (targetWidth >= 1 && targetHeight >= 1)
                {
                    cancellation.ThrowIfCancellationRequested();
                    RequireObservationBudget(cancellation, timer);
                    encoded = EncodeWindowPng(source, targetWidth, targetHeight);
                    if (encoded.Length <= MaxScreenshotBytes) break;
                    if (targetWidth == 1 && targetHeight == 1) { encoded = null; break; }
                    targetWidth = Math.Max(1, targetWidth / 2);
                    targetHeight = Math.Max(1, targetHeight / 2);
                }
            }
            cancellation.ThrowIfCancellationRequested();
            RequireObservationBudget(cancellation, timer);
            if (encoded == null || encoded.Length == 0 || encoded.Length > MaxScreenshotBytes) return null;

            WindowProbe after = ProbeExact(expected, true);
            cancellation.ThrowIfCancellationRequested();
            RequireObservationBudget(cancellation, timer);
            if (!SameIdentity(expected, after.Identity)
                || !after.Foreground || after.ScreenLocked || after.Elevated || after.ProtectedProcess || after.SecureSurface
                || !String.Equals(probe.Title, after.Title, StringComparison.Ordinal)
                || !String.Equals(probe.TitleFingerprint, after.TitleFingerprint, StringComparison.Ordinal)
                || !SameGeometry(probe.Geometry, after.Geometry) || probe.Dpi != after.Dpi)
                throw new SafeError("target_changed", "visual target changed during exact-window capture");
            return "data:image/png;base64," + Convert.ToBase64String(encoded);
        }

        private static byte[] EncodeWindowPng(Bitmap source, int width, int height)
        {
            using (var scaled = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            using (Graphics graphics = Graphics.FromImage(scaled))
            using (var stream = new MemoryStream())
            {
                graphics.CompositingMode = CompositingMode.SourceCopy;
                graphics.InterpolationMode = InterpolationMode.HighQualityBilinear;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                graphics.DrawImage(source, new Rectangle(0, 0, width, height));
                scaled.Save(stream, ImageFormat.Png);
                return stream.ToArray();
            }
        }

        private static void HandlePrepare(string requestId, IDictionary<string, object> message)
        {
            if (PreparedActions.Count >= MaxPrepared) throw new SafeError("prepared_limit", "too many prepared actions");
            string attemptId = RequiredString(message, "attemptId", 160);
            WindowIdentity identity = ParseIdentity(RequiredDictionary(message, "identity"));
            IDictionary<string, object> action = RequiredDictionary(message, "action");
            string kind = RequiredString(action, "kind", 32);
            if (!new[] { "click", "type", "key", "scroll" }.Contains(kind)) throw new SafeError("bad_action", "action kind blocked");
            if (kind == "type" && (action.ContainsKey("clearFirst") || message.ContainsKey("clearFirst")))
                throw new SafeError("clear_first_blocked", "type replacement is not available");
            var parsedTextChunks = new List<string>();
            object chunksValue;
            if (message.TryGetValue("textChunks", out chunksValue) && chunksValue is object[])
            {
                int totalBytes = 0;
                foreach (object value in (object[])chunksValue)
                {
                    string chunk = value as string;
                    if (String.IsNullOrEmpty(chunk) || UnicodeScalarCount(chunk) > 16)
                        throw new SafeError("bad_text_chunk", "text chunk must contain 1-16 Unicode scalars");
                    totalBytes += Encoding.UTF8.GetByteCount(chunk);
                    if (totalBytes > 32768) throw new SafeError("text_oversize", "text exceeds limit");
                    parsedTextChunks.Add(chunk);
                }
            }
            if (kind == "type" && parsedTextChunks.Count == 0)
                throw new SafeError("empty_text", "type requires non-empty text");
            WindowProbe expected = ParseExpected(RequiredDictionary(message, "expected"), identity);
            WindowProbe current = ProbeExact(identity, true);
            RequireExpected(expected, current, true);
            if (!HooksReady) throw new SafeError("input_monitor_unavailable", "physical input monitor unavailable");
            long prepareForegroundEpoch = Interlocked.Read(ref ForegroundEventEpoch);
            var prepared = new PreparedAction {
                PreparedId = Opaque("prepared", attemptId + ":" + Guid.NewGuid().ToString("N")),
                AttemptId = attemptId, Identity = identity, Kind = kind, Expected = expected,
                ExpiresUtc = DateTime.UtcNow.AddSeconds(PreparedTtlSeconds), PreparedStopEpoch = Interlocked.Read(ref StopEpoch),
                PreparedForegroundEpoch = prepareForegroundEpoch,
                TextChunks = parsedTextChunks, DeltaX = 0, DeltaY = 0
            };
            object resolvedValue;
            if (message.TryGetValue("resolvedElement", out resolvedValue) && resolvedValue is IDictionary<string, object>)
            {
                prepared.BackendRef = RequiredString((IDictionary<string, object>)resolvedValue, "backendRef", 200);
                ParseExpectedElementTransition((IDictionary<string, object>)resolvedValue, prepared);
                ParseExpectedValueState((IDictionary<string, object>)resolvedValue, prepared);
                ParseExpectedScrollState((IDictionary<string, object>)resolvedValue, prepared);
                ElementEntry entry;
                if (!Elements.TryGetValue(prepared.BackendRef, out entry) || entry.ExpiresUtc <= DateTime.UtcNow || !SameIdentity(entry.Identity, identity))
                    throw new SafeError("stale_element", "element reference expired or belongs to another target");
                RequireElementCurrent(entry);
                if (kind == "type") PrepareExpectedAfterValueState(prepared, entry);
            }
            if (kind == "type" && !prepared.HasExpectedValueState)
                throw new SafeError("expected_value_state_required", "type requires exact observed ValuePattern state");
            object pointValue;
            if (message.TryGetValue("fallbackPoint", out pointValue) && pointValue is IDictionary<string, object>)
            {
                var point = (IDictionary<string, object>)pointValue;
                prepared.PointX = Convert.ToInt32(Required(point, "x"), CultureInfo.InvariantCulture);
                prepared.PointY = Convert.ToInt32(Required(point, "y"), CultureInfo.InvariantCulture);
                prepared.HasPoint = true;
                if (!PointInside(current.Geometry, prepared.PointX, prepared.PointY)) throw new SafeError("point_outside", "fallback point outside exact window");
            }
            object keyValue;
            if (message.TryGetValue("key", out keyValue) && keyValue != null) prepared.Key = Convert.ToString(keyValue, CultureInfo.InvariantCulture);
            if (String.IsNullOrEmpty(prepared.Key) && action.ContainsKey("key")) prepared.Key = Convert.ToString(action["key"], CultureInfo.InvariantCulture);
            if (kind == "key" && !AllowedKey(prepared.Key)) throw new SafeError("key_blocked", "key is not allowlisted");
            object scrollValue;
            if (message.TryGetValue("scroll", out scrollValue) && scrollValue is IDictionary<string, object>)
            {
                var scroll = (IDictionary<string, object>)scrollValue;
                prepared.DeltaX = OptionalInt(scroll, "deltaX", 0, -1, 1);
                prepared.DeltaY = OptionalInt(scroll, "deltaY", 0, -1, 1);
            }
            else
            {
                prepared.DeltaX = OptionalInt(action, "deltaX", 0, -1, 1);
                prepared.DeltaY = OptionalInt(action, "deltaY", 0, -1, 1);
            }
            if (kind == "scroll" && prepared.DeltaX == 0 && prepared.DeltaY == 0)
                throw new SafeError("zero_scroll", "scroll requires a non-zero axis");
            if (kind == "scroll" && !prepared.HasPoint && String.IsNullOrEmpty(prepared.BackendRef))
            {
                prepared.PointX = current.Geometry.Left + (current.Geometry.Right - current.Geometry.Left) / 2;
                prepared.PointY = current.Geometry.Top + (current.Geometry.Bottom - current.Geometry.Top) / 2;
                prepared.HasPoint = true;
            }
            prepared.Method = ChooseMethod(prepared);
            if (kind == "scroll" && prepared.Method == "uia" && !prepared.HasExpectedScrollState)
                throw new SafeError("expected_scroll_state_required", "UIA scroll requires exact observed state");
            if (prepareForegroundEpoch != Interlocked.Read(ref ForegroundEventEpoch) || GetForegroundWindow() != identity.Hwnd)
                throw new SafeError("foreground_changed", "foreground changed during prepare");
            if (!PreparedActions.TryAdd(prepared.PreparedId, prepared)) throw new SafeError("prepare_failed", "could not reserve action");
            var prepareResponse = new Dictionary<string, object> {
                { "preparedId", prepared.PreparedId }, { "attemptId", prepared.AttemptId },
                { "method", prepared.Method }, { "identity", IdentityObject(prepared.Identity) },
                { "requiresHitTest", prepared.Method != "uia" }, { "targetCheckIntervalMs", 50 },
                { "chunkGuards", "backend-enforced" }
            };
            if (prepared.HasExpectedAfterValueState)
            {
                prepareResponse["expectedAfterValueState"] = new Dictionary<string, object> {
                    { "fingerprint", prepared.ExpectedAfterValueFingerprint },
                    { "scalarLength", prepared.ExpectedAfterValueScalarLength }
                };
            }
            WriteOk("prepare_action", requestId, prepareResponse);
        }

        private static void HandleCommit(string requestId, IDictionary<string, object> message)
        {
            string preparedId = RequiredString(message, "preparedId", 200);
            string attemptId = RequiredString(message, "attemptId", 160);
            PreparedAction prepared;
            if (!PreparedActions.TryRemove(preparedId, out prepared)) throw new SafeError("not_prepared", "prepared action missing or already used");
            if (prepared.AttemptId != attemptId || prepared.ExpiresUtc <= DateTime.UtcNow) throw new SafeError("stale_prepare", "prepared action expired or mismatched");
            if (prepared.PreparedStopEpoch != Interlocked.Read(ref StopEpoch)) throw new SafeError("stopped", "Stop invalidated prepared action");
            var cancellation = new CancellationTokenSource();
            if (!ActiveActions.TryAdd(attemptId, cancellation)) throw new SafeError("attempt_active", "attempt already active");
            Task.Run(delegate {
                bool effectStarted = false;
                try
                {
                    InputQueue.Wait(cancellation.Token);
                    try
                    {
                        WindowProbe before = ProbeExact(prepared.Identity, true);
                        RequireExpected(prepared.Expected, before, true);
                        effectStarted = true;
                        ExecutionOutcome outcome = ExecutePrepared(prepared, cancellation.Token);
                        cancellation.Token.ThrowIfCancellationRequested();
                        DrainForegroundEvents();
                        WindowProbe after = ProbeExact(prepared.Identity, false);
                        DrainForegroundEvents();
                        long postForegroundEpoch = Interlocked.Read(ref ForegroundEventEpoch);
                        bool matched = SameIdentity(prepared.Identity, after.Identity)
                            && SameGeometry(prepared.Expected.Geometry, after.Geometry)
                            && prepared.Expected.Dpi == after.Dpi
                            && prepared.Expected.UserInputEpoch == after.UserInputEpoch
                            && prepared.PreparedForegroundEpoch == postForegroundEpoch
                            && GetForegroundWindow() == prepared.Identity.Hwnd
                            && after.Foreground && !after.ScreenLocked
                            && !after.Elevated && !after.ProtectedProcess && !after.SecureSurface;
                        bool effectMatched = matched && outcome.EffectMatched;
                        string detail = !matched
                            ? "uncertain: post-action target check failed"
                            : effectMatched
                                ? "target-current; action-specific effect proven"
                                : outcome.DispatchAccepted
                                    ? "target-current; dispatch accepted; effect not independently proven"
                                    : "target-current; no effect dispatched";
                        var readback = ReadbackObject(prepared, after, matched, outcome.DispatchAccepted, effectMatched, detail);
                        WriteOk("commit_action", requestId, new Dictionary<string, object> { { "readback", readback } });
                    }
                    finally { InputQueue.Release(); }
                }
                catch (OperationCanceledException)
                {
                    if (effectStarted)
                        WriteOk("commit_action", requestId, new Dictionary<string, object> { { "readback", ReadbackObject(prepared, null, false, prepared.DispatchAccepted, false, "uncertain: stopped after dispatch began") } });
                    else WriteError(requestId, "cancelled_before_effect", "action cancelled before dispatch");
                }
                catch (SafeError error)
                {
                    if (effectStarted)
                        WriteOk("commit_action", requestId, new Dictionary<string, object> { { "readback", ReadbackObject(prepared, null, false, prepared.DispatchAccepted, false, "uncertain: target changed or safety interval exceeded after dispatch began") } });
                    else WriteError(requestId, error.Code, error.Message);
                }
                catch
                {
                    if (effectStarted)
                        WriteOk("commit_action", requestId, new Dictionary<string, object> { { "readback", ReadbackObject(prepared, null, false, prepared.DispatchAccepted, false, "uncertain: helper failure after dispatch began") } });
                    else WriteError(requestId, "action_failed", "action rejected before dispatch");
                }
                finally
                {
                    CancellationTokenSource removed;
                    ActiveActions.TryRemove(attemptId, out removed);
                    cancellation.Dispose();
                }
            });
        }

        private static void HandleCancel(string requestId, IDictionary<string, object> message)
        {
            string attemptId = RequiredString(message, "attemptId", 160);
            bool cancelled = false;
            foreach (var pair in PreparedActions.ToArray())
            {
                PreparedAction removed;
                if (pair.Value.AttemptId == attemptId && PreparedActions.TryRemove(pair.Key, out removed)) cancelled = true;
            }
            CancellationTokenSource active;
            if (ActiveActions.TryGetValue(attemptId, out active)) { active.Cancel(); cancelled = true; }
            WriteOk("cancel", requestId, new Dictionary<string, object> { { "cancelled", cancelled } });
        }

        private static void HandleStop(string requestId)
        {
            Interlocked.Increment(ref StopEpoch);
            lock (WindowLifecycleLock)
            {
                CandidateLeases.Clear();
                PendingProbeWindowInstance = null;
            }
            PreparedActions.Clear();
            CancelAllObservations();
            CancelAllActions();
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(450);
            while ((ActiveObservations.Count > 0 || ObservationQueue.CurrentCount == 0 || ActiveActions.Count > 0 || InputQueue.CurrentCount == 0) && DateTime.UtcNow < deadline) Thread.Sleep(5);
            if (ActiveObservations.Count > 0 || ObservationQueue.CurrentCount == 0 || ActiveActions.Count > 0 || InputQueue.CurrentCount == 0)
                WriteError(requestId, "stop_timeout", "active helper work did not drain");
            else WriteOk("stop", requestId, new Dictionary<string, object> { { "stopped", true } });
        }

        private static void HandleShutdown(string requestId)
        {
            Interlocked.Increment(ref StopEpoch);
            lock (WindowLifecycleLock)
            {
                CandidateLeases.Clear();
                PendingProbeWindowInstance = null;
                SelectedWindowInstance = null;
            }
            PreparedActions.Clear();
            CancelAllObservations();
            CancelAllActions();
            WriteOk("shutdown", requestId, null);
            Running = false;
        }

        private static ExecutionOutcome ExecutePrepared(PreparedAction action, CancellationToken cancellation)
        {
            ElementEntry entry = null;
            if (!String.IsNullOrEmpty(action.BackendRef))
            {
                if (!Elements.TryGetValue(action.BackendRef, out entry) || entry.ExpiresUtc <= DateTime.UtcNow || !SameIdentity(entry.Identity, action.Identity))
                    throw new SafeError("stale_element", "element changed before dispatch");
                RequireElementCurrent(entry);
            }
            long expectedInput = action.Expected.UserInputEpoch;
            RequireTimelyActionCurrent(action, expectedInput, cancellation);
            ExecutionOutcome outcome;
            if (action.Kind == "click") outcome = ExecuteClick(action, entry, ref expectedInput, cancellation);
            else if (action.Kind == "type") outcome = ExecuteType(action, entry, ref expectedInput, cancellation);
            else if (action.Kind == "key") outcome = ExecuteKey(action, entry, ref expectedInput, cancellation);
            else if (action.Kind == "scroll") outcome = ExecuteScroll(action, entry, ref expectedInput, cancellation);
            else throw new SafeError("bad_action", "action kind blocked");
            action.Expected.UserInputEpoch = expectedInput;
            action.DispatchAccepted = outcome.DispatchAccepted;
            action.EffectMatched = outcome.EffectMatched;
            return outcome;
        }

        private static ExecutionOutcome ExecuteClick(PreparedAction action, ElementEntry entry, ref long expectedInput, CancellationToken cancellation)
        {
            object pattern;
            if (entry != null && entry.Element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern))
            {
                TogglePattern toggle = (TogglePattern)pattern;
                RequireTimelyActionCurrent(action, expectedInput, cancellation);
                RequireElementCurrent(entry);
                ToggleState before = toggle.Current.ToggleState;
                RequireExpectedElementTransition(action, "toggle", SafeToggleState(before));
                Stopwatch timer = Stopwatch.StartNew();
                toggle.Toggle();
                action.DispatchAccepted = true;
                RequireDispatchWithinInterval(timer);
                ToggleState after = toggle.Current.ToggleState;
                return Outcome(true, MatchesExpectedElementTransition(action, "toggle", SafeToggleState(after)));
            }
            if (entry != null && entry.Element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
            {
                SelectionItemPattern selection = (SelectionItemPattern)pattern;
                RequireTimelyActionCurrent(action, expectedInput, cancellation);
                RequireElementCurrent(entry);
                bool before = selection.Current.IsSelected;
                RequireExpectedElementTransition(action, "selection", before ? "selected" : "not-selected");
                Stopwatch timer = Stopwatch.StartNew();
                selection.Select();
                action.DispatchAccepted = true;
                RequireDispatchWithinInterval(timer);
                bool after = selection.Current.IsSelected;
                return Outcome(true, MatchesExpectedElementTransition(action, "selection", after ? "selected" : "not-selected"));
            }
            POINT point = ActionPoint(action, entry);
            RequireTimelyActionCurrent(action, expectedInput, cancellation);
            RequireHitTest(action.Identity.Hwnd, point);
            Stopwatch clickTimer = Stopwatch.StartNew();
            SendMouseClick(action, entry, point);
            RequireDispatchWithinInterval(clickTimer);
            expectedInput = UserInputEpoch();
            return Outcome(true, false);
        }

        private static ExecutionOutcome ExecuteType(PreparedAction action, ElementEntry entry, ref long expectedInput, CancellationToken cancellation)
        {
            if (entry == null) throw new SafeError("element_required", "type requires exact UI Automation element");
            if (IsPassword(entry.Element)) throw new SafeError("password_control", "password control blocked");
            object pattern;
            if (action.Method == "uia")
            {
                if (!entry.Element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)
                    || !CanUseBoundedValuePattern(action, (ValuePattern)pattern))
                    throw new SafeError("stale_element", "bounded UI Automation value method changed");
                ValuePattern valuePattern = (ValuePattern)pattern;
                string beforeValue = "";
                string accumulated = "";
                bool firstChunk = true;
                foreach (string chunk in action.TextChunks)
                {
                    RequireTimelyActionCurrent(action, expectedInput, cancellation);
                    RequireElementCurrent(entry);
                    string currentValue = valuePattern.Current.Value ?? "";
                    if (firstChunk)
                    {
                        RequireExpectedValueState(action, currentValue);
                        beforeValue = currentValue;
                        accumulated = currentValue;
                        firstChunk = false;
                    }
                    else if (!String.Equals(currentValue, accumulated, StringComparison.Ordinal))
                        throw new SafeError("stale_value_state", "ValuePattern changed between chunks");
                    accumulated += chunk;
                    Stopwatch chunkTimer = Stopwatch.StartNew();
                    valuePattern.SetValue(accumulated);
                    action.DispatchAccepted = true;
                    RequireDispatchWithinInterval(chunkTimer);
                    cancellation.ThrowIfCancellationRequested();
                }
                if (firstChunk) throw new SafeError("empty_text", "type requires non-empty text");
                string afterValue = valuePattern.Current.Value;
                bool effectMatched = action.DispatchAccepted && beforeValue != accumulated && afterValue == accumulated
                    && MatchesExpectedAfterValueState(action, afterValue);
                action.EffectMatched = effectMatched;
                return Outcome(action.DispatchAccepted, effectMatched);
            }
            if (GetForegroundWindow() != action.Identity.Hwnd) throw new SafeError("focus_lost", "exact target is not foreground");
            entry.Element.SetFocus();
            POINT inputPoint = ActionPoint(action, entry);
            foreach (string chunk in action.TextChunks)
            {
                RequireTimelyActionCurrent(action, expectedInput, cancellation);
                Stopwatch chunkTimer = Stopwatch.StartNew();
                SendUnicode(action, entry, inputPoint, chunk);
                RequireDispatchWithinInterval(chunkTimer);
                expectedInput = UserInputEpoch();
                cancellation.ThrowIfCancellationRequested();
            }
            return Outcome(action.DispatchAccepted, false);
        }

        private static ExecutionOutcome ExecuteKey(PreparedAction action, ElementEntry entry, ref long expectedInput, CancellationToken cancellation)
        {
            if (GetForegroundWindow() != action.Identity.Hwnd) throw new SafeError("focus_lost", "exact target is not foreground");
            if (entry != null) entry.Element.SetFocus();
            POINT inputPoint = ActionPoint(action, entry);
            RequireTimelyActionCurrent(action, expectedInput, cancellation);
            RequireElementCurrent(entry);
            ushort key = VirtualKey(action.Key);
            Stopwatch keyTimer = Stopwatch.StartNew();
            SendKeyPress(action, entry, inputPoint, key);
            RequireDispatchWithinInterval(keyTimer);
            expectedInput = UserInputEpoch();
            return Outcome(true, false);
        }

        private static ExecutionOutcome ExecuteScroll(PreparedAction action, ElementEntry entry, ref long expectedInput, CancellationToken cancellation)
        {
            object pattern;
            if (entry != null && entry.Element.TryGetCurrentPattern(ScrollPattern.Pattern, out pattern))
            {
                ScrollPattern scroll = (ScrollPattern)pattern;
                ScrollAmount vertical = action.DeltaY > 0 ? ScrollAmount.SmallIncrement : action.DeltaY < 0 ? ScrollAmount.SmallDecrement : ScrollAmount.NoAmount;
                ScrollAmount horizontal = action.DeltaX > 0 ? ScrollAmount.SmallIncrement : action.DeltaX < 0 ? ScrollAmount.SmallDecrement : ScrollAmount.NoAmount;
                RequireTimelyActionCurrent(action, expectedInput, cancellation);
                RequireElementCurrent(entry);
                double beforeHorizontal = scroll.Current.HorizontalScrollPercent;
                double beforeVertical = scroll.Current.VerticalScrollPercent;
                RequireExpectedScrollState(action, beforeHorizontal, beforeVertical);
                Stopwatch scrollTimer = Stopwatch.StartNew();
                scroll.Scroll(horizontal, vertical);
                action.DispatchAccepted = true;
                RequireDispatchWithinInterval(scrollTimer);
                double afterHorizontal = scroll.Current.HorizontalScrollPercent;
                double afterVertical = scroll.Current.VerticalScrollPercent;
                bool requestedAnyAxis = action.DeltaX != 0 || action.DeltaY != 0;
                bool effectMatched = requestedAnyAxis
                    && ScrollDirectionMatched(action.DeltaX, beforeHorizontal, afterHorizontal)
                    && ScrollDirectionMatched(action.DeltaY, beforeVertical, afterVertical);
                action.EffectMatched = effectMatched;
                return Outcome(true, effectMatched);
            }
            POINT point = ActionPoint(action, entry);
            RequireTimelyActionCurrent(action, expectedInput, cancellation);
            RequireHitTest(action.Identity.Hwnd, point);
            Stopwatch wheelTimer = Stopwatch.StartNew();
            SendWheel(action, entry, point, -action.DeltaY);
            RequireDispatchWithinInterval(wheelTimer);
            expectedInput = UserInputEpoch();
            return Outcome(true, false);
        }

        private static ExecutionOutcome Outcome(bool dispatchAccepted, bool effectMatched)
        {
            return new ExecutionOutcome { DispatchAccepted = dispatchAccepted, EffectMatched = effectMatched };
        }

        private static void RequireTimelyActionCurrent(PreparedAction action, long expectedInput, CancellationToken cancellation)
        {
            Stopwatch timer = Stopwatch.StartNew();
            RequireActionCurrent(action, expectedInput, true, cancellation);
            if (timer.ElapsedMilliseconds > MaxTargetCheckIntervalMs)
                throw new SafeError("target_check_timeout", "target validation exceeded safety interval");
        }

        private static void RequireDispatchWithinInterval(Stopwatch timer)
        {
            if (timer.ElapsedMilliseconds > MaxTargetCheckIntervalMs)
                throw new SafeError("dispatch_interval_exceeded", "action chunk exceeded safety interval");
        }

        private static void RequireActionCurrent(PreparedAction action, long expectedInput, bool requireForeground, CancellationToken cancellation)
        {
            cancellation.ThrowIfCancellationRequested();
            if (action.PreparedStopEpoch != Interlocked.Read(ref StopEpoch)) throw new OperationCanceledException();
            if (action.PreparedForegroundEpoch != Interlocked.Read(ref ForegroundEventEpoch))
            {
                EmitEvent("focus-lost", action.Identity, "foreground changed after prepare");
                throw new SafeError("foreground_changed", "foreground changed after prepare");
            }
            WindowProbe current;
            try { current = ProbeExact(action.Identity, true); }
            catch (SafeError error)
            {
                if (error.Code == "target_destroyed" || error.Code == "target_changed") EmitEvent("target-destroyed", action.Identity, "exact target identity changed");
                throw;
            }
            if (!SameGeometry(action.Expected.Geometry, current.Geometry) || action.Expected.Dpi != current.Dpi)
            {
                EmitEvent("target-destroyed", action.Identity, "target geometry or DPI changed");
                throw new SafeError("target_changed", "window geometry or DPI changed");
            }
            if (!String.Equals(action.Expected.Title, current.Title, StringComparison.Ordinal)
                || !String.Equals(action.Expected.TitleFingerprint, current.TitleFingerprint, StringComparison.Ordinal))
                throw new SafeError("target_title_changed", "selected window title changed before dispatch");
            if (current.ScreenLocked)
            {
                EmitEvent("screen-locked", action.Identity, "interactive desktop unavailable");
                throw new SafeError("screen_locked", "interactive desktop unavailable");
            }
            if (requireForeground && !current.Foreground)
            {
                EmitEvent("focus-lost", action.Identity, "exact target is not foreground");
                throw new SafeError("focus_lost", "exact target is not foreground");
            }
            if (current.UserInputEpoch != expectedInput)
            {
                EmitEvent("hardware-input", action.Identity, "input epoch changed");
                throw new SafeError("hardware_input", "hardware input changed after observation");
            }
        }

        private static WindowProbe ProbeExact(WindowIdentity expected, bool blockUnsafe)
        {
            return ProbeExact(expected, blockUnsafe, MaxSurfaceInspectionElements, MaxTargetCheckIntervalMs);
        }

        private static WindowProbe ProbeExact(
            WindowIdentity expected, bool blockUnsafe, int surfaceMaxElements, int surfaceMaxMilliseconds)
        {
            DrainForegroundEvents();
            long destroyGeneration = WindowDestroyGeneration(expected.Hwnd);
            if (IsDestroyedWindowInstance(expected)) throw new SafeError("target_destroyed", "selected HWND instance was destroyed");
            if (!IsWindow(expected.Hwnd)) throw new SafeError("target_destroyed", "window no longer exists");
            WindowIdentity actual;
            if (!TryIdentity(expected.Hwnd, out actual) || !SameIdentity(actual, expected)) throw new SafeError("target_changed", "PID/start/HWND identity changed");
            DrainForegroundEvents();
            if (destroyGeneration != WindowDestroyGeneration(expected.Hwnd)) throw new SafeError("target_destroyed", "selected window lifecycle changed during identity read");
            if (IsDestroyedWindowInstance(actual)) throw new SafeError("target_destroyed", "selected HWND instance was destroyed");
            string title = NormalizeWindowTitle(WindowText(actual.Hwnd));
            if (String.IsNullOrWhiteSpace(title)) throw new SafeError("title_unavailable", "bounded window title unavailable");
            if (actual.Pid == OwnerPid || actual.Pid == Process.GetCurrentProcess().Id || IsBlockedApplication(actual, title))
                throw new SafeError("forbidden_target", "Verstak, terminal, shell or development surface blocked");
            bool protectedProcess;
            bool elevated = IsElevated(actual.Pid, out protectedProcess);
            bool secure = IsSecureSurface(actual.Hwnd, title, surfaceMaxElements, surfaceMaxMilliseconds);
            if (blockUnsafe && (protectedProcess || elevated || secure)) throw new SafeError("protected_target", "elevated, protected or secure surface blocked");
            RECT rect;
            if (DwmGetWindowAttribute(actual.Hwnd, DwmwaExtendedFrameBounds, out rect, Marshal.SizeOf(typeof(RECT))) != 0 && !GetWindowRect(actual.Hwnd, out rect))
                throw new SafeError("geometry_unavailable", "window geometry unavailable");
            int dpi = 96;
            try { uint value = GetDpiForWindow(actual.Hwnd); if (value > 0) dpi = (int)value; } catch { dpi = 96; }
            bool locked = IsScreenLocked();
            int centerX = rect.Left + Math.Max(0, rect.Right - rect.Left) / 2;
            int centerY = rect.Top + Math.Max(0, rect.Bottom - rect.Top) / 2;
            IntPtr hit = WindowFromPoint(new POINT { X = centerX, Y = centerY });
            IntPtr hitRoot = hit == IntPtr.Zero ? IntPtr.Zero : GetAncestor(hit, GaRoot);
            bool ownHit = hitRoot == actual.Hwnd;
            DrainForegroundEvents();
            if (destroyGeneration != WindowDestroyGeneration(expected.Hwnd)) throw new SafeError("target_destroyed", "selected window lifecycle changed during probe");
            if (IsDestroyedWindowInstance(actual)) throw new SafeError("target_destroyed", "selected HWND instance was destroyed");
            return new WindowProbe {
                Identity = actual, Title = DisplayWindowTitle(title), TitleFingerprint = WindowTitleFingerprint(title),
                Geometry = rect, Dpi = dpi,
                Foreground = GetForegroundWindow() == actual.Hwnd, ScreenLocked = locked,
                UserInputEpoch = UserInputEpoch(), HitTestOwnWindow = ownHit, Occluded = !ownHit,
                Elevated = elevated, ProtectedProcess = protectedProcess, SecureSurface = secure
            };
        }

        private static bool IsDestroyedWindowInstance(WindowIdentity identity)
        {
            return DestroyedWindowInstances.ContainsKey(IdentityKey(identity));
        }

        private static void RememberDestroyedWindowInstance(WindowIdentity identity)
        {
            string key = IdentityKey(identity);
            if (!DestroyedWindowInstances.TryAdd(key, 0)) return;
            DestroyedWindowOrder.Enqueue(key);
            while (DestroyedWindowInstances.Count > MaxDestroyedWindowTombstones)
            {
                string oldest;
                byte ignored;
                if (!DestroyedWindowOrder.TryDequeue(out oldest)) break;
                DestroyedWindowInstances.TryRemove(oldest, out ignored);
            }
        }

        private static bool TryIdentity(IntPtr hwnd, out WindowIdentity identity)
        {
            identity = null;
            uint pid;
            if (!IsWindow(hwnd) || GetWindowThreadProcessId(hwnd, out pid) == 0 || pid == 0) return false;
            IntPtr process = OpenProcess(ProcessQueryLimitedInformation, false, pid);
            if (process == IntPtr.Zero) return false;
            try
            {
                FILETIME creation, exit, kernel, user;
                if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) return false;
                identity = new WindowIdentity { Pid = (int)pid, Start = FileTime100ns(creation), Hwnd = hwnd };
                return true;
            }
            finally { CloseHandle(process); }
        }

        private static bool IsElevated(int pid, out bool protectedProcess)
        {
            protectedProcess = false;
            IntPtr process = OpenProcess(ProcessQueryLimitedInformation, false, (uint)pid);
            if (process == IntPtr.Zero) { protectedProcess = true; return false; }
            IntPtr token;
            try
            {
                if (!OpenProcessToken(process, TokenQuery, out token)) { protectedProcess = true; return false; }
                try
                {
                    TOKEN_ELEVATION elevation;
                    int returned;
                    if (!GetTokenInformation(token, TokenElevation, out elevation, Marshal.SizeOf(typeof(TOKEN_ELEVATION)), out returned)) { protectedProcess = true; return false; }
                    return elevation.TokenIsElevated != 0;
                }
                finally { CloseHandle(token); }
            }
            finally { CloseHandle(process); }
        }

        private static bool IsScreenLocked()
        {
            const uint desktopSwitchDesktop = 0x0100;
            IntPtr desktop = OpenInputDesktop(0, false, desktopSwitchDesktop);
            if (desktop == IntPtr.Zero) return true;
            try { return !SwitchDesktop(desktop); }
            finally { CloseDesktop(desktop); }
        }

        private static long UserInputEpoch()
        {
            return HooksReady ? Interlocked.Read(ref PhysicalInputEpoch) : -1L;
        }

        private static bool IsBlockedApplication(WindowIdentity identity, string title)
        {
            if (identity.Pid == OwnerPid || identity.Pid == Process.GetCurrentProcess().Id) return true;
            string processName = "";
            try { processName = Process.GetProcessById(identity.Pid).ProcessName.ToLowerInvariant(); }
            catch { return true; }
            string windowClass = WindowClass(identity.Hwnd).ToLowerInvariant();
            if (String.IsNullOrWhiteSpace(windowClass)) return true;
            string[] blockedProcesses = {
                "cmd", "conhost", "openconsole", "powershell", "pwsh", "windowsterminal", "wt", "mintty",
                "putty", "puttytel", "kitty", "wezterm", "wezterm-gui", "alacritty", "conemu", "conemu64",
                "hyper", "tabby", "fluentterminal", "wsl", "wslhost", "bash", "ubuntu", "debian", "kali",
                "code", "code-insiders", "cursor", "windsurf", "antigravity", "devenv", "idea64", "pycharm64",
                "webstorm64", "rider64", "clion64", "goland64", "phpstorm64", "rubymine64", "datagrip64",
                "studio64", "fleet", "explorer", "shellexperiencehost", "startmenuexperiencehost", "searchhost", "searchapp",
                "chrome", "chrome_proxy", "google-chrome", "msedge", "msedgewebview2", "firefox", "firefox-esr",
                "brave", "brave-browser", "opera", "opera_gx", "chromium", "chromium-browser", "vivaldi", "waterfox", "librewolf",
                "browser", "yandex", "yandexbrowser", "yabrowser", "arc", "arc-browser", "duckduckgo", "duckduckgobrowser",
                "zen", "zen-browser", "floorp", "systemsettings", "systemsettingsadminflows", "control", "controlpanel", "mmc", "secpol", "sechealthui"
            };
            if (blockedProcesses.Contains(processName)) return true;
            string[] blockedWindowClasses = { "chrome_widgetwin_", "mozillawindowclass", "operawindowclass" };
            if (blockedWindowClasses.Any(value => windowClass.StartsWith(value, StringComparison.Ordinal))) return true;
            string productName = ProcessProductName(identity.Pid).ToLowerInvariant();
            string[] blockedBrowserProducts = {
                "google chrome", "microsoft edge", "mozilla firefox", "brave", "opera", "chromium", "vivaldi",
                "waterfox", "librewolf", "yandex", "яндекс", "arc", "duckduckgo", "zen", "floorp"
            };
            if (productName.Contains("browser") || productName.Contains("браузер")
                || blockedBrowserProducts.Any(value => productName == value || productName.StartsWith(value + " ", StringComparison.Ordinal))) return true;
            string marker = (windowClass + " " + (title ?? "")).ToLowerInvariant();
            string[] blockedMarkers = {
                "consolewindowclass", "cascadia_hosting_window_class", "command prompt", "powershell",
                "windows terminal", "terminal", "cmd.exe", "pwsh", "mintty", "visual studio code",
                "putty", "wezterm", "alacritty", "conemu", "jetbrains", "intellij", "pycharm", "webstorm",
                "cursor", "windsurf", "antigravity", "developer tools", "devtools", "cabinetwclass",
                "explorewclass", "shell_traywnd", "program manager", "run dialog", "выполнить"
            };
            return blockedMarkers.Any(value => marker.Contains(value));
        }

        private static string ProcessProductName(int pid)
        {
            try
            {
                using (Process process = Process.GetProcessById(pid))
                {
                    ProcessModule module = process.MainModule;
                    if (module == null || String.IsNullOrWhiteSpace(module.FileName)) return "";
                    FileVersionInfo version = FileVersionInfo.GetVersionInfo(module.FileName);
                    return version == null ? "" : SafeDisplay(version.ProductName, 160);
                }
            }
            catch { return ""; }
        }

        private static string FileTime100ns(FILETIME value)
        {
            ulong exact = ((ulong)value.HighDateTime << 32) | value.LowDateTime;
            return exact.ToString(CultureInfo.InvariantCulture);
        }

        private static bool IsCanonicalUnsignedDecimal(string value)
        {
            if (String.IsNullOrEmpty(value) || value[0] == '0') return false;
            foreach (char digit in value) if (digit < '0' || digit > '9') return false;
            return true;
        }

        private static void StartOwnerWatchdog(int ownerPid, string ownerStartTime100ns)
        {
            if (ownerPid == Process.GetCurrentProcess().Id) throw new InvalidOperationException("helper cannot own itself");
            IntPtr owner = OpenProcess(ProcessQueryLimitedInformation | Synchronize, false, (uint)ownerPid);
            if (owner == IntPtr.Zero) throw new InvalidOperationException("owner process unavailable");
            FILETIME creation, exit, kernel, user;
            if (!GetProcessTimes(owner, out creation, out exit, out kernel, out user))
            {
                CloseHandle(owner);
                throw new InvalidOperationException("owner process identity unavailable");
            }
            string actualOwnerStartTime100ns = FileTime100ns(creation);
            if (!String.Equals(actualOwnerStartTime100ns, ownerStartTime100ns, StringComparison.Ordinal))
            {
                CloseHandle(owner);
                throw new InvalidOperationException("owner process identity changed");
            }
            OwnerProcessHandle = owner;
            OwnerWatchdogThread = new Thread(new ThreadStart(delegate {
                WaitForSingleObject(OwnerProcessHandle, Infinite);
                Interlocked.Increment(ref StopEpoch);
                PreparedActions.Clear();
                CancelAllObservations();
                CancelAllActions();
                Running = false;
                // Exact self-termination only; no target or owner process is killed.
                Process.GetCurrentProcess().Kill();
            }));
            OwnerWatchdogThread.IsBackground = true;
            OwnerWatchdogThread.Name = "VerstakComputerOwnerWatchdog";
            OwnerWatchdogThread.Start();
        }

        private static void StartInputHooks()
        {
            HookThread = new Thread(new ThreadStart(delegate {
                HookThreadId = GetCurrentThreadId();
                IntPtr module = GetModuleHandle(null);
                KeyboardHook = SetWindowsHookEx(WhKeyboardLl, KeyboardCallback, module, 0);
                MouseHook = SetWindowsHookEx(WhMouseLl, MouseCallback, module, 0);
                ForegroundHook = SetWinEventHook(EventSystemForeground, EventSystemForeground, IntPtr.Zero, ForegroundCallback, 0, 0, WineventOutOfContext);
                DestroyHook = SetWinEventHook(EventObjectDestroy, EventObjectDestroy, IntPtr.Zero, DestroyCallback, 0, 0, WineventOutOfContext);
                HooksReady = KeyboardHook != IntPtr.Zero && MouseHook != IntPtr.Zero && ForegroundHook != IntPtr.Zero && DestroyHook != IntPtr.Zero;
                HookStartup.Set();
                if (HooksReady)
                {
                    MSG message;
                    while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
                    {
                        if (message.Message == WmForegroundBarrier) ForegroundBarrierAck.Set();
                    }
                }
                if (KeyboardHook != IntPtr.Zero) { UnhookWindowsHookEx(KeyboardHook); KeyboardHook = IntPtr.Zero; }
                if (MouseHook != IntPtr.Zero) { UnhookWindowsHookEx(MouseHook); MouseHook = IntPtr.Zero; }
                if (ForegroundHook != IntPtr.Zero) { UnhookWinEvent(ForegroundHook); ForegroundHook = IntPtr.Zero; }
                if (DestroyHook != IntPtr.Zero) { UnhookWinEvent(DestroyHook); DestroyHook = IntPtr.Zero; }
                HooksReady = false;
            }));
            HookThread.IsBackground = true;
            HookThread.Name = "VerstakComputerInputMonitor";
            HookThread.Start();
            if (!HookStartup.Wait(2000) || !HooksReady) HooksReady = false;
        }

        private static void StopInputHooks()
        {
            uint threadId = HookThreadId;
            if (threadId != 0) PostThreadMessage(threadId, WmQuit, UIntPtr.Zero, IntPtr.Zero);
            try { if (HookThread != null && HookThread.IsAlive) HookThread.Join(500); } catch { }
            HooksReady = false;
        }

        private static IntPtr KeyboardHookProc(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0)
            {
                KBDLLHOOKSTRUCT data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                if ((data.Flags & LlkhfInjected) == 0) Interlocked.Increment(ref PhysicalInputEpoch);
            }
            return CallNextHookEx(KeyboardHook, code, wParam, lParam);
        }

        private static IntPtr MouseHookProc(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0)
            {
                MSLLHOOKSTRUCT data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                if ((data.Flags & LlmhfInjected) == 0) Interlocked.Increment(ref PhysicalInputEpoch);
            }
            return CallNextHookEx(MouseHook, code, wParam, lParam);
        }

        private static void ForegroundEventProc(IntPtr hook, uint eventType, IntPtr hwnd, int objectId, int childId, uint eventThread, uint eventTime)
        {
            if (eventType == EventSystemForeground) Interlocked.Increment(ref ForegroundEventEpoch);
        }

        private static void DestroyEventProc(IntPtr hook, uint eventType, IntPtr hwnd, int objectId, int childId, uint eventThread, uint eventTime)
        {
            if (eventType != EventObjectDestroy || hwnd == IntPtr.Zero || objectId != ObjIdWindow || childId != ChildIdSelf) return;
            WindowIdentity destroyed = null;
            lock (WindowLifecycleLock)
            {
                // Serialize watch reset with EVENT_OBJECT_DESTROY registration.
                // No barrier/wait is allowed under this lock.
                if (!AdvanceWindowDestroyGeneration(hwnd)) return;
                InvalidateCandidateLeases(hwnd);
                WindowIdentity selected = SelectedWindowInstance;
                if (selected == null || selected.Hwnd != hwnd)
                {
                    WindowIdentity pending = PendingProbeWindowInstance;
                    if (pending == null || pending.Hwnd != hwnd) return;
                    destroyed = pending;
                    PendingProbeWindowInstance = null;
                }
                else
                {
                    destroyed = selected;
                    SelectedWindowInstance = null;
                }
            }
            RememberDestroyedWindowInstance(destroyed);
            Interlocked.Increment(ref StopEpoch);
            PreparedActions.Clear();
            CancelAllObservations();
            CancelAllActions();
            EmitEvent("target-destroyed", destroyed, "exact selected HWND instance was destroyed");
        }

        private static CandidateLease ConsumeCandidateLease(string candidateToken, WindowIdentity expected)
        {
            CandidateLease lease;
            if (!CandidateLeases.TryRemove(candidateToken, out lease)
                || lease.ExpiresUtc <= DateTime.UtcNow
                || !SameIdentity(lease.Identity, expected)
                || lease.DestroyGeneration != WindowDestroyGeneration(expected.Hwnd))
                throw new SafeError("candidate_stale", "candidate lease is missing, expired, consumed or changed");
            return lease;
        }

        private static void InvalidateCandidateLeases(IntPtr hwnd)
        {
            foreach (var pair in CandidateLeases.ToArray())
            {
                CandidateLease ignored;
                if (pair.Value.Identity.Hwnd == hwnd) CandidateLeases.TryRemove(pair.Key, out ignored);
            }
        }

        private static void ResetWindowLifecycleWatches()
        {
            WindowIdentity selected = SelectedWindowInstance;
            WindowIdentity pending = PendingProbeWindowInstance;
            TrackedWindowDestroyGenerations.Clear();
            long ignored;
            if (selected != null) TryWatchWindowLifecycle(selected.Hwnd, out ignored);
            if (pending != null) TryWatchWindowLifecycle(pending.Hwnd, out ignored);
        }

        private static bool TryWatchWindowLifecycle(IntPtr hwnd, out long generation)
        {
            long key = hwnd.ToInt64();
            if (TrackedWindowDestroyGenerations.TryGetValue(key, out generation)) return true;
            if (TrackedWindowDestroyGenerations.Count >= MaxTrackedWindowLifecycles)
            {
                generation = -1;
                return false;
            }
            if (TrackedWindowDestroyGenerations.TryAdd(key, 0))
            {
                generation = 0;
                return true;
            }
            return TrackedWindowDestroyGenerations.TryGetValue(key, out generation);
        }

        private static long WindowDestroyGeneration(IntPtr hwnd)
        {
            long generation;
            if (!TrackedWindowDestroyGenerations.TryGetValue(hwnd.ToInt64(), out generation))
                throw new SafeError("target_destroyed", "exact window lifecycle is not tracked");
            return generation;
        }

        private static bool AdvanceWindowDestroyGeneration(IntPtr hwnd)
        {
            long key = hwnd.ToInt64();
            long generation;
            while (TrackedWindowDestroyGenerations.TryGetValue(key, out generation))
            {
                if (TrackedWindowDestroyGenerations.TryUpdate(key, generation + 1, generation)) return true;
            }
            return false;
        }

        private static bool IsCandidateToken(string value)
        {
            return value != null && value.Length == 40 && value.StartsWith("candidate-lease:", StringComparison.Ordinal)
                && value.Substring(16).All(character => character >= '0' && character <= '9' || character >= 'a' && character <= 'f');
        }

        private static bool IsSecureSurface(IntPtr hwnd, string title)
        {
            return IsSecureSurface(hwnd, title, MaxSurfaceInspectionElements, MaxTargetCheckIntervalMs);
        }

        private static bool IsSecureSurface(IntPtr hwnd, string title, int maxElements, int maxMilliseconds)
        {
            string className = WindowClass(hwnd);
            string joined = (className + " " + title).ToLowerInvariant();
            if (ContainsCredentialMarker(joined)
                || ContainsStandaloneOtpOrPin(joined)
                || joined.Contains("credential dialog") || joined.Contains("logonui") || joined.Contains("consentui")
                || joined.Contains("windows security") || joined.Contains("user account control")
                || joined.Contains("captcha") || joined.Contains("two-factor") || joined.Contains("two factor")
                || joined.Contains("verify you are human") || joined.Contains("human verification")
                || joined.Contains("security check") || joined.Contains("challenge") || joined.Contains("turnstile")
                || joined.Contains("just a moment") || joined.Contains("подтвердите, что вы человек")
                || joined.Contains("проверка безопасности") || joined.Contains("i'm not a robot")
                || joined.Contains("i am not a robot") || joined.Contains("not a robot")
                || joined.Contains("are you a robot") || joined.Contains("я не робот")
                || joined.Contains("i am human") || joined.Contains("i'm human") || joined.Contains("я человек")
                || joined.Contains("otp code") || joined.Contains("totp") || joined.Contains("mfa")
                || joined.Contains("one-time password") || joined.Contains("one time password")
                || joined.Contains("verification pin") || joined.Contains("6-digit code") || joined.Contains("6 digit code")
                || joined.Contains("two-step verification") || joined.Contains("two step verification")
                || joined.Contains("authenticator code") || joined.Contains("код аутентификатора")
                || joined.Contains("двухэтап") || joined.Contains("код из приложения")
                || joined.Contains("verification code") || joined.Contains("sign in") || joined.Contains("sign-in")
                || joined.Contains("log in") || joined.Contains("login") || joined.Contains("authentication")
                || joined.Contains("капча") || joined.Contains("код подтверждения") || joined.Contains("авторизац")
                || joined.Contains("вход в") || joined.Contains("войти")) return true;
            return HasUnsafeSurfaceDescendant(hwnd, maxElements, maxMilliseconds);
        }

        private static bool IsPassword(AutomationElement element)
        {
            try { return element == null || element.Current.IsPassword; }
            catch { return true; }
        }

        private static string CaptureElementFingerprint(AutomationElement element, WindowIdentity identity)
        {
            try
            {
                if (element == null) throw new SafeError("stale_element", "UI Automation element unavailable");
                AutomationElement root = AutomationElement.FromHandle(identity.Hwnd);
                if (root == null) throw new SafeError("stale_element", "UI Automation root unavailable");
                TreeWalker walker = TreeWalker.ControlViewWalker;
                var path = new List<string>();
                AutomationElement current = element;
                bool reachedRoot = false;
                for (int depth = 0; depth < 64 && current != null; depth++)
                {
                    int[] runtimeId = current.GetRuntimeId();
                    string runtime = runtimeId == null ? "runtime-missing" : String.Join(",", runtimeId.Select(value => value.ToString(CultureInfo.InvariantCulture)).ToArray());
                    ControlType controlType = current.Current.ControlType;
                    var bounds = current.Current.BoundingRectangle;
                    string segment = runtime + "|" + (controlType == null ? "control-missing" : controlType.Id.ToString(CultureInfo.InvariantCulture))
                        + "|" + FingerprintPart(current.Current.AutomationId) + "|" + FingerprintPart(current.Current.Name)
                        + "|" + FingerprintPart(current.Current.ClassName) + "|" + current.Current.NativeWindowHandle.ToString(CultureInfo.InvariantCulture)
                        + "|" + Math.Round(bounds.Left).ToString(CultureInfo.InvariantCulture) + "," + Math.Round(bounds.Top).ToString(CultureInfo.InvariantCulture)
                        + "," + Math.Round(bounds.Width).ToString(CultureInfo.InvariantCulture) + "," + Math.Round(bounds.Height).ToString(CultureInfo.InvariantCulture)
                        + (depth == 0 ? "|" + ElementPatternSignature(current) : "");
                    path.Add(Hash(segment));
                    if (Automation.Compare(current, root)) { reachedRoot = true; break; }
                    current = walker.GetParent(current);
                }
                if (!reachedRoot) throw new SafeError("stale_element", "UI Automation element is no longer under exact window root");
                return Hash("element-fingerprint|" + IdentityKey(identity) + "|" + String.Join(">", path.ToArray()));
            }
            catch (SafeError) { throw; }
            catch { throw new SafeError("stale_element", "UI Automation element fingerprint unavailable"); }
        }

        private static string FingerprintPart(string value)
        {
            if (String.IsNullOrEmpty(value)) return "";
            return value.Length <= 512 ? value : value.Substring(0, 512);
        }

        private static string ElementPatternSignature(AutomationElement element)
        {
            object pattern;
            bool invoke = element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern);
            bool toggle = element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern);
            bool selection = element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern);
            bool scroll = element.TryGetCurrentPattern(ScrollPattern.Pattern, out pattern);
            bool writableValue = false;
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
            {
                try { writableValue = !((ValuePattern)pattern).Current.IsReadOnly; }
                catch { throw new SafeError("stale_element", "UI Automation value pattern unavailable"); }
            }
            return (invoke ? "i" : "-") + (toggle ? "t" : "-") + (selection ? "s" : "-")
                + (writableValue ? "v" : "-") + (scroll ? "r" : "-");
        }

        private static void RequireElementCurrent(ElementEntry entry)
        {
            if (entry == null) return;
            Stopwatch timer = Stopwatch.StartNew();
            if (entry.ExpiresUtc <= DateTime.UtcNow || entry.IsPassword || IsPassword(entry.Element)
                || IsAuthenticationControl(entry.Element) || IsLaunchSurfaceControl(entry.Element))
                throw new SafeError("stale_element", "UI Automation element became unsafe or expired");
            string current = CaptureElementFingerprint(entry.Element, entry.Identity);
            if (!String.Equals(entry.Fingerprint, current, StringComparison.Ordinal))
                throw new SafeError("stale_element", "UI Automation element semantic identity changed");
            if (timer.ElapsedMilliseconds > MaxTargetCheckIntervalMs)
                throw new SafeError("element_check_timeout", "UI Automation element validation exceeded safety interval");
        }

        private static bool IsAuthenticationControl(AutomationElement element)
        {
            try
            {
                string marker = ((element.Current.Name ?? "") + " "
                    + (element.Current.AutomationId ?? "") + " "
                    + (element.Current.ClassName ?? "")).ToLowerInvariant();
                string[] blocked = {
                    "captcha", "recaptcha", "hcaptcha", "two-factor", "two factor", "2fa",
                    "verify you are human", "human verification", "security check", "challenge", "turnstile",
                    "just a moment", "подтвердите, что вы человек", "проверка безопасности",
                    "i'm not a robot", "i am not a robot", "not a robot", "are you a robot", "я не робот",
                    "i am human", "i'm human", "я человек",
                    "otp code", "totp", "mfa", "two-step verification", "two step verification",
                    "one-time password", "one time password", "verification pin", "6-digit code", "6 digit code",
                    "authenticator code", "код аутентификатора", "двухэтап",
                    "код из приложения",
                    "one-time code", "one time code", "verification code", "security code", "passcode", "password",
                    "sign in", "sign-in", "signin", "log in", "login", "username", "user name", "authentication",
                    "капча", "пароль", "код подтверждения", "одноразовый код", "двухфактор", "авторизац",
                    "имя пользователя", "логин", "войти", "вход в"
                };
                return ContainsCredentialMarker(marker)
                    || ContainsStandaloneOtpOrPin(marker)
                    || blocked.Any(value => marker.Contains(value));
            }
            catch { return true; }
        }

        private static bool ContainsStandaloneOtpOrPin(string value)
        {
            return ContainsUnicodeToken(value, "otp") || ContainsUnicodeToken(value, "пин");
        }

        private static bool ContainsUnicodeToken(string value, string token)
        {
            if (String.IsNullOrEmpty(value) || String.IsNullOrEmpty(token)) return false;
            int from = 0;
            while (from <= value.Length - token.Length)
            {
                int match = value.IndexOf(token, from, StringComparison.OrdinalIgnoreCase);
                if (match < 0) return false;
                int after = match + token.Length;
                if (!IsUnicodeLetterOrDigitBefore(value, match) && !IsUnicodeLetterOrDigitAt(value, after)) return true;
                from = match + token.Length;
            }
            return false;
        }

        private static bool IsUnicodeLetterOrDigitBefore(string value, int index)
        {
            int previous = index - 1;
            if (previous < 0) return false;
            if (Char.IsLowSurrogate(value[previous]) && previous > 0 && Char.IsHighSurrogate(value[previous - 1])) previous--;
            return Char.IsLetterOrDigit(value, previous);
        }

        private static bool IsUnicodeLetterOrDigitAt(string value, int index)
        {
            return index >= 0 && index < value.Length && Char.IsLetterOrDigit(value, index);
        }

        private static void ValidateAuthenticationTokenBoundaryContract()
        {
            string[] blockedFixtures = { "otp", "OTP code", "otp_input", "пин", "ПИН-код", "field_пин" };
            foreach (string fixture in blockedFixtures)
                if (!ContainsStandaloneOtpOrPin(fixture)) throw new InvalidOperationException("authentication marker contract unavailable");
            string[] allowedFixtures = { "Спинка", "Пинтерест", "prototype", "desktop" };
            foreach (string fixture in allowedFixtures)
                if (ContainsStandaloneOtpOrPin(fixture)) throw new InvalidOperationException("authentication marker contract unavailable");
        }

        private static bool ContainsCredentialMarker(string marker)
        {
            return CredentialMarkers.Any(value => marker.Contains(value));
        }

        private static bool IsLaunchSurfaceControl(AutomationElement element)
        {
            try
            {
                string name = (element.Current.Name ?? "").Trim().ToLowerInvariant();
                string automationId = (element.Current.AutomationId ?? "").ToLowerInvariant();
                string className = (element.Current.ClassName ?? "").ToLowerInvariant();
                string role = element.Current.ControlType == null ? "" : element.Current.ControlType.ProgrammaticName.ToLowerInvariant();
                string joined = automationId + " " + className + " " + role;
                string[] exactNames = { "address bar", "address and search bar", "location bar", "run", "выполнить", "командная строка" };
                if (exactNames.Contains(name)) return true;
                string[] blocked = {
                    "consolewindowclass", "cascadia_hosting_window_class", "termcontrol", "terminalcontrol",
                    "addresseditbox", "locationedit", "runcommand", "commandline", "shell_input"
                };
                return blocked.Any(value => joined.Contains(value));
            }
            catch { return true; }
        }

        private static bool HasUnsafeSurfaceDescendant(IntPtr hwnd, int maxElements, int maxMilliseconds)
        {
            try
            {
                Stopwatch timer = Stopwatch.StartNew();
                AutomationElement root = AutomationElement.FromHandle(hwnd);
                if (root == null || IsPassword(root) || IsAuthenticationControl(root) || IsLaunchSurfaceControl(root)) return true;
                TreeWalker walker = TreeWalker.ControlViewWalker;
                var pending = new Queue<AutomationElement>();
                AutomationElement first = walker.GetFirstChild(root);
                if (first != null) pending.Enqueue(first);
                int inspected = 0;
                while (pending.Count > 0)
                {
                    if (timer.ElapsedMilliseconds > maxMilliseconds || inspected >= maxElements) return true;
                    AutomationElement element = pending.Dequeue();
                    inspected++;
                    if (IsPassword(element) || IsAuthenticationControl(element) || IsLaunchSurfaceControl(element)) return true;
                    AutomationElement child = walker.GetFirstChild(element);
                    if (child != null) pending.Enqueue(child);
                    AutomationElement sibling = walker.GetNextSibling(element);
                    if (sibling != null) pending.Enqueue(sibling);
                }
                return false;
            }
            catch { return true; }
        }

        private static List<string> SupportedActions(AutomationElement element)
        {
            var result = new List<string>();
            object ignored;
            if (element.TryGetCurrentPattern(TogglePattern.Pattern, out ignored) || element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out ignored)) result.Add("click");
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out ignored))
            {
                try { if (!((ValuePattern)ignored).Current.IsReadOnly) result.Add("type"); } catch { }
            }
            if (element.TryGetCurrentPattern(ScrollPattern.Pattern, out ignored)) result.Add("scroll");
            return result.Distinct().ToList();
        }

        private static string SafeElementState(AutomationElement element)
        {
            object pattern;
            try
            {
                if (element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) return ((TogglePattern)pattern).Current.ToggleState.ToString().ToLowerInvariant();
                if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) return ((SelectionItemPattern)pattern).Current.IsSelected ? "selected" : "not-selected";
            }
            catch { }
            return null;
        }

        private static string ChooseMethod(PreparedAction action)
        {
            ElementEntry entry;
            if (!String.IsNullOrEmpty(action.BackendRef) && Elements.TryGetValue(action.BackendRef, out entry))
            {
                object pattern;
                if (action.Kind == "click" && (entry.Element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern) || entry.Element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))) return "uia";
                if (action.Kind == "type" && entry.Element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)
                    && CanUseBoundedValuePattern(action, (ValuePattern)pattern)) return "uia";
                if (action.Kind == "scroll" && entry.Element.TryGetCurrentPattern(ScrollPattern.Pattern, out pattern)) return "uia";
            }
            if (action.Kind == "click" && action.HasPoint) return "coordinates";
            if ((action.Kind == "type" || action.Kind == "key" || action.Kind == "scroll") && !String.IsNullOrEmpty(action.BackendRef)) return "send-input";
            if (action.Kind == "scroll" && action.HasPoint) return "send-input";
            throw new SafeError("unsupported_action", "no safe action method for exact target");
        }

        private static bool CanUseBoundedValuePattern(PreparedAction action, ValuePattern pattern)
        {
            try
            {
                if (pattern.Current.IsReadOnly) return false;
                string current = pattern.Current.Value ?? "";
                if (current.Length > MaxUiaValueScalars) return false;
                int characters = current.Length;
                int scalars = UnicodeScalarCount(current);
                foreach (string chunk in action.TextChunks)
                {
                    characters += chunk.Length;
                    scalars += UnicodeScalarCount(chunk);
                    if (characters > MaxUiaValueScalars || scalars > MaxUiaValueScalars) return false;
                }
                return characters <= MaxUiaValueScalars && scalars <= MaxUiaValueScalars;
            }
            catch { return false; }
        }

        private static void RequireExpected(WindowProbe expected, WindowProbe current, bool requireInputEpoch)
        {
            if (!SameIdentity(expected.Identity, current.Identity) || !SameGeometry(expected.Geometry, current.Geometry) || expected.Dpi != current.Dpi)
                throw new SafeError("stale_snapshot", "target identity, geometry or DPI changed");
            if (!String.Equals(expected.Title, current.Title, StringComparison.Ordinal)
                || !String.Equals(expected.TitleFingerprint, current.TitleFingerprint, StringComparison.Ordinal))
                throw new SafeError("target_title_changed", "selected window title changed");
            if (current.ScreenLocked || expected.ScreenLocked) throw new SafeError("screen_locked", "interactive desktop unavailable");
            if (!expected.Foreground || !current.Foreground) throw new SafeError("stale_focus", "exact target must remain foreground");
            if (requireInputEpoch && expected.UserInputEpoch != current.UserInputEpoch) throw new SafeError("hardware_input", "input epoch changed after observation");
        }

        private static POINT ActionPoint(PreparedAction action, ElementEntry entry)
        {
            if (entry != null)
            {
                var bounds = entry.Element.Current.BoundingRectangle;
                if (!bounds.IsEmpty && !Double.IsNaN(bounds.Left) && !Double.IsInfinity(bounds.Left))
                {
                    POINT current = new POINT { X = (int)Math.Round(bounds.Left + bounds.Width / 2), Y = (int)Math.Round(bounds.Top + bounds.Height / 2) };
                    if (PointInside(action.Expected.Geometry, current.X, current.Y)) return current;
                }
            }
            if (action.HasPoint) return new POINT { X = action.PointX, Y = action.PointY };
            throw new SafeError("point_required", "safe point unavailable");
        }

        private static void RequireHitTest(IntPtr target, POINT point)
        {
            IntPtr hit = WindowFromPoint(point);
            IntPtr root = hit == IntPtr.Zero ? IntPtr.Zero : GetAncestor(hit, GaRoot);
            if (GetForegroundWindow() != target || root != target) throw new SafeError("hit_test_failed", "point is not owned by exact foreground target");
        }

        private static void SendMouseClick(PreparedAction action, ElementEntry entry, POINT point)
        {
            RequireSendInputTarget(action, entry, point);
            RequireNoHeldInputState();
            RequireSendInputTarget(action, entry, point);
            INPUT[] inputs = new INPUT[3];
            inputs[0] = MouseMove(point);
            inputs[1] = new INPUT { Type = InputMouse, U = new InputUnion { Mi = new MOUSEINPUT { DwFlags = MouseeventfLeftdown } } };
            inputs[2] = new INPUT { Type = InputMouse, U = new InputUnion { Mi = new MOUSEINPUT { DwFlags = MouseeventfLeftup } } };
            if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length) throw new SafeError("send_input_failed", "mouse input rejected");
            action.DispatchAccepted = true;
            RequireSendInputTarget(action, entry, point);
        }

        private static void SendWheel(PreparedAction action, ElementEntry entry, POINT point, int delta)
        {
            RequireSendInputTarget(action, entry, point);
            RequireNoHeldInputState();
            RequireSendInputTarget(action, entry, point);
            INPUT[] inputs = new[] {
                MouseMove(point),
                new INPUT { Type = InputMouse, U = new InputUnion { Mi = new MOUSEINPUT { MouseData = unchecked((uint)delta), DwFlags = MouseeventfWheel } } }
            };
            if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length) throw new SafeError("send_input_failed", "wheel input rejected");
            action.DispatchAccepted = true;
            RequireSendInputTarget(action, entry, point);
        }

        private static INPUT MouseMove(POINT point)
        {
            int virtualLeft = GetSystemMetrics(76), virtualTop = GetSystemMetrics(77);
            int virtualWidth = Math.Max(1, GetSystemMetrics(78)), virtualHeight = Math.Max(1, GetSystemMetrics(79));
            int x = (int)Math.Round((point.X - virtualLeft) * 65535.0 / Math.Max(1, virtualWidth - 1));
            int y = (int)Math.Round((point.Y - virtualTop) * 65535.0 / Math.Max(1, virtualHeight - 1));
            return new INPUT { Type = InputMouse, U = new InputUnion { Mi = new MOUSEINPUT { Dx = x, Dy = y, DwFlags = MouseeventfMove | MouseeventfAbsolute | MouseeventfVirtualdesk } } };
        }

        private static void SendUnicode(PreparedAction action, ElementEntry entry, POINT point, string text)
        {
            RequireSendInputTarget(action, entry, point);
            RequireNoHeldInputState();
            RequireSendInputTarget(action, entry, point);
            var inputs = new List<INPUT>();
            foreach (char value in text)
            {
                inputs.Add(new INPUT { Type = InputKeyboard, U = new InputUnion { Ki = new KEYBDINPUT { WScan = value, DwFlags = KeyeventfUnicode } } });
                inputs.Add(new INPUT { Type = InputKeyboard, U = new InputUnion { Ki = new KEYBDINPUT { WScan = value, DwFlags = KeyeventfUnicode | KeyeventfKeyup } } });
            }
            if (inputs.Count > 0)
            {
                if (SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT))) != inputs.Count) throw new SafeError("send_input_failed", "text input rejected");
                action.DispatchAccepted = true;
                RequireSendInputTarget(action, entry, point);
            }
        }

        private static void SendKeyPress(PreparedAction action, ElementEntry entry, POINT point, ushort key)
        {
            RequireSendInputTarget(action, entry, point);
            RequireNoHeldInputState();
            RequireSendInputTarget(action, entry, point);
            INPUT[] inputs = new[] {
                KeyInput(key, false), KeyInput(key, true)
            };
            if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length) throw new SafeError("send_input_failed", "key input rejected");
            action.DispatchAccepted = true;
            RequireSendInputTarget(action, entry, point);
        }

        private static void RequireSendInputTarget(PreparedAction action, ElementEntry entry, POINT point)
        {
            DrainForegroundEvents();
            RequireElementCurrent(entry);
            if (!HooksReady || Interlocked.Read(ref ForegroundEventEpoch) != action.PreparedForegroundEpoch)
            {
                EmitEvent("focus-lost", action.Identity, "foreground changed at SendInput boundary");
                throw new SafeError("foreground_changed", "foreground changed after prepare");
            }
            if (UserInputEpoch() != action.Expected.UserInputEpoch)
            {
                EmitEvent("hardware-input", action.Identity, "physical input occurred at SendInput boundary");
                throw new SafeError("hardware_input", "physical input occurred before dispatch");
            }
            if (!IsWindow(action.Identity.Hwnd) || GetForegroundWindow() != action.Identity.Hwnd)
            {
                EmitEvent("focus-lost", action.Identity, "exact target lost foreground at SendInput boundary");
                throw new SafeError("focus_lost", "exact target is not foreground");
            }
            WindowIdentity actual;
            if (!TryIdentity(action.Identity.Hwnd, out actual) || !SameIdentity(action.Identity, actual))
            {
                EmitEvent("target-destroyed", action.Identity, "exact target identity changed at SendInput boundary");
                throw new SafeError("target_changed", "exact target identity changed");
            }
            RECT geometry;
            if (DwmGetWindowAttribute(action.Identity.Hwnd, DwmwaExtendedFrameBounds, out geometry, Marshal.SizeOf(typeof(RECT))) != 0 && !GetWindowRect(action.Identity.Hwnd, out geometry))
                throw new SafeError("geometry_unavailable", "window geometry unavailable");
            if (!SameGeometry(action.Expected.Geometry, geometry) || (int)GetDpiForWindow(action.Identity.Hwnd) != action.Expected.Dpi)
                throw new SafeError("target_changed", "window geometry or DPI changed before dispatch");
            string currentTitle = NormalizeWindowTitle(WindowText(actual.Hwnd));
            if (String.IsNullOrWhiteSpace(currentTitle)
                || !String.Equals(action.Expected.TitleFingerprint, WindowTitleFingerprint(currentTitle), StringComparison.Ordinal))
                throw new SafeError("target_title_changed", "selected window title changed at SendInput boundary");
            if (IsScreenLocked() || IsBlockedApplication(actual, currentTitle) || !PointInside(geometry, point.X, point.Y))
                throw new SafeError("unsafe_target", "target became unsafe before dispatch");
            RequireHitTest(action.Identity.Hwnd, point);
        }

        private static void DrainForegroundEvents()
        {
            lock (WinEventBarrierLock)
            {
                if (!HooksReady || HookThreadId == 0)
                    throw new SafeError("foreground_monitor_timeout", "foreground event monitor unavailable");
                ForegroundBarrierAck.Reset();
                if (!PostThreadMessage(HookThreadId, WmForegroundBarrier, UIntPtr.Zero, IntPtr.Zero)
                    || !ForegroundBarrierAck.WaitOne(MaxTargetCheckIntervalMs))
                {
                    // A late ACK must never satisfy a successor barrier. Once
                    // a barrier misses its deadline, this helper stays closed.
                    HooksReady = false;
                    throw new SafeError("foreground_monitor_timeout", "foreground event monitor did not acknowledge barrier");
                }
            }
        }

        private static INPUT KeyInput(ushort key, bool up)
        {
            return new INPUT { Type = InputKeyboard, U = new InputUnion { Ki = new KEYBDINPUT { WVk = key, DwFlags = up ? KeyeventfKeyup : 0 } } };
        }

        private static void RequireNoHeldInputState()
        {
            int[] guardedKeys = { 0x11, 0x10, 0x12, 0x5B, 0x5C, 0x01, 0x02, 0x04, 0x05, 0x06 };
            foreach (int key in guardedKeys)
                if ((GetAsyncKeyState(key) & 0x8000) != 0) throw new SafeError("input_state_held", "modifier or mouse button is held");
        }

        private static bool AllowedKey(string key)
        {
            return new[] { "Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Space" }.Contains(key);
        }

        private static ushort VirtualKey(string key)
        {
            var keys = new Dictionary<string, ushort> {
                { "Enter", 0x0D }, { "Tab", 0x09 }, { "Escape", 0x1B }, { "Backspace", 0x08 }, { "Delete", 0x2E },
                { "ArrowLeft", 0x25 }, { "ArrowUp", 0x26 }, { "ArrowRight", 0x27 }, { "ArrowDown", 0x28 },
                { "Home", 0x24 }, { "End", 0x23 }, { "PageUp", 0x21 }, { "PageDown", 0x22 }, { "Space", 0x20 }
            };
            ushort value;
            if (!keys.TryGetValue(key, out value)) throw new SafeError("key_blocked", "key is not allowlisted");
            return value;
        }

        private static WindowProbe ParseExpected(IDictionary<string, object> value, WindowIdentity identity)
        {
            IDictionary<string, object> geometry = RequiredDictionary(value, "geometry");
            int left = Convert.ToInt32(Required(geometry, "left"), CultureInfo.InvariantCulture);
            int top = Convert.ToInt32(Required(geometry, "top"), CultureInfo.InvariantCulture);
            int width = Convert.ToInt32(Required(geometry, "width"), CultureInfo.InvariantCulture);
            int height = Convert.ToInt32(Required(geometry, "height"), CultureInfo.InvariantCulture);
            if (width <= 0 || height <= 0) throw new SafeError("bad_geometry", "positive geometry required");
            WindowProbe expected = new WindowProbe {
                Identity = identity, Title = RequiredString(value, "title", MaxWindowTitleDisplayChars),
                TitleFingerprint = RequiredString(value, "titleFingerprint", 64),
                Geometry = new RECT { Left = left, Top = top, Right = left + width, Bottom = top + height },
                Dpi = Convert.ToInt32(Required(value, "dpi"), CultureInfo.InvariantCulture),
                UserInputEpoch = Convert.ToInt64(Required(value, "userInputEpoch"), CultureInfo.InvariantCulture),
                Foreground = Convert.ToBoolean(Required(value, "foreground"), CultureInfo.InvariantCulture),
                ScreenLocked = Convert.ToBoolean(Required(value, "screenLocked"), CultureInfo.InvariantCulture)
            };
            if (!String.Equals(expected.Title, NormalizeWindowTitle(expected.Title), StringComparison.Ordinal))
                throw new SafeError("bad_title", "normalized window title required");
            if (!IsSha256(expected.TitleFingerprint))
                throw new SafeError("bad_title", "complete window title fingerprint required");
            return expected;
        }

        private static void ParseExpectedElementTransition(IDictionary<string, object> resolved, PreparedAction prepared)
        {
            object transitionValue;
            if (!resolved.TryGetValue("expectedTransition", out transitionValue)) return;
            IDictionary<string, object> transition = transitionValue as IDictionary<string, object>;
            if (transition == null || prepared.Kind != "click")
                throw new SafeError("bad_expected_transition", "expected element transition is valid only for click");
            string kind = RequiredString(transition, "kind", 20);
            string before = RequiredString(transition, "before", 20);
            string after = RequiredString(transition, "after", 20);
            bool valid = (kind == "toggle" && ((before == "off" && after == "on") || (before == "on" && after == "off")))
                || (kind == "selection" && before == "not-selected" && after == "selected");
            if (!valid) throw new SafeError("bad_expected_transition", "unsupported element transition");
            prepared.TransitionKind = kind;
            prepared.ExpectedStateBefore = before;
            prepared.ExpectedStateAfter = after;
        }

        private static void ParseExpectedValueState(IDictionary<string, object> resolved, PreparedAction prepared)
        {
            object stateValue;
            if (!resolved.TryGetValue("expectedValueState", out stateValue)) return;
            IDictionary<string, object> state = stateValue as IDictionary<string, object>;
            if (state == null || prepared.Kind != "type")
                throw new SafeError("bad_expected_value_state", "expected ValuePattern state is valid only for type");
            string fingerprint = RequiredString(state, "fingerprint", 64);
            int scalarLength = Convert.ToInt32(Required(state, "scalarLength"), CultureInfo.InvariantCulture);
            if (!IsSha256(fingerprint) || scalarLength < 0)
                throw new SafeError("bad_expected_value_state", "valid opaque ValuePattern state required");
            prepared.HasExpectedValueState = true;
            prepared.ExpectedValueFingerprint = fingerprint;
            prepared.ExpectedValueScalarLength = scalarLength;
        }

        private static void ParseExpectedScrollState(IDictionary<string, object> resolved, PreparedAction prepared)
        {
            object stateValue;
            if (!resolved.TryGetValue("expectedScrollState", out stateValue)) return;
            IDictionary<string, object> state = stateValue as IDictionary<string, object>;
            if (state == null || prepared.Kind != "scroll")
                throw new SafeError("bad_expected_scroll_state", "expected ScrollPattern state is valid only for scroll");
            double horizontal = Convert.ToDouble(Required(state, "horizontalPercent"), CultureInfo.InvariantCulture);
            double vertical = Convert.ToDouble(Required(state, "verticalPercent"), CultureInfo.InvariantCulture);
            if (!ValidScrollPercent(horizontal) || !ValidScrollPercent(vertical))
                throw new SafeError("bad_expected_scroll_state", "valid ScrollPattern percentages required");
            prepared.HasExpectedScrollState = true;
            prepared.ExpectedHorizontalScrollPercent = horizontal;
            prepared.ExpectedVerticalScrollPercent = vertical;
        }

        private static void PrepareExpectedAfterValueState(PreparedAction action, ElementEntry entry)
        {
            object pattern;
            if (entry == null || !entry.Element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
                throw new SafeError("stale_element", "writable ValuePattern is required for type");
            ValuePattern valuePattern = (ValuePattern)pattern;
            if (valuePattern.Current.IsReadOnly)
                throw new SafeError("stale_element", "writable ValuePattern is required for type");
            string current = valuePattern.Current.Value ?? "";
            if (current.Length > MaxUiaValueScalars || UnicodeScalarCount(current) > MaxUiaValueScalars)
                throw new SafeError("value_oversize", "current ValuePattern value exceeds bounded input limit");
            RequireExpectedValueState(action, current);
            string expectedAfter = current;
            foreach (string chunk in action.TextChunks)
            {
                expectedAfter += chunk;
                if (expectedAfter.Length > MaxUiaValueScalars || UnicodeScalarCount(expectedAfter) > MaxUiaValueScalars)
                    throw new SafeError("value_oversize", "resulting ValuePattern value exceeds bounded input limit");
            }
            action.HasExpectedAfterValueState = true;
            action.ExpectedAfterValueFingerprint = Hash(Salt + ":value-state:" + expectedAfter);
            action.ExpectedAfterValueScalarLength = UnicodeScalarCount(expectedAfter);
        }

        private static Dictionary<string, object> ValueStateObject(AutomationElement element)
        {
            object pattern;
            if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return null;
            ValuePattern valuePattern = (ValuePattern)pattern;
            if (valuePattern.Current.IsReadOnly) return null;
            string value = valuePattern.Current.Value ?? "";
            if (value.Length > 32768) return null;
            return new Dictionary<string, object> {
                { "fingerprint", Hash(Salt + ":value-state:" + value) },
                { "scalarLength", UnicodeScalarCount(value) }
            };
        }

        private static Dictionary<string, object> ScrollStateObject(AutomationElement element)
        {
            object pattern;
            if (!element.TryGetCurrentPattern(ScrollPattern.Pattern, out pattern)) return null;
            ScrollPattern scroll = (ScrollPattern)pattern;
            double horizontal = scroll.Current.HorizontalScrollPercent;
            double vertical = scroll.Current.VerticalScrollPercent;
            if (!ValidScrollPercent(horizontal) || !ValidScrollPercent(vertical)) return null;
            return new Dictionary<string, object> {
                { "horizontalPercent", horizontal }, { "verticalPercent", vertical }
            };
        }

        private static void RequireExpectedValueState(PreparedAction action, string value)
        {
            if (!action.HasExpectedValueState
                || action.ExpectedValueScalarLength != UnicodeScalarCount(value)
                || !String.Equals(action.ExpectedValueFingerprint, Hash(Salt + ":value-state:" + value), StringComparison.Ordinal))
                throw new SafeError("stale_value_state", "ValuePattern changed after observation");
        }

        private static bool MatchesExpectedAfterValueState(PreparedAction action, string value)
        {
            return action.HasExpectedAfterValueState
                && action.ExpectedAfterValueScalarLength == UnicodeScalarCount(value)
                && String.Equals(action.ExpectedAfterValueFingerprint, Hash(Salt + ":value-state:" + value), StringComparison.Ordinal);
        }

        private static void RequireExpectedScrollState(PreparedAction action, double horizontal, double vertical)
        {
            if (!action.HasExpectedScrollState
                || action.ExpectedHorizontalScrollPercent != horizontal
                || action.ExpectedVerticalScrollPercent != vertical)
                throw new SafeError("stale_scroll_state", "ScrollPattern changed after observation");
        }

        private static bool ScrollDirectionMatched(int delta, double before, double after)
        {
            if (delta == 0) return before == after;
            if (!ValidScrollPercent(before) || !ValidScrollPercent(after) || before < 0 || after < 0) return false;
            return delta > 0 ? after > before : after < before;
        }

        private static bool ValidScrollPercent(double value)
        {
            return !Double.IsNaN(value) && !Double.IsInfinity(value)
                && (value == -1.0 || (value >= 0 && value <= 100));
        }

        private static string SafeToggleState(ToggleState state)
        {
            if (state == ToggleState.Off) return "off";
            if (state == ToggleState.On) return "on";
            return "indeterminate";
        }

        private static void RequireExpectedElementTransition(PreparedAction action, string kind, string current)
        {
            if (!String.Equals(action.TransitionKind, kind, StringComparison.Ordinal)
                || !String.Equals(action.ExpectedStateBefore, current, StringComparison.Ordinal))
                throw new SafeError("stale_element_state", "UI Automation element state changed before dispatch");
        }

        private static bool MatchesExpectedElementTransition(PreparedAction action, string kind, string current)
        {
            return String.Equals(action.TransitionKind, kind, StringComparison.Ordinal)
                && String.Equals(action.ExpectedStateAfter, current, StringComparison.Ordinal);
        }

        private static WindowIdentity ParseIdentity(IDictionary<string, object> value)
        {
            int pid = Convert.ToInt32(Required(value, "pid"), CultureInfo.InvariantCulture);
            string start = RequiredString(value, "processStartTime100ns", 40);
            string hwnd = RequiredString(value, "hwnd", 40);
            long hwndValue;
            if (pid <= 0 || !Int64.TryParse(hwnd, NumberStyles.None, CultureInfo.InvariantCulture, out hwndValue) || hwndValue <= 0 || !start.All(Char.IsDigit))
                throw new SafeError("bad_identity", "exact PID/start/HWND identity required");
            return new WindowIdentity { Pid = pid, Start = start, Hwnd = new IntPtr(hwndValue) };
        }

        private static Dictionary<string, object> IdentityObject(WindowIdentity identity)
        {
            return new Dictionary<string, object> {
                { "pid", identity.Pid }, { "processStartTime100ns", identity.Start },
                { "hwnd", identity.Hwnd.ToInt64().ToString(CultureInfo.InvariantCulture) }
            };
        }

        private static Dictionary<string, object> ProbeObject(WindowProbe probe)
        {
            return new Dictionary<string, object> {
                { "identity", IdentityObject(probe.Identity) },
                { "title", probe.Title },
                { "titleFingerprint", probe.TitleFingerprint },
                { "geometry", GeometryObject(probe.Geometry.Left, probe.Geometry.Top, probe.Geometry.Right - probe.Geometry.Left, probe.Geometry.Bottom - probe.Geometry.Top) },
                { "dpi", probe.Dpi }, { "foreground", probe.Foreground }, { "screenLocked", probe.ScreenLocked },
                { "userInputEpoch", probe.UserInputEpoch }, { "occluded", probe.Occluded }, { "hitTestOwnWindow", probe.HitTestOwnWindow },
                { "elevated", probe.Elevated }, { "protectedProcess", probe.ProtectedProcess }, { "secureSurface", probe.SecureSurface }
            };
        }

        private static Dictionary<string, object> GeometryObject(int left, int top, int width, int height)
        {
            return new Dictionary<string, object> { { "left", left }, { "top", top }, { "width", width }, { "height", height } };
        }

        private static Dictionary<string, object> ReadbackObject(PreparedAction action, WindowProbe probe, bool matched, bool dispatchAccepted, bool effectMatched, string detail)
        {
            var result = new Dictionary<string, object> {
                { "matched", matched }, { "dispatchAccepted", dispatchAccepted }, { "effectMatched", effectMatched },
                { "detail", detail }, { "attemptId", action.AttemptId }
            };
            if (probe != null)
            {
                result["identity"] = IdentityObject(probe.Identity);
                result["geometry"] = GeometryObject(probe.Geometry.Left, probe.Geometry.Top, probe.Geometry.Right - probe.Geometry.Left, probe.Geometry.Bottom - probe.Geometry.Top);
                result["dpi"] = probe.Dpi; result["foreground"] = probe.Foreground;
                result["userInputEpoch"] = probe.UserInputEpoch; result["postUserInputEpoch"] = probe.UserInputEpoch;
            }
            if (action.Kind == "type")
            {
                int scalarLength = action.TextChunks.Sum(chunk => UnicodeScalarCount(chunk));
                result["inputLength"] = scalarLength;
            }
            return result;
        }

        private static bool SameIdentity(WindowIdentity left, WindowIdentity right)
        {
            return left != null && right != null && left.Pid == right.Pid && left.Start == right.Start && left.Hwnd == right.Hwnd;
        }

        private static bool SameGeometry(RECT left, RECT right)
        {
            return left.Left == right.Left && left.Top == right.Top && left.Right == right.Right && left.Bottom == right.Bottom;
        }

        private static bool PointInside(RECT rect, int x, int y) { return x >= rect.Left && x < rect.Right && y >= rect.Top && y < rect.Bottom; }

        private static int UnicodeScalarCount(string value)
        {
            int count = 0;
            for (int i = 0; i < value.Length; i++) { if (Char.IsHighSurrogate(value[i]) && i + 1 < value.Length && Char.IsLowSurrogate(value[i + 1])) i++; count++; }
            return count;
        }

        private static string WindowText(IntPtr hwnd)
        {
            try
            {
                int beforeLength = GetWindowTextLength(hwnd);
                if (beforeLength <= 0 || beforeLength > MaxWindowTitleChars) return "";
                var value = new StringBuilder(beforeLength + 1);
                int copied = GetWindowText(hwnd, value, value.Capacity);
                int afterLength = GetWindowTextLength(hwnd);
                if (copied <= 0 || copied > MaxWindowTitleChars || copied != afterLength || value.Length != copied) return "";
                return value.ToString();
            }
            catch { return ""; }
        }

        private static string WindowClass(IntPtr hwnd)
        {
            var value = new StringBuilder(256); GetClassName(hwnd, value, value.Capacity); return value.ToString();
        }

        private static string SafeDisplay(string value, int max)
        {
            if (String.IsNullOrEmpty(value)) return "";
            value = value.Replace("\r", " ").Replace("\n", " ");
            return value.Length <= max ? value : value.Substring(0, max);
        }

        private static string NormalizeWindowTitle(string value)
        {
            if (String.IsNullOrEmpty(value)) return "";
            string normalized = value.Normalize(NormalizationForm.FormKC);
            var result = new StringBuilder(normalized.Length);
            bool pendingSpace = false;
            foreach (char character in normalized)
            {
                if (Char.IsWhiteSpace(character))
                {
                    if (result.Length > 0) pendingSpace = true;
                    continue;
                }
                if (pendingSpace) result.Append(' ');
                pendingSpace = false;
                result.Append(character);
            }
            return result.ToString();
        }

        private static string DisplayWindowTitle(string normalizedTitle)
        {
            return normalizedTitle.Length <= MaxWindowTitleDisplayChars
                ? normalizedTitle : normalizedTitle.Substring(0, MaxWindowTitleDisplayChars);
        }

        private static string WindowTitleFingerprint(string normalizedTitle)
        {
            return Hash("window-title|" + normalizedTitle);
        }

        private static bool IsSha256(string value)
        {
            return value != null && value.Length == 64 && value.All(character =>
                (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'));
        }

        private static string IdentityKey(WindowIdentity identity) { return identity.Pid + ":" + identity.Start + ":" + identity.Hwnd.ToInt64(); }
        private static string Opaque(string scope, string value) { return scope + ":" + Hash(Salt + ":" + scope + ":" + value).Substring(0, 24); }
        private static string Hash(string value)
        {
            using (SHA256 algorithm = SHA256.Create()) return BitConverter.ToString(algorithm.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-", "").ToLowerInvariant();
        }

        private static void CleanupExpired()
        {
            DateTime now = DateTime.UtcNow;
            foreach (var pair in PreparedActions.ToArray()) { PreparedAction ignored; if (pair.Value.ExpiresUtc <= now) PreparedActions.TryRemove(pair.Key, out ignored); }
            foreach (var pair in Elements.ToArray()) { ElementEntry ignored; if (pair.Value.ExpiresUtc <= now) Elements.TryRemove(pair.Key, out ignored); }
        }

        private static void CancelAllActions()
        {
            foreach (var action in ActiveActions.Values) { try { action.Cancel(); } catch { } }
        }

        private static void CancelAllObservations()
        {
            foreach (var observation in ActiveObservations.Values) { try { observation.Cancel(); } catch { } }
        }

        private static object Required(IDictionary<string, object> value, string key)
        {
            object result; if (!value.TryGetValue(key, out result) || result == null) throw new SafeError("missing_field", "required field missing"); return result;
        }

        private static string RequiredString(IDictionary<string, object> value, string key, int max)
        {
            object raw = Required(value, key); string result = raw as string;
            if (String.IsNullOrEmpty(result) || result.Length > max) throw new SafeError("bad_field", "string field invalid"); return result;
        }

        private static IDictionary<string, object> RequiredDictionary(IDictionary<string, object> value, string key)
        {
            IDictionary<string, object> result = Required(value, key) as IDictionary<string, object>;
            if (result == null) throw new SafeError("bad_field", "object field invalid"); return result;
        }

        private static int OptionalInt(IDictionary<string, object> value, string key, int fallback, int min, int max)
        {
            object raw; if (!value.TryGetValue(key, out raw) || raw == null) return fallback;
            int result = Convert.ToInt32(raw, CultureInfo.InvariantCulture); if (result < min || result > max) throw new SafeError("bad_field", "numeric field outside limit"); return result;
        }

        private static void WriteOk(string type, string requestId, IDictionary<string, object> payload)
        {
            var message = new Dictionary<string, object> { { "v", ProtocolVersion }, { "type", type }, { "requestId", requestId }, { "ok", true } };
            if (payload != null) foreach (var pair in payload) message[pair.Key] = pair.Value;
            Write(message);
        }

        private static void WriteError(string requestId, string code, string message)
        {
            Write(new Dictionary<string, object> { { "v", ProtocolVersion }, { "type", "error" }, { "requestId", String.IsNullOrEmpty(requestId) ? "none" : requestId }, { "ok", false }, { "code", code }, { "message", message } });
        }

        private static void EmitEvent(string type, WindowIdentity identity, string detail)
        {
            Write(new Dictionary<string, object> {
                { "v", ProtocolVersion }, { "type", "event" }, { "requestId", "event:" + Guid.NewGuid().ToString("N") },
                { "event", new Dictionary<string, object> { { "type", type }, { "identity", IdentityObject(identity) }, { "detail", detail } } }
            });
        }

        private static void Write(IDictionary<string, object> message)
        {
            string line = Json.Serialize(message);
            if (Encoding.UTF8.GetByteCount(line) > MaxMessageBytes)
            {
                object requestId;
                line = Json.Serialize(new Dictionary<string, object> { { "v", ProtocolVersion }, { "type", "error" }, { "requestId", message.TryGetValue("requestId", out requestId) ? requestId : "none" }, { "ok", false }, { "code", "response_oversize" }, { "message", "response exceeds limit" } });
            }
            lock (OutputLock) { Console.Out.WriteLine(line); Console.Out.Flush(); }
        }

        private static BoundedLine ReadBoundedLine(TextReader reader)
        {
            var value = new StringBuilder();
            int bytes = 0;
            bool oversize = false;
            while (true)
            {
                int next = reader.Read();
                if (next < 0) return value.Length == 0 && !oversize ? null : new BoundedLine { Value = value.ToString(), Oversize = oversize };
                char current = (char)next;
                if (current == '\n') return new BoundedLine { Value = value.ToString().TrimEnd('\r'), Oversize = oversize };
                if (oversize) continue;
                bytes += Encoding.UTF8.GetByteCount(new[] { current });
                if (bytes > MaxMessageBytes) { oversize = true; value.Length = 0; continue; }
                value.Append(current);
            }
        }

        private sealed class SafeError : Exception
        {
            public readonly string Code;
            public SafeError(string code, string message) : base(message) { Code = code; }
        }
    }
}
'@

try {
    Add-Type -TypeDefinition $helperSource -Language CSharp -ReferencedAssemblies @(
        'System.Core',
        'System.Drawing',
        'System.Web.Extensions',
        'WindowsBase',
        'UIAutomationClient',
        'UIAutomationTypes'
    ) | Out-Null
    [VerstakComputerUse.Helper]::Run($OwnerPid, $OwnerStartTime100ns)
}
catch {
    [Console]::Error.WriteLine('computer helper startup failed')
    exit 1
}
