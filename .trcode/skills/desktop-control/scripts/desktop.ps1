# desktop.ps1 - foreground desktop control for the trcode "desktop-control" skill.
#
#   desktop.ps1 windows [-Filter text] [-All]
#   desktop.ps1 active
#   desktop.ps1 focus -Match title|-Handle n|-Pid n [-AllowForeground]
#   desktop.ps1 openurl -Url https://example.com [-Match chrome|msedge]
#   desktop.ps1 screen [-Path file] [-Region x,y,w,h] [-Window | -Confirm]
#   desktop.ps1 ui [-Depth 4] [-Name text] [-Max 400]
#   desktop.ps1 click -X n -Y n [-Button left|right|middle] [-Double] [-AllowForeground]
#   desktop.ps1 clickui -Name text [-AutomationId id] [-ControlType Button] [-Index 0] [-AllowForeground]
#   desktop.ps1 move -X n -Y n [-AllowForeground]
#   desktop.ps1 drag -X1 n -Y1 n -X2 n -Y2 n [-AllowForeground]
#   desktop.ps1 scroll -Amount n [-Direction up|down] [-AllowForeground]
#   desktop.ps1 key -Combo ctrl+s [-AllowForeground]
#   desktop.ps1 type -Text "hello" [-AllowForeground]
#   desktop.ps1 gettext -Name text [-AutomationId id]
#   desktop.ps1 settext -Name text -Value "hello"
#   desktop.ps1 wait -Ms 500
#   desktop.ps1 clipboard [-Mode get|set] [-Text "..."]
#
# Queries print JSON on one line; actions print "ok <what>".
#
# Foreground control is opt-in. Nothing here moves the OS pointer, raises a
# window over the user's work or synthesizes mouse/keyboard input unless the
# call itself passes -AllowForeground: without it, focus, key, type, click,
# drag, scroll, move and the clickui mouse fallback are refused before any side
# effect. clickui still works through the UIA Invoke/Toggle/Select/Expand
# patterns, which run in the background and need no foreground at all. Pass
# -AllowForeground only when the user explicitly authorized foreground control
# in the current request.

param(
  [Parameter(Position = 0)][string]$Action = "",
  [Parameter(ValueFromRemainingArguments = $true)][object[]]$Rest = @()
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

# ---- options: -Key value pairs ------------------------------------------------
$script:Switches = @("window", "double", "all", "confirm", "force", "allowforeground")
$opt = @{}
for ($i = 0; $i -lt $Rest.Count; $i++) {
  $t = [string]$Rest[$i]
  if (-not $t.StartsWith("-")) { continue }
  $name = $t.TrimStart("-").ToLower()
  if ($script:Switches -contains $name) {
    $opt[$name] = "true"
  } elseif ($i + 1 -lt $Rest.Count) {
    $opt[$name] = [string]$Rest[$i + 1]
    $i++
  } else {
    "error option '-$name' needs a value"
    exit 1
  }
}
function O($name, $default = $null) { if ($opt.ContainsKey($name)) { return $opt[$name] } return $default }
function N($name, $default = 0) {
  $v = O $name
  if ($null -eq $v) { return $default }
  try { return [int]$v } catch { Fail "option '-$name' expects a number (got '$v')" }
}

# ---- native surface -----------------------------------------------------------
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$src = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public class DW {
  public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int data, IntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, ref INPUT p, int cb);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll")] public static extern int VkKeyScan(char ch);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  // SendInput needs the real Win32 sizes: the union is sized by MOUSEINPUT
  // (32 bytes on x64, 24 on x86), which fixes cbSize = sizeof(INPUT).
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT {
    public uint uMsg; public ushort wParamL, wParamH;
  }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT {
    public uint type; public INPUTUNION u;
  }

  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010,
                    MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040, WHEEL = 0x0800, HWHEEL = 0x01000;
  public const uint KEYUP = 0x0002, EXTENDED = 0x0001, UNICODE = 0x0004, GA_ROOT = 0x0002;

  public class Win {
    public long Handle; public int Pid; public string Title; public string Class;
    public string Process; public int X, Y, Width, Height; public bool Active; public bool Minimized; public bool Visible;
  }

  // Root (top level) window under a screen point - independent of focus.
  public static IntPtr RootAt(int x, int y) {
    POINT p; p.X = x; p.Y = y;
    IntPtr h = WindowFromPoint(p);
    if (h == IntPtr.Zero) return IntPtr.Zero;
    IntPtr root = GetAncestor(h, GA_ROOT);
    return root == IntPtr.Zero ? h : root;
  }

  public static IntPtr RootAtCursor() {
    POINT p;
    if (!GetCursorPos(out p)) return IntPtr.Zero;
    return RootAt(p.X, p.Y);
  }

  // Describe one window straight from its handle: works for hidden, untitled,
  // iconified windows and for windows belonging to other desktops.
  public static Win InfoOf(IntPtr h) {
    if (h == IntPtr.Zero) return null;
    string title = "";
    string cls = "";
    uint pid = 0;
    try { var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512); title = sb.ToString(); } catch { }
    try { var cs = new StringBuilder(256); GetClassNameW(h, cs, 256); cls = cs.ToString(); } catch { }
    try { GetWindowThreadProcessId(h, out pid); } catch { }
    string proc = "";
    if (pid != 0) { try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { } }
    int x = 0, y = 0, w = 0, ht = 0;
    RECT r;
    if (GetWindowRect(h, out r)) { x = r.Left; y = r.Top; w = r.Right - r.Left; ht = r.Bottom - r.Top; }
    return new Win {
      Handle = h.ToInt64(), Pid = (int)pid, Title = title, Class = cls, Process = proc,
      X = x, Y = y, Width = w, Height = ht,
      Active = h == GetForegroundWindow(), Minimized = IsIconic(h), Visible = IsWindowVisible(h)
    };
  }

  public static List<Win> List(bool includeHidden) {
    var list = new List<Win>();
    EnumWindows((h, l) => {
      bool vis = IsWindowVisible(h);
      if (!vis && !includeHidden) return true;
      Win w = InfoOf(h);
      if (w == null) return true;
      if (w.Width <= 0) return true;
      if (w.Title.Length == 0 && !includeHidden) return true;
      list.Add(w);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static List<Win> List() { return List(false); }

  public static bool IsForeground(IntPtr h) {
    return h != IntPtr.Zero && IsWindow(h) && GetForegroundWindow() == h;
  }

  // Attach this thread to the foreground/target threads, not the other way
  // around. The old order made SetForegroundWindow depend on a race with the
  // previously focused application. Require two stable reads before returning.
  public static bool Focus(IntPtr h) {
    if (h == IntPtr.Zero || !IsWindow(h)) return false;
    for (int attempt = 0; attempt < 6; attempt++) {
      if (IsIconic(h)) ShowWindow(h, 9);
      IntPtr fg = GetForegroundWindow();
      uint fgPid, targetPid;
      uint tidFg = GetWindowThreadProcessId(fg, out fgPid);
      uint tidTarget = GetWindowThreadProcessId(h, out targetPid);
      uint tid = GetCurrentThreadId();
      bool attachedFg = false, attachedTarget = false;
      try {
        if (tidFg != 0 && tidFg != tid) attachedFg = AttachThreadInput(tid, tidFg, true);
        if (tidTarget != 0 && tidTarget != tid && tidTarget != tidFg) attachedTarget = AttachThreadInput(tid, tidTarget, true);
        ShowWindow(h, 5);
        BringWindowToTop(h);
        SetForegroundWindow(h);
        SetFocus(h);
      } finally {
        if (attachedTarget) AttachThreadInput(tid, tidTarget, false);
        if (attachedFg) AttachThreadInput(tid, tidFg, false);
      }
      System.Threading.Thread.Sleep(120);
      if (GetForegroundWindow() != h) continue;
      System.Threading.Thread.Sleep(80);
      if (GetForegroundWindow() == h) return true;
    }
    return false;
  }

  public static uint SendInputs(INPUT[] items) {
    if (items.Length == 0) return 0;
    return SendInput((uint)items.Length, ref items[0], Marshal.SizeOf(typeof(INPUT)));
  }

  public static INPUT KeyInput(byte vk, bool up, bool extended) {
    INPUT inp = new INPUT();
    inp.type = 1;
    inp.u.ki.wVk = vk;
    inp.u.ki.wScan = 0;
    inp.u.ki.dwFlags = (up ? KEYUP : 0) | (extended ? EXTENDED : 0);
    return inp;
  }

  public static byte Vk(string key, out bool shift, out bool extended) {
    shift = false; extended = false;
    if (key.Length == 1) {
      int v = VkKeyScan(key[0]);
      shift = ((v >> 8) & 1) == 1;
      return (byte)(v & 0xFF);
    }
    return 0;
  }

  // One SendInput batch keeps the chord together. Foreground ownership is
  // checked immediately before injection; a stolen focus is an error, never an
  // invitation to type into whichever application happens to be in front.
  public static void Key(byte vk, bool shift, bool extended, bool ctrl, bool alt, bool win, IntPtr target) {
    if (!IsForeground(target)) throw new InvalidOperationException("target window is not in the foreground; key was not sent");
    var items = new List<INPUT>();
    if (win) items.Add(KeyInput(0x5B, false, true));
    if (shift) items.Add(KeyInput(0x10, false, false));
    if (ctrl) items.Add(KeyInput(0x11, false, false));
    if (alt) items.Add(KeyInput(0x12, false, false));
    items.Add(KeyInput(vk, false, extended));
    items.Add(KeyInput(vk, true, extended));
    if (alt) items.Add(KeyInput(0x12, true, false));
    if (ctrl) items.Add(KeyInput(0x11, true, false));
    if (shift) items.Add(KeyInput(0x10, true, false));
    if (win) items.Add(KeyInput(0x5B, true, true));
    uint sent = SendInputs(items.ToArray());
    if (sent != items.Count) throw new InvalidOperationException("Windows accepted only " + sent + " of " + items.Count + " key events");
  }

  // Layout independent text input: each UTF-16 code unit goes through SendInput
  // with KEYEVENTF_UNICODE (wScan is ushort, so surrogate pairs survive);
  // newline and tab become Enter/Tab.
  public static int TypeText(string text, IntPtr target) {
    int written = 0;
    for (int i = 0; i < text.Length; i++) {
      if (!IsForeground(target)) throw new InvalidOperationException("target window lost focus after " + written + " character(s); typing stopped");
      char ch = text[i];
      if (ch == '\r') {
        if (i + 1 < text.Length && text[i + 1] == '\n') continue;
        Key(0x0D, false, false, false, false, false, target);
        written++;
        continue;
      }
      if (ch == '\n') { Key(0x0D, false, false, false, false, false, target); written++; continue; }
      if (ch == '\t') { Key(0x09, false, false, false, false, false, target); written++; continue; }
      if (!SendUnicode(ch)) throw new InvalidOperationException("Windows refused character " + written + "; typing stopped");
      written++;
      System.Threading.Thread.Sleep(2);
    }
    return written;
  }

  public static bool SendUnicode(char ch) {
    INPUT down = new INPUT();
    down.type = 1;
    down.u.ki.wVk = 0;
    down.u.ki.wScan = (ushort)ch;
    down.u.ki.dwFlags = UNICODE;
    INPUT up = down;
    up.u.ki.dwFlags = UNICODE | KEYUP;
    return SendInputs(new INPUT[] { down, up }) == 2;
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp
[DW]::SetProcessDPIAware() | Out-Null

$VKMap = @{
  "enter" = 0x0D; "return" = 0x0D; "tab" = 0x09; "esc" = 0x1B; "escape" = 0x1B; "space" = 0x20;
  "backspace" = 0x08; "delete" = 0x2E; "del" = 0x2E; "insert" = 0x2D;
  "up" = 0x26; "down" = 0x28; "left" = 0x25; "right" = 0x27;
  "home" = 0x24; "end" = 0x23; "pageup" = 0x21; "pagedown" = 0x22;
  "shift" = 0x10; "ctrl" = 0x11; "control" = 0x11; "alt" = 0x12; "win" = 0x5B;
  "printscreen" = 0x2C; "capslock" = 0x14; "apps" = 0x5D; "menu" = 0x5D
}
1..12 | ForEach-Object { $VKMap["f$_"] = 0x6F + $_ }
$EXTENDED_KEYS = @(0x25, 0x26, 0x27, 0x28, 0x24, 0x23, 0x21, 0x22, 0x2D, 0x2E, 0x5B, 0x5D)

function Out-Json($obj) {
  $arr = @($obj)
  if ($arr.Count -eq 0) { return "[]" }
  return ConvertTo-Json -InputObject $arr -Compress -Depth 6
}
function Out-Obj($obj) { ConvertTo-Json -InputObject $obj -Compress -Depth 6 }
function Out-Ok($msg) { "ok $msg" }
# Every invocation writes exactly one audit line: a refusal or an error that was
# not logged by the handler itself is logged here before the exit.
function Fail($msg) {
  if ($script:Audited -eq $false -and $script:ActionName) { Log-Action $script:ActionName $null $msg "error" }
  "error $msg"; exit 1
}
$script:Audited = $false
$script:Forced = $false
$script:ActionName = if ($Action) { $Action.ToLower() } else { "" }

# ---- windows -----------------------------------------------------------------
function Get-Windows([bool]$includeHidden) {
  $list = [DW]::List($includeHidden)
  $f = O "filter"
  $rows = @()
  foreach ($w in $list) {
    if ($f -and ($w.Title -notlike "*$f*") -and ($w.Process -notlike "*$f*")) { continue }
    $rows += [ordered]@{
      handle = $w.Handle; pid = $w.Pid; process = $w.Process; title = $w.Title; class = $w.Class;
      x = $w.X; y = $w.Y; width = $w.Width; height = $w.Height;
      active = $w.Active; minimized = $w.Minimized; visible = $w.Visible
    }
  }
  return $rows
}

function Resolve-Window {
  $h = O "handle"
  if ($h) { return [IntPtr][long]$h }
  $all = [DW]::List($true)
  $pidArg = O "pid"
  if ($pidArg) {
    $hits = @($all | Where-Object { $_.Pid -eq [int]$pidArg })
    if (-not $hits) { Fail "no window for pid $pidArg" }
    $w = @($hits | Where-Object { $_.Visible } | Select-Object -First 1)
    if (-not $w.Count) { $w = @($hits | Select-Object -First 1) }
    return [IntPtr]$w[0].Handle
  }
  $m = O "match"
  if (-not $m) { return [DW]::GetForegroundWindow() }
  $hits = @($all | Where-Object { $_.Title -like "*$m*" -or $_.Process -like "*$m*" })
  if (-not $hits) { Fail "no window matching '$m'" }
  $visible = @($hits | Where-Object { $_.Visible } | Select-Object -First 1)
  if ($visible.Count) { return [IntPtr]$visible[0].Handle }
  return [IntPtr]$hits[0].Handle
}

function Test-TargetOption {
  return (O "handle") -or (O "pid") -or (O "match")
}

function Prepare-InputWindow([string]$what, [IntPtr]$explicitTarget = [IntPtr]::Zero, [string]$detail = "") {
  $target = if ($explicitTarget -ne [IntPtr]::Zero) { $explicitTarget } else { Resolve-Window }
  $win = Assert-AppAllowed $target $what
  Assert-ForegroundAllowed $what $win $detail
  if (-not [DW]::Focus($target)) {
    Fail "$what could not focus the target window; no input was sent"
  }
  if (-not [DW]::IsForeground($target)) {
    Fail "$what target lost foreground before input; no input was sent"
  }
  return [pscustomobject]@{ Handle = $target; Window = $win }
}

function Assert-PointTarget([int]$x, [int]$y, [IntPtr]$target, [string]$what) {
  $actual = [DW]::RootAt($x, $y)
  if ($actual -eq [IntPtr]::Zero -or $actual -ne $target) {
    $actualInfo = Get-WindowInfo $actual
    $name = if ($actualInfo) { "$($actualInfo.Process): $($actualInfo.Title)" } else { "no window" }
    Fail "$what point $x,$y is over $name, not over the target window; input was not sent"
  }
}

# ---- policy: per-app allow/deny, audit log, irreversible guard ---------------
$SkillRoot = Split-Path $PSScriptRoot -Parent
$AuditPath = if ($env:TRCODE_DESKTOP_AUDIT) { $env:TRCODE_DESKTOP_AUDIT } else { Join-Path (Join-Path $HOME ".trcode") "desktop-actions.jsonl" }
$AppsPath = if ($env:TRCODE_DESKTOP_APPS) { $env:TRCODE_DESKTOP_APPS } else { Join-Path $SkillRoot "apps.json" }

function Get-WindowInfo($h) {
  if ($null -eq $h) { return $null }
  return [DW]::InfoOf([IntPtr]$h)
}

function Get-PointWindowInfo([int]$x, [int]$y) {
  return [DW]::InfoOf([DW]::RootAt($x, $y))
}

function Get-AppPolicy {
  if ($null -ne $script:Policy) { return $script:Policy }
  $script:Policy = @{ default = "allow"; allow = @(); deny = @() }
  if (Test-Path $AppsPath) {
    try {
      $raw = Get-Content $AppsPath -Raw | ConvertFrom-Json
    } catch {
      Fail "apps.json is not valid JSON: $AppsPath"
    }
    if ($null -eq $raw -or $raw -isnot [System.Management.Automation.PSCustomObject]) {
      Fail "apps.json must be a JSON object: $AppsPath"
    }
    $def = "allow"
    if ($null -ne $raw -and $null -ne $raw.PSObject.Properties["default"] -and $raw.default) {
      $def = ([string]$raw.default).ToLower()
      if ($def -ne "allow" -and $def -ne "deny") {
        Fail "apps.json: ``default`` must be ``allow`` or ``deny`` (got ``$($raw.default)``) in $AppsPath"
      }
    }
    $script:Policy = @{
      default = $def
      allow = @($raw.allow | Where-Object { $_ } | ForEach-Object { ([string]$_).ToLower() })
      deny = @($raw.deny | Where-Object { $_ } | ForEach-Object { ([string]$_).ToLower() })
    }
  }
  return $script:Policy
}

function App-Verdict([string]$name) {
  $p = Get-AppPolicy
  $n = $name.ToLower()
  if ($p.deny -contains $n) { return "deny" }
  if ($p.allow -contains $n) { return "allow" }
  if ($p.default -eq "deny") { return "deny" }
  return "allow"
}

function Log-Action([string]$action, $win, [string]$detail, [string]$status) {
  $script:Audited = $true
  if ($status -eq "ok" -and $script:Forced) { $status = "bypassed" }
  try {
    $full = [IO.Path]::GetFullPath($AuditPath)
    $dir = [IO.Path]::GetDirectoryName($full)
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $entry = [ordered]@{
      ts = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
      action = $action
      process = if ($win) { $win.Process } else { "" }
      title = if ($win) { $win.Title } else { "" }
      detail = $detail
      status = $status
    }
    $line = [string](ConvertTo-Json -InputObject $entry -Compress -Depth 3)
    Add-Content -Path $full -Value $line -Encoding UTF8
  } catch { }
}

# One JSONL line, then exit 1: every refusal is audited exactly once.
function Refuse([string]$what, $win, [string]$detail, [string]$message) {
  Log-Action $what $win $detail "denied"
  Fail $message
}

# ---- foreground gate ---------------------------------------------------------
# Moving the OS pointer, raising a window over whatever the user is looking at
# or synthesizing input takes the mouse and keyboard away from the person at the
# desk, so each call must ask for it. Work done through an application interface
# (UI Automation patterns, the app's own command line, the browser through
# browser.mjs and CDP) never passes through this gate.
function Test-ForegroundAllowed { return ($null -ne (O "allowforeground")) }

function Assert-ForegroundAllowed([string]$what, $win, [string]$detail) {
  if (Test-ForegroundAllowed) { return }
  Refuse $what $win $detail ("{0} would move the OS pointer, take the foreground or synthesize input, which would capture the user's mouse, keyboard or focus. Nothing was moved and no key was sent. Use an app API or browser.mjs (CDP) instead, or re-run with -AllowForeground only when the user explicitly authorized foreground control in the current request" -f $what)
}

function Assert-AppAllowed($handle, [string]$what) {
  $win = Get-WindowInfo $handle
  $name = if ($win) { $win.Process } else { "" }
  if (O "force") {
    $script:Forced = $true
    return $win
  }
  if (-not $name) {
    Log-Action $what $win "unknown process" "denied"
    Fail "$what targets a window whose owning process cannot be determined — refusing to act. Ask the user, then re-run with -Force if they agree"
  }
  if ((App-Verdict $name) -eq "deny") {
    Log-Action $what $win $name "denied by apps.json"
    Fail "app '$name' is denied in apps.json — the user must allow it there, or re-run with -Force if they agreed"
  }
  return $win
}

$IRREVERSIBLE = '(?i)\b(delete|remove|erase|wipe|truncate|format|uninstall|reset|clear|purge|pay|buy|purchase|checkout|send|submit|publish|deploy|block|deactivate|unsubscribe|overwrite|удал|стереть|очист|сброс|формат|деинсталл|оплат|купи|покупк|отправ|опублик|разверн|заблокир|деактив|отпис|перезапис)'

function Assert-Reversible([string]$label, [string]$what, $win, [string]$detail) {
  if (-not $label) { return }
  if ($label -notmatch $IRREVERSIBLE) { return }
  if (O "confirm") { return }
  Refuse $what $win $detail "$what targets ""$label"", which looks irreversible — ask the user, then re-run with -Confirm"
}

function Ui-ElementAt([int]$x, [int]$y) {
  # Legacy providers do not answer point queries, so walk the foreground window
  # and take the smallest element whose rect contains the point.
  $best = $null
  $bestArea = [double]::MaxValue
  try { $root = [Windows.Automation.AutomationElement]::FromHandle([DW]::RootAt($x, $y)) } catch { $root = $null }
  if ($root) {
    $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
    $budget = 800
    $stack = New-Object System.Collections.Stack
    $stack.Push($root)
    while ($stack.Count -gt 0) {
      $budget = $budget - 1
      if ($budget -le 0) { break }
      $el = $stack.Pop()
      try {
        $r = $el.Current.BoundingRectangle
        if ($r.Width -gt 0 -and $x -ge $r.X -and $x -le ($r.X + $r.Width) -and $y -ge $r.Y -and $y -le ($r.Y + $r.Height)) {
          $area = $r.Width * $r.Height
          if ($area -lt $bestArea) { $best = $el; $bestArea = $area }
          try { $child = $walker.GetFirstChild($el) } catch { $child = $null }
          while ($child -ne $null) {
            $stack.Push($child)
            try { $child = $walker.GetNextSibling($child) } catch { break }
          }
        }
      } catch { }
    }
  }
  if ($best) { return $best }
  try { return [Windows.Automation.AutomationElement]::FromPoint((New-Object Windows.Point($x, $y))) } catch { return $null }
}

# ---- UI Automation -----------------------------------------------------------
function Get-UiRoot {
  $h = O "handle"
  if ($h) { return [Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$h) }
  return [Windows.Automation.AutomationElement]::FromHandle((Resolve-Window))
}

function Get-UiRootWindow {
  $h = O "handle"
  if ($h) { return [DW]::InfoOf([IntPtr][long]$h) }
  return [DW]::InfoOf((Resolve-Window))
}

function Ui-Dump {
  $depth = N "depth" 4
  $max = N "max" 400
  $nameFilter = O "name"
  $root = Get-UiRoot
  $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
  $out = New-Object System.Collections.ArrayList
  function Walk($el, $level) {
    if ($out.Count -ge $max) { return }
    try {
      $c = $el.Current
      $rect = $c.BoundingRectangle
      $row = [ordered]@{
        level = $level; type = $c.ControlType.ProgrammaticName -replace "ControlType\.", "";
        name = $c.Name; id = $c.AutomationId; cls = $c.ClassName;
        x = [int]$rect.X; y = [int]$rect.Y; w = [int]$rect.Width; h = [int]$rect.Height;
        enabled = $c.IsEnabled; offscreen = $c.IsOffscreen; focus = $c.HasKeyboardFocus
      }
      $pats = @()
      foreach ($pat in @(
        @("invoke", [Windows.Automation.InvokePattern]::Pattern),
        @("value", [Windows.Automation.ValuePattern]::Pattern),
        @("toggle", [Windows.Automation.TogglePattern]::Pattern),
        @("select", [Windows.Automation.SelectionItemPattern]::Pattern),
        @("expand", [Windows.Automation.ExpandCollapsePattern]::Pattern))) {
        try { $pp = $null; if ($el.TryGetCurrentPattern($pat[1], [ref]$pp)) { $pats += $pat[0] } } catch { }
      }
      if ($pats.Count) { $row.patterns = ($pats -join ",") }
      $match = $true
      if ($nameFilter) {
        $match = ($c.Name -like "*$nameFilter*") -or ($c.AutomationId -like "*$nameFilter*")
        if ($match) {
          $chain = @()
          $p = $el
          while ($p -ne $null) {
            try { $chain += ("{0}[{1}]" -f $p.Current.Name, ($p.Current.ControlType.ProgrammaticName -replace "ControlType\.", "")) } catch { break }
            try { $p = $walker.GetParent($p) } catch { break }
            if ($chain.Count -ge 6) { break }
          }
          $row.parents = ($chain -join " < ")
        } else {
          $row | Out-Null
        }
      }
      if ($match) { [void]$out.Add($row) }
      if ($level -ge $depth) { return }
      try { $child = $walker.GetFirstChild($el) } catch { return }
      while ($child -ne $null) {
        Walk $child ($level + 1)
        if ($out.Count -ge $max) { return }
        try { $child = $walker.GetNextSibling($child) } catch { break }
      }
    } catch { }
  }
  Walk $root 0
  return $out
}

function Resolve-ControlType($name) {
  # ControlType members are static FIELDS (not properties) in UIAutomationTypes.
  $flags = [Reflection.BindingFlags]::Public -bor [Reflection.BindingFlags]::Static -bor [Reflection.BindingFlags]::IgnoreCase
  $fld = [Windows.Automation.ControlType].GetField($name, $flags)
  if ($null -ne $fld) { return $fld.GetValue($null) }
  $prop = [Windows.Automation.ControlType].GetProperty($name, $flags)
  if ($null -ne $prop) { return $prop.GetValue($null) }
  $known = ([Windows.Automation.ControlType].GetFields([Reflection.BindingFlags]::Public -bor [Reflection.BindingFlags]::Static) | ForEach-Object { $_.Name }) -join ", "
  Fail "unknown control type '$name' (known: $known)"
}

function Find-UiElement {
  $root = Get-UiRoot
  $name = O "name"
  $aid = O "automationid"
  $ctype = O "controltype"
  $index = N "index" 0
  if ($index -lt 0) { Fail "index must be 0 or greater (got $index)" }
  $cond = $null
  if ($aid) {
    # Walk the same ControlView tree `ui` prints. Legacy MSAA providers do not
    # answer a fast AutomationId condition, and this path also applies -Name,
    # -ControlType and -Index consistently before choosing the match.
    $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
    $stack = New-Object System.Collections.Stack
    $stack.Push($root)
    $hits = @()
    $budget = 4000
    while ($stack.Count -gt 0 -and $budget -gt 0) {
      $budget = $budget - 1
      $e = $stack.Pop()
      try {
        $idHit = [string]$e.Current.AutomationId -eq [string]$aid
        if (-not $idHit) { $idHit = [string]$e.Current.NativeWindowHandle -eq [string]$aid }
        if ($idHit) {
          if ($name -and $e.Current.Name -notlike "*$name*") { $idHit = $false }
          if ($ctype -and $e.Current.ControlType.ProgrammaticName -notlike "*$ctype*") { $idHit = $false }
          if ($idHit) { $hits += $e }
        }
        $child = $walker.GetFirstChild($e)
        while ($child -ne $null) {
          $stack.Push($child)
          try { $child = $walker.GetNextSibling($child) } catch { break }
        }
      } catch { }
    }
    if ($hits.Count -eq 0) { Fail "no element with AutomationId '$aid'" }
    if ($index -ge $hits.Count) { Fail "index $index beyond $($hits.Count) matches for AutomationId '$aid'" }
    return $hits[$index]
  }
  elseif ($name) {
    $cond = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, $name)
    $exact = $root.FindAll([Windows.Automation.TreeScope]::Descendants, $cond)
    if ($exact.Count -eq 0) {
      $cond = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, $name, [Windows.Automation.PropertyConditionFlags]::IgnoreCase)
      $exact = $root.FindAll([Windows.Automation.TreeScope]::Descendants, $cond)
    }
    if ($exact.Count -eq 0) {
      $all = $root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
      $hits = @()
      foreach ($e in $all) {
        try {
          if ($e.Current.Name -like "*$name*") {
            if ($ctype -and $e.Current.ControlType.ProgrammaticName -notlike "*$ctype*") { continue }
            $hits += $e
          }
        } catch { }
      }
      if ($hits.Count -eq 0) { Fail "no element named '$name'" }
      if ($index -ge $hits.Count) { Fail "index $index beyond $($hits.Count) matches for '$name'" }
      return $hits[$index]
    }
    $list = @()
    for ($i = 0; $i -lt $exact.Count; $i++) {
      $e = $exact.Item($i)
      if (-not $ctype -or ($e.Current.ControlType.ProgrammaticName -like "*$ctype*")) { $list += $e }
    }
    if ($list.Count -eq 0) { Fail "no '$ctype' named '$name'" }
    if ($index -ge $list.Count) { Fail "index $index beyond $($list.Count) matches for '$name'" }
    return $list[$index]
  } elseif ($ctype) {
    $cond = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, (Resolve-ControlType $ctype))
  } else {
    Fail "clickui/gettext needs -Name, -AutomationId or -ControlType"
  }
  $found = $root.FindAll([Windows.Automation.TreeScope]::Descendants, $cond)
  if ($found.Count -eq 0) { Fail "no element matched" }
  if ($index -ge $found.Count) { Fail "index $index beyond $($found.Count) matches" }
  return $found.Item($index)
}

function Invoke-Element($el, [IntPtr]$target) {
  $p = $null
  if ($el.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return "invoke" }
  if ($el.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); return "toggle" }
  if ($el.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); return "select" }
  if ($el.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $p.Expand(); return "expand" }
  # This element exposes no background interface, so the only route left is a
  # synthetic mouse click: that needs the foreground and an explicit opt-in.
  Assert-ForegroundAllowed "clickui" (Get-WindowInfo $target) ("no Invoke/Toggle/Select/Expand pattern; mouse fallback on ""{0}""" -f $el.Current.Name)
  if (-not [DW]::Focus($target)) { Fail "clickui could not focus its target before the mouse fallback" }
  $r = $el.Current.BoundingRectangle
  if ($r.Width -le 0) { Fail "element has no clickable area" }
  $x = [int]($r.X + $r.Width / 2); $y = [int]($r.Y + $r.Height / 2)
  Assert-PointTarget $x $y $target "clickui"
  [DW]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 80
  if (-not [DW]::IsForeground($target)) { Fail "clickui target lost foreground before the click" }
  [DW]::mouse_event([DW]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [DW]::mouse_event([DW]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
  return "mouse"
}

# ---- actions -----------------------------------------------------------------
switch ($Action.ToLower()) {
  "windows" {
    $rows = @(Get-Windows ((O "all") -ne $null))
    Log-Action "windows" $null ("{0} windows" -f $rows.Count) "ok"
    Out-Json $rows
  }
  "active" {
    $w = [DW]::InfoOf([DW]::GetForegroundWindow())
    if (-not $w) { Log-Action "active" $null "" "error"; Fail "no active window" }
    Log-Action "active" $w "" "ok"
    Out-Obj ([ordered]@{ handle = $w.Handle; pid = $w.Pid; process = $w.Process; title = $w.Title; class = $w.Class; x = $w.X; y = $w.Y; width = $w.Width; height = $w.Height })
  }
  "focus" {
    $t = Resolve-Window
    $win = Assert-AppAllowed $t "focus"
    Assert-ForegroundAllowed "focus" $win ""
    if (-not [DW]::Focus($t)) { Log-Action "focus" $win "" "error"; Fail "could not bring the window to the foreground" }
    Log-Action "focus" $win "" "ok"
    if ($win) { Out-Ok ("focus {0} ({1})" -f $win.Title, $win.Process) } else { Out-Ok "focus" }
  }
  "ui" {
    $rows = @(Ui-Dump)
    Log-Action "ui" (Get-UiRootWindow) ("{0} elements" -f $rows.Count) "ok"
    Out-Json $rows
  }
  "screen" {
    $path = O "path"
    if (-not $path) {
      $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
      $path = Join-Path ([IO.Path]::GetTempPath()) "screen-$stamp.png"
    }
    $x = 0; $y = 0; $w = 0; $h = 0; $win = $null; $coversAll = $false; $scope = "full screen"
    $captureTarget = [IntPtr]::Zero
    $region = O "region"
    $vs = [Windows.Forms.SystemInformation]::VirtualScreen
    if ($region) {
      $p = $region -split ","
      if ($p.Count -lt 4) { Refuse "screen" $null $region "region needs x,y,w,h" }
      try { $x = [int]$p[0]; $y = [int]$p[1]; $w = [int]$p[2]; $h = [int]$p[3] }
      catch { Refuse "screen" $null $region "region needs four numbers: x,y,w,h" }
      $scope = "region $region"
      # A region that contains the whole virtual screen leaks exactly as much
      # as a full-screen capture, even when its bounds extend past it.
      if ($x -le $vs.X -and $y -le $vs.Y -and ($x + $w) -ge ($vs.X + $vs.Width) -and ($y + $h) -ge ($vs.Y + $vs.Height)) {
        $coversAll = $true
        $scope = "region covering the whole screen"
      }
    } elseif (O "window") {
      $captureTarget = Resolve-Window
      $win = Assert-AppAllowed $captureTarget "screen -window"
      if (-not $win -or $win.Width -le 0) { Log-Action "screen" $win "" "error"; Fail "window not found or has no area" }
      if ($win.Minimized) { Fail "the target window is minimized; restore it explicitly with focus and retry the capture" }
      $x = $win.X; $y = $win.Y; $w = $win.Width; $h = $win.Height
      $scope = "window $($win.Process): $($win.Title)"
    } else {
      $coversAll = $true
      $x = $vs.X; $y = $vs.Y; $w = $vs.Width; $h = $vs.Height
    }
    if ($coversAll -and -not (O "confirm")) {
      Refuse "screen" $null $scope "a capture of the whole screen includes every window on the desktop (private chats, mail, password managers) — ask the user, then re-run with -Confirm, or narrow it with -Window / -Region"
    }
    if ($w -le 0 -or $h -le 0) { Refuse "screen" $win $(if ($region) { $region } else { "" }) "empty capture region" }
    $full = [IO.Path]::GetFullPath($path)
    $parent = [IO.Path]::GetDirectoryName($full)
    if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $bmp = $null; $g = $null; $hdc = [IntPtr]::Zero
    try {
      $bmp = New-Object Drawing.Bitmap($w, $h)
      $g = [Drawing.Graphics]::FromImage($bmp)
      $captured = $false
      if ($captureTarget -ne [IntPtr]::Zero) {
        # PrintWindow reads the requested window even when another application
        # covers it. CopyFromScreen cannot: it silently photographs the foreground
        # app and made previous Chrome captures show Orca instead.
        try {
          $hdc = $g.GetHdc()
          $captured = [DW]::PrintWindow($captureTarget, $hdc, 2)
          if (-not $captured) { $captured = [DW]::PrintWindow($captureTarget, $hdc, 0) }
        } finally {
          if ($hdc -ne [IntPtr]::Zero) { $g.ReleaseHdc($hdc); $hdc = [IntPtr]::Zero }
        }
        if ($captured) {
          # Some accelerated windows report PrintWindow success without painting
          # anything. Reject an all-black result instead of saving false proof.
          $uniformBlack = $true
          for ($sy = 0; $sy -lt 8 -and $uniformBlack; $sy++) {
            for ($sx = 0; $sx -lt 8; $sx++) {
              $px = $bmp.GetPixel([int]($sx * ($w - 1) / 7), [int]($sy * ($h - 1) / 7))
              if ($px.R -ne 0 -or $px.G -ne 0 -or $px.B -ne 0) { $uniformBlack = $false; break }
            }
          }
          if ($uniformBlack) { $captured = $false }
        }
        if (-not $captured -and -not [DW]::IsForeground($captureTarget)) {
          Fail "Windows could not capture the occluded target window (PrintWindow failed or returned a blank image); no screenshot was saved. Focus it explicitly and retry"
        }
      }
      if (-not $captured) { $g.CopyFromScreen($x, $y, 0, 0, (New-Object Drawing.Size($w, $h))) }
      $bmp.Save($full, [Drawing.Imaging.ImageFormat]::Png)
    } finally {
      if ($hdc -ne [IntPtr]::Zero -and $g) { $g.ReleaseHdc($hdc) }
      if ($g) { $g.Dispose() }
      if ($bmp) { $bmp.Dispose() }
    }
    Log-Action "screen" $win ("{0} {1}x{2} {3}" -f $full, $w, $h, $scope) "ok"
    Out-Ok ("screen {0} ({1}x{2})" -f $full, $w, $h)
  }
  "click" {
    if (-not $opt.ContainsKey("x") -or -not $opt.ContainsKey("y")) { Fail "click needs -X and -Y (see ""ui"" or ""windows"" first)" }
    $x = N "x"; $y = N "y"
    $target = if (Test-TargetOption) { Resolve-Window } else { [DW]::RootAt($x, $y) }
    $win = Assert-AppAllowed $target "click"
    Assert-ForegroundAllowed "click" $win ("{0},{1}" -f $x, $y)
    if (-not [DW]::Focus($target)) { Fail "click could not focus the target window; no click was sent" }
    Assert-PointTarget $x $y $target "click"
    $at = Ui-ElementAt $x $y
    if ($at) { Assert-Reversible $at.Current.Name "click" $win ("{0},{1}" -f $x, $y) }
    $btn = (O "button" "left").ToLower()
    if ($btn -notin @("left", "right", "middle")) { Fail "click -Button must be left, right or middle" }
    $dbl = (O "double") -ne $null
    [DW]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 80
    Assert-PointTarget $x $y $target "click"
    if (-not [DW]::IsForeground($target)) { Fail "click target lost foreground before the click" }
    $down = [DW]::LEFTDOWN; $up = [DW]::LEFTUP
    if ($btn -eq "right") { $down = [DW]::RIGHTDOWN; $up = [DW]::RIGHTUP }
    if ($btn -eq "middle") { $down = [DW]::MIDDLEDOWN; $up = [DW]::MIDDLEUP }
    $times = 1; if ($dbl) { $times = 2 }
    for ($i = 0; $i -lt $times; $i++) {
      [DW]::mouse_event($down, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 40
      [DW]::mouse_event($up, 0, 0, 0, [IntPtr]::Zero)
      if ($times -gt 1) { Start-Sleep -Milliseconds 90 }
    }
    Log-Action "click" $win ("{0},{1}{2}" -f $x, $y, $(if ($dbl) { " x2" } else { "" })) "ok"
    Out-Ok ("click {0} {1},{2}{3} on {4}" -f $btn, $x, $y, $(if ($dbl) { " x2" } else { "" }), $win.Process)
  }
  "clickui" {
    $target = Resolve-Window
    $win = Assert-AppAllowed $target "clickui"
    $el = Find-UiElement
    $c = $el.Current
    Assert-Reversible $c.Name "clickui" $win $c.Name
    $how = Invoke-Element $el $target
    Log-Action "clickui" $win ("{0} [{1}] via {2}" -f $c.Name, ($c.ControlType.ProgrammaticName -replace "ControlType\.", ""), $how) "ok"
    Out-Ok ("clickui via {0}: {1} [{2}] at {3},{4}" -f $how, $c.Name, ($c.ControlType.ProgrammaticName -replace "ControlType\.", ""), [int]$c.BoundingRectangle.X, [int]$c.BoundingRectangle.Y)
  }
  "move" {
    if (-not $opt.ContainsKey("x") -or -not $opt.ContainsKey("y")) { Fail "move needs -X and -Y" }
    $x = N "x"; $y = N "y"
    Assert-ForegroundAllowed "move" (Get-PointWindowInfo $x $y) ("{0},{1}" -f $x, $y)
    [DW]::SetCursorPos($x, $y) | Out-Null
    Log-Action "move" (Get-PointWindowInfo $x $y) ("{0},{1}" -f $x, $y) "ok"
    Out-Ok ("move {0},{1}" -f $x, $y)
  }
  "drag" {
    foreach ($k in @("x1", "y1", "x2", "y2")) {
      if (-not $opt.ContainsKey($k)) { Fail "drag needs all of -X1 -Y1 -X2 -Y2 (missing -$($k.ToUpper()))" }
    }
    $x1 = N "x1"; $y1 = N "y1"; $x2 = N "x2"; $y2 = N "y2"
    $detail = "{0},{1} -> {2},{3}" -f $x1, $y1, $x2, $y2
    $target = if (Test-TargetOption) { Resolve-Window } else { [DW]::RootAt($x1, $y1) }
    $winA = Assert-AppAllowed $target "drag"
    Assert-ForegroundAllowed "drag" $winA $detail
    if (-not [DW]::Focus($target)) { Fail "drag could not focus the target window; no drag was sent" }
    Assert-PointTarget $x1 $y1 $target "drag start"
    Assert-PointTarget $x2 $y2 $target "drag end"
    [DW]::SetCursorPos($x1, $y1) | Out-Null
    Start-Sleep -Milliseconds 80
    if (-not [DW]::IsForeground($target)) { Fail "drag target lost foreground before the drag" }
    [DW]::mouse_event([DW]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    for ($s = 1; $s -le 12; $s++) {
      [DW]::SetCursorPos([int]($x1 + ($x2 - $x1) * $s / 12), [int]($y1 + ($y2 - $y1) * $s / 12)) | Out-Null
      Start-Sleep -Milliseconds 25
    }
    [DW]::mouse_event([DW]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
    Log-Action "drag" $winA $detail "ok"
    Out-Ok ("drag {0},{1} -> {2},{3} on {4}" -f $x1, $y1, $x2, $y2, $winA.Process)
  }
  "scroll" {
    $amount = [Math]::Abs((N "amount" 3))
    $dir = (O "direction" "down").ToLower()
    if ($dir -ne "up" -and $dir -ne "down") { Fail "scroll -Direction must be up or down" }
    $target = if (Test-TargetOption) { Resolve-Window } else { [DW]::RootAtCursor() }
    $prepared = Prepare-InputWindow "scroll" $target -detail ("{0}x{1}" -f $dir, $amount)
    $target = $prepared.Handle; $win = $prepared.Window
    $p = New-Object DW+POINT
    if (-not [DW]::GetCursorPos([ref]$p)) { Fail "scroll could not read the pointer position" }
    Assert-PointTarget $p.X $p.Y $target "scroll"
    # A positive wheel delta scrolls up; down is negative.
    $delta = if ($dir -eq "up") { $amount } else { -$amount }
    [DW]::mouse_event([DW]::WHEEL, 0, 0, ($delta * 120), [IntPtr]::Zero)
    Log-Action "scroll" $win ("{0}x{1}" -f $dir, $amount) "ok"
    Out-Ok ("scroll {0} {1} on {2}" -f $dir, $amount, $win.Process)
  }
  "key" {
    $combo = O "combo"
    if (-not $combo) { Fail "key needs -Combo, e.g. -Combo ctrl+s" }
    $prepared = Prepare-InputWindow "key" -detail $combo
    $target = $prepared.Handle; $win = $prepared.Window
    $lower = $combo.ToLower()
    if ($lower -match "alt\+f4") {
      if (-not (O "confirm")) { Refuse "key" $win $combo "alt+f4 closes the window (unsaved work is lost) — ask the user, then re-run with -Confirm" }
    }
    if ($lower -match "^(enter|return|delete|del)$") {
      try { $focused = [Windows.Automation.AutomationElement]::FocusedElement; if ($focused) { Assert-Reversible $focused.Current.Name "key" $win $combo } } catch { }
    }
    $parts = $lower -split "\+"
    $ctrl = $false; $alt = $false; $shift = $false; $holdWin = $false
    if ($parts.Count -gt 1) {
      foreach ($p in $parts[0..($parts.Count - 2)]) {
        switch ($p) { "ctrl" { $ctrl = $true }; "control" { $ctrl = $true }; "alt" { $alt = $true }; "shift" { $shift = $true }; "win" { $holdWin = $true } }
      }
    }
    $head = $parts[$parts.Count - 1].Trim()
    $code = 0; $ext = $false
    if ($VKMap.ContainsKey($head)) { $code = $VKMap[$head] }
    elseif ($head -match "^[a-z]$") {
      # Letter/digit virtual keys are layout independent. VkKeyScan('t') is -1
      # on a Russian layout and used to turn Ctrl+T into Shift+VK_FF.
      $code = [byte]([int][char]$head - [int][char]'a' + 0x41)
    }
    elseif ($head -match "^[0-9]$") {
      $code = [byte]([int][char]$head - [int][char]'0' + 0x30)
    }
    elseif ($head.Length -eq 1) {
      $v = [DW]::VkKeyScan($head[0])
      if ($v -eq -1 -or ($v -band 0xFF) -eq 0xFF) { Fail "key '$head' cannot be produced by the active keyboard layout" }
      $code = $v -band 0xFF
      if ((($v -shr 8) -band 1) -eq 1) { $shift = $true }
      if ((($v -shr 8) -band 2) -eq 1) { $ctrl = $true }
      if ((($v -shr 8) -band 4) -eq 1) { $alt = $true }
    } else { Fail "unknown key '$head'" }
    if ($EXTENDED_KEYS -contains $code) { $ext = $true }
    Start-Sleep -Milliseconds 60
    try { [DW]::Key([byte]$code, $shift, $ext, $ctrl, $alt, $holdWin, $target) }
    catch { Fail $_.Exception.Message }
    Log-Action "key" $win $combo "ok"
    Out-Ok ("key {0} on {1}" -f $combo, $win.Process)
  }
  "type" {
    $text = O "text"
    if ($null -eq $text) { Fail "type needs -Text" }
    $prepared = Prepare-InputWindow "type" -detail ("{0} chars" -f $text.Length)
    $target = $prepared.Handle; $win = $prepared.Window
    if ($text -match "[\r\n]" -and -not (O "confirm")) {
      Refuse "type" $win ("{0} chars" -f $text.Length) "type contains a line break, which presses Enter and may submit a form or confirm a dialog — ask the user, then re-run with -Confirm"
    }
    Start-Sleep -Milliseconds 80
    try { $written = [DW]::TypeText($text, $target) }
    catch { Fail $_.Exception.Message }
    Log-Action "type" $win ("{0} chars" -f $written) "ok"
    Out-Ok ("type {0} chars on {1}" -f $written, $win.Process)
  }
  "gettext" {
    if ((O "handle") -or (O "pid") -or (O "match")) {
      $win = Assert-AppAllowed (Resolve-Window) "gettext"
    } else {
      $win = Assert-AppAllowed ([DW]::GetForegroundWindow()) "gettext"
    }
    $el = Find-UiElement
    $p = $null
    $val = ""; $src = "Name"
    if ($el.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$p)) {
      $val = [string]$p.Current.Value; $src = "ValuePattern"
    } else {
      $val = [string]$el.Current.Name; $src = "Name"
    }
    Log-Action "gettext" $win ("{0} chars" -f $val.Length) "ok"
    Out-Obj ([ordered]@{ value = $val; source = $src })
  }
  "settext" {
    if (-not $opt.ContainsKey("value")) { Fail "settext needs -Value" }
    $win = Assert-AppAllowed (Resolve-Window) "settext"
    $el = Find-UiElement
    $p = $null
    if (-not $el.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { Fail "element does not support ValuePattern" }
    $p.SetValue((O "value"))
    Log-Action "settext" $win $el.Current.Name "ok"
    Out-Ok "settext"
  }
  "openurl" {
    $raw = O "url"
    if (-not $raw) { Fail "openurl needs -Url https://…" }
    $uri = $null
    if (-not [Uri]::TryCreate($raw, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @("http", "https")) {
      Fail "openurl accepts only absolute http/https URLs"
    }
    $browser = (O "match" "chrome").ToLower()
    if ($browser -notin @("chrome", "msedge")) { Fail "openurl -Match supports chrome or msedge" }
    $existing = @([DW]::List($false) | Where-Object { $_.Process -eq $browser })
    $winBefore = $null
    if ($existing.Count) {
      $winBefore = Assert-AppAllowed ([IntPtr]$existing[0].Handle) "openurl"
    } elseif (O "force") {
      $script:Forced = $true
    } elseif ((App-Verdict $browser) -eq "deny") {
      Refuse "openurl" $null $browser "app '$browser' is denied in apps.json — the user must allow it there, or re-run with -Force if they agreed"
    }
    $exe = $null
    if ($existing.Count) {
      try { $exe = [Diagnostics.Process]::GetProcessById($existing[0].Pid).MainModule.FileName } catch { }
    }
    if (-not $exe) {
      $relative = if ($browser -eq "chrome") { "Google\Chrome\Application\chrome.exe" } else { "Microsoft\Edge\Application\msedge.exe" }
      foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
        if (-not $root) { continue }
        $candidate = Join-Path $root $relative
        if (Test-Path $candidate) { $exe = $candidate; break }
      }
    }
    if (-not $exe) { Fail "could not locate the $browser executable" }
    # Chrome/Edge route --new-tab to the running instance of the same profile.
    # This is the browser's supported interface, unlike synthetic Ctrl+T plus
    # address-bar keystrokes through a contested foreground window.
    $url = $uri.AbsoluteUri
    Start-Process -FilePath $exe -ArgumentList @("--new-tab", ('"{0}"' -f $url)) | Out-Null
    Start-Sleep -Milliseconds 700
    $after = @([DW]::List($false) | Where-Object { $_.Process -eq $browser -and $_.Visible })
    if (-not $after.Count -and -not $winBefore) { Fail "$browser accepted the command but no visible browser window appeared" }
    $win = if ($after.Count) { Get-WindowInfo ([IntPtr]$after[0].Handle) } else { $winBefore }
    Log-Action "openurl" $win $url "ok"
    Out-Ok ("openurl {0} in {1} (new tab requested; use browser.mjs for DOM verification)" -f $url, $browser)
  }
  "wait" {
    $ms = N "ms" 500
    if ($ms -lt 0) { Fail "wait -Ms must be 0 or greater" }
    Start-Sleep -Milliseconds $ms
    Log-Action "wait" $null ("{0}ms" -f $ms) "ok"
    Out-Ok ("wait {0}ms" -f $ms)
  }
  "clipboard" {
    $mode = (O "mode" "get").ToLower()
    if ($mode -eq "set") {
      $text = O "text"
      if ($null -eq $text) { Fail "clipboard set needs -Text" }
      Set-Clipboard -Value $text
      Log-Action "clipboard set" $null ("{0} chars" -f $text.Length) "ok"
      Out-Ok ("clipboard set {0} chars" -f $text.Length)
    } else {
      if (-not (O "confirm")) {
        Refuse "clipboard get" $null "clipboard" "the clipboard may hold passwords or tokens — ask the user, then re-run with -Confirm"
      }
      $val = [string](Get-Clipboard -Raw)
      Log-Action "clipboard get" $null ("{0} chars" -f $val.Length) "ok"
      Out-Obj ([ordered]@{ text = $val })
    }
  }
  "" { "usage: desktop.ps1 <windows|active|focus|openurl|ui|screen|click|clickui|move|drag|scroll|key|type|gettext|settext|clipboard|wait> [-options]" }
  default { Fail "unknown action '$Action'" }
}
