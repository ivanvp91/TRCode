# smoke.ps1 - end-to-end smoke test for the desktop-control driver.
#
# Launches the disposable WinForms app (TargetApp.ps1) twice: once as the target
# (the app whose state is asserted) and once as a cover that occludes part of it.
# Every driver call goes through ..\scripts\desktop.ps1 in a separate Windows
# PowerShell process, the same way the skill is used. Only the processes and temp
# files spawned here are touched, and they are removed in finally.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .trcode\skills\desktop-control\tests\smoke.ps1
#
# Prints one PASS line per check and exits 0, or one FAIL line and exit 1 on the
# first failure (the driver command and its output are in the message). The
# desktop may be in use while it runs: every check puts a test window in the
# foreground, so keystrokes typed by whoever sits at the keyboard land in the
# target or the cover. The typing check therefore asserts this run's unique
# marker and treats any other text as baseline, while shortcut, click, drag and
# point-check counters stay exact.
#
# The driver refuses to move the OS pointer, take the foreground or synthesize
# input unless a call passes -AllowForeground, so every focus/key/type/click/
# drag call below carries it: this test intentionally drives the foreground.
# One call is made on purpose without the switch to prove that refusal happens
# before any focus or keystroke.

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$script:SkillRoot = Split-Path $PSScriptRoot -Parent
$script:Driver = Join-Path (Join-Path $script:SkillRoot "scripts") "desktop.ps1"
$script:TargetApp = Join-Path $PSScriptRoot "TargetApp.ps1"
if (-not (Test-Path -LiteralPath $script:Driver)) { throw "driver not found: $($script:Driver)" }
if (-not (Test-Path -LiteralPath $script:TargetApp)) { throw "TargetApp.ps1 not found: $($script:TargetApp)" }

$winPs = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $winPs)) {
  $cmd = Get-Command powershell.exe -ErrorAction SilentlyContinue
  if ($cmd) { $winPs = $cmd.Source }
}
if (-not $winPs -or -not (Test-Path -LiteralPath $winPs)) { throw "Windows PowerShell (powershell.exe) was not found" }
$script:PowerShellExe = $winPs

# Only used to explain a failed `key` check. The driver maps a-z/0-9 to fixed
# virtual-key codes, so those chords are layout independent; every other single
# character it resolves with VkKeyScan and refuses when the active layout cannot
# produce it.
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SmokeLayout {
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint idThread);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int VkKeyScanW(char ch);
}
'@
} catch { }

# ---- helpers -----------------------------------------------------------------
function Quote-Arg([string]$text) {
  if ($text -match '\s') { return '"' + $text + '"' }
  return $text
}

$script:Checks = 0
function Pass([string]$message) {
  $script:Checks++
  Write-Host ("PASS " + $message)
}

# Every driver call is a fresh Windows PowerShell process.
function Invoke-Driver {
  param([Parameter(Mandatory = $true)][string[]]$Argv)
  $display = "desktop.ps1 " + (($Argv | ForEach-Object { Quote-Arg $_ }) -join " ")
  $out = & $script:PowerShellExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script:Driver @Argv 2>&1
  $code = $LASTEXITCODE
  $text = (@($out) | ForEach-Object { [string]$_ }) -join "`n"
  return [pscustomobject]@{ Code = $code; Text = $text.Trim(); Command = $display }
}

function Assert-Code($call, [string]$what) {
  if ($call.Code -ne 0) { throw "$what failed (exit $($call.Code)): $($call.Command)`n$($call.Text)" }
}

function Assert-Ok($call, [string]$what) {
  Assert-Code $call $what
  if ($call.Text -notmatch '(?m)^ok\b') { throw "$what did not confirm with an ok line: $($call.Command)`n$($call.Text)" }
}

function Read-AppState([string]$path) {
  try {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $raw = [IO.File]::ReadAllText($path)
    if (-not $raw.Trim()) { return $null }
    return ($raw | ConvertFrom-Json)
  } catch { return $null }
}

function Get-Snapshot([string]$path, [string]$what) {
  $s = Read-AppState $path
  if ($null -eq $s) { throw "could not read the $what state file: $path" }
  return $s
}

function Wait-AppState {
  param([string]$Path, [string]$What, [scriptblock]$Ready, [int]$TimeoutMs = 30000)
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  $seen = $null
  while ((Get-Date) -lt $deadline) {
    $s = Read-AppState $Path
    if ($null -ne $s) {
      $seen = $s
      try { if (& $Ready $s) { return $s } } catch { }
    }
    Start-Sleep -Milliseconds 120
  }
  $detail = "no readable state file"
  if ($null -ne $seen) { $detail = ($seen | ConvertTo-Json -Compress -Depth 4) }
  throw "timed out after ${TimeoutMs}ms waiting for $What; last state: $detail"
}

function Wait-Counter {
  param([string]$Path, [string]$Field, [long]$Value, [string]$What)
  $deadline = (Get-Date).AddMilliseconds(8000)
  while ((Get-Date) -lt $deadline) {
    $s = Read-AppState $Path
    if ($null -ne $s -and [long]$s.$Field -eq $Value) { return $s }
    Start-Sleep -Milliseconds 100
  }
  $s = Read-AppState $Path
  $now = "<unreadable>"
  if ($null -ne $s) { $now = [string]$s.$Field }
  throw "$What did not reach ${Field}=$Value (now $now)"
}

function Assert-Counter {
  param([string]$Path, [string]$Field, [long]$Value, [string]$What)
  Start-Sleep -Milliseconds 250
  $s = Get-Snapshot $Path $What
  $now = [long]$s.$Field
  if ($now -ne $Value) { throw "$What ${Field} is $now, expected $Value" }
}

function Get-ActiveWindow {
  $call = Invoke-Driver @('active')
  Assert-Code $call "active"
  try { return ($call.Text | ConvertFrom-Json) } catch { throw "active did not return JSON: $($call.Command)`n$($call.Text)" }
}

function Invoke-Focus([long]$Handle, [string]$What) {
  $call = Invoke-Driver @('focus', '-Handle', [string]$Handle, '-AllowForeground')
  Assert-Ok $call "focus $What"
}

# The desktop may be in use while this runs: another app can grab the foreground
# between the focus call and the assertion. Re-focus a few times before failing.
function Focus-Foreground([long]$Handle, [string]$What, [int]$Attempts = 6) {
  $active = $null
  for ($i = 1; $i -le $Attempts; $i++) {
    Invoke-Focus $Handle $What
    $active = Get-ActiveWindow
    if ([long]$active.handle -eq $Handle) { return $active }
    Start-Sleep -Milliseconds 250
  }
  throw ("{0} could not keep the foreground after {1} attempts (active handle 0x{2:X}, window '{3}')" -f
    $What, $Attempts, [long]$active.handle, $active.title)
}

function Test-FocusError($call) {
  return ($call.Text -match 'lost foreground|lost focus|not in the foreground|could not focus')
}

function Get-KeyMappingNote([string]$Key = "t") {
  try {
    $layout = ([long][SmokeLayout]::GetKeyboardLayout(0)) -band 0xFFFF
    if ($Key -match '^[a-z0-9]$') {
      return ("the keyboard layout is 0x{0:X4}; a-z and 0-9 map to fixed virtual keys, so the layout cannot break this chord" -f $layout)
    }
    if ([SmokeLayout]::VkKeyScanW([char]$Key) -lt 0) {
      return ("the keyboard layout 0x{0:X4} cannot produce '{1}' and the driver refuses such keys instead of sending a bogus one" -f $layout, $Key)
    }
    return ("the keyboard layout is 0x{0:X4}" -f $layout)
  } catch {
    return "the keyboard layout could not be queried"
  }
}

# One action that stops before doing anything when the foreground was stolen.
# Those aborts are safe to repeat; any other refusal is returned to the caller.
function Invoke-InputAction {
  param([scriptblock]$Action, [string]$What, [int]$Attempts = 4)
  $call = $null
  for ($i = 1; $i -le $Attempts; $i++) {
    $call = & $Action
    if ($call.Code -eq 0) { return $call }
    if (-not (Test-FocusError $call)) { return $call }
    Start-Sleep -Milliseconds 300
  }
  return $call
}

function Test-PointInRect([int]$X, [int]$Y, $Rect) {
  return ($X -ge [int]$Rect.x -and $X -le ([int]$Rect.x + [int]$Rect.width) -and
          $Y -ge [int]$Rect.y -and $Y -le ([int]$Rect.y + [int]$Rect.height))
}

function Test-SegmentEntersRect([int]$X1, [int]$Y1, [int]$X2, [int]$Y2, $Rect) {
  for ($i = 0; $i -le 40; $i++) {
    $x = [int]($X1 + ($X2 - $X1) * $i / 40.0)
    $y = [int]($Y1 + ($Y2 - $Y1) * $i / 40.0)
    if (Test-PointInRect $x $y $Rect) { return "yes at $x,$y" }
  }
  return ""
}

function Get-WindowByHandle([long]$Handle, [string]$Filter) {
  $call = Invoke-Driver @('windows', '-Filter', $Filter)
  Assert-Code $call "windows -Filter $Filter"
  $rows = @()
  try { $rows = @($call.Text | ConvertFrom-Json) } catch { throw "windows did not return JSON: $($call.Command)`n$($call.Text)" }
  foreach ($row in $rows) {
    if ([long]$row.handle -eq $Handle) { return $row }
  }
  return $null
}

function Start-TestApp {
  param([string]$StatePath, [string]$Title, [int]$X, [int]$Y, [int]$Width = 0, [int]$Height = 0)
  $argv = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Quote-Arg $script:TargetApp),
    '-StatePath', (Quote-Arg $StatePath), '-Title', (Quote-Arg $Title), '-X', [string]$X, '-Y', [string]$Y)
  if ($Width -gt 0) { $argv += @('-Width', [string]$Width) }
  if ($Height -gt 0) { $argv += @('-Height', [string]$Height) }
  return (Start-Process -FilePath $script:PowerShellExe -ArgumentList ($argv -join ' ') -PassThru)
}

# ---- setup: temp home for state files, screenshots and the audit log ---------
$stamp = [Guid]::NewGuid().ToString("N").Substring(0, 10)
$script:TempDir = Join-Path ([IO.Path]::GetTempPath()) ("trcode-desktop-smoke-" + $stamp)
New-Item -ItemType Directory -Force -Path $script:TempDir | Out-Null
$script:TargetStatePath = Join-Path $script:TempDir "target-state.json"
$script:CoverStatePath = Join-Path $script:TempDir "cover-state.json"
$pngPath = Join-Path $script:TempDir "target-window.png"

# Keep the user's real audit log untouched; the driver honours this variable.
$script:PrevAudit = $env:TRCODE_DESKTOP_AUDIT
$env:TRCODE_DESKTOP_AUDIT = Join-Path $script:TempDir "audit.jsonl"

$script:Apps = @()
$script:BodyComplete = $false
$exitCode = 0

$targetTitle = "trcode-smoke-target-$stamp"
$coverTitle = "trcode-smoke-cover-$stamp"
$typed = "smoke-$stamp-ok"

try {
  # ---- launch the target and wait until its window reports a real handle -----
  $script:TargetProc = Start-TestApp -StatePath $script:TargetStatePath -Title $targetTitle -X 80 -Y 80
  $script:Apps += $script:TargetProc
  $targetState = Wait-AppState -Path $script:TargetStatePath -What "the target app window" -Ready {
    param($s)
    [long]$s.handle -ne 0 -and [long]$s.pid -ne 0 -and
    [long]$s.buttonX -ne 0 -and [long]$s.buttonY -ne 0 -and [long]$s.dragX1 -ne 0 -and [long]$s.dragX2 -ne 0
  }
  $targetHandle = [long]$targetState.handle
  if ([long]$targetState.pid -ne $script:TargetProc.Id) {
    throw "the target state reports pid $($targetState.pid), but the spawned process is $($script:TargetProc.Id)"
  }
  $targetRect = Get-WindowByHandle $targetHandle $targetTitle
  if ($null -eq $targetRect) { throw "the driver's windows listing has no target window (handle 0x$('{0:X}' -f $targetHandle))" }
  if ([int]$targetRect.width -le 0 -or [int]$targetRect.height -le 0) {
    throw "the target window has no area: $($targetRect.width)x$($targetRect.height)"
  }

  # ---- launch a cover that straddles the target's right edge -----------------
  # The cover must not sit over the button or the drag path, so both targeted
  # clicks and the targeted drag can still reach the target underneath.
  $coverWidth = 380
  $coverHeight = [Math]::Min(300, [Math]::Max(200, [int]([int]$targetRect.height / 2)))
  $coverX = [int]$targetRect.x + [int]$targetRect.width - 160
  $coverY = [int]$targetRect.y + [int]([int]$targetRect.height / 4)
  $script:CoverProc = Start-TestApp -StatePath $script:CoverStatePath -Title $coverTitle -X $coverX -Y $coverY -Width $coverWidth -Height $coverHeight
  $script:Apps += $script:CoverProc
  $coverState = Wait-AppState -Path $script:CoverStatePath -What "the cover app window" -Ready {
    param($s)
    [long]$s.handle -ne 0 -and [long]$s.pid -ne 0
  }
  $coverHandle = [long]$coverState.handle
  if ([long]$coverState.pid -ne $script:CoverProc.Id) {
    throw "the cover state reports pid $($coverState.pid), but the spawned process is $($script:CoverProc.Id)"
  }
  if ($coverHandle -eq $targetHandle) { throw "the cover and the target resolved to the same window handle" }
  $coverRect = Get-WindowByHandle $coverHandle $coverTitle
  if ($null -eq $coverRect) { throw "the driver's windows listing has no cover window (handle 0x$('{0:X}' -f $coverHandle))" }

  # ---- geometry contract the checks below rely on ----------------------------
  $overlapW = [Math]::Min([int]$targetRect.x + [int]$targetRect.width, [int]$coverRect.x + [int]$coverRect.width) -
              [Math]::Max([int]$targetRect.x, [int]$coverRect.x)
  $overlapH = [Math]::Min([int]$targetRect.y + [int]$targetRect.height, [int]$coverRect.y + [int]$coverRect.height) -
              [Math]::Max([int]$targetRect.y, [int]$coverRect.y)
  if ($overlapW -lt 60 -or $overlapH -lt 60) {
    throw "test setup: the cover ($($coverRect.x),$($coverRect.y) $($coverRect.width)x$($coverRect.height)) does not occlude the target ($($targetRect.x),$($targetRect.y) $($targetRect.width)x$($targetRect.height))"
  }
  if (Test-PointInRect ([int]$targetState.buttonX) ([int]$targetState.buttonY) $coverRect) {
    throw "test setup: the cover hides the target's button at $($targetState.buttonX),$($targetState.buttonY)"
  }
  $dragStart = Test-PointInRect ([int]$targetState.dragX1) ([int]$targetState.dragY1) $coverRect
  $dragEnd = Test-PointInRect ([int]$targetState.dragX2) ([int]$targetState.dragY2) $coverRect
  if ($dragStart -or $dragEnd) { throw "test setup: the cover hides a drag endpoint" }
  $dragCross = Test-SegmentEntersRect ([int]$targetState.dragX1) ([int]$targetState.dragY1) ([int]$targetState.dragX2) ([int]$targetState.dragY2) $coverRect
  if ($dragCross) { throw "test setup: the cover crosses the drag path ($dragCross)" }

  # A point that belongs to the cover and (after the driver raises the target)
  # is still not part of the target window: the overhang past its right edge.
  $negativeX = [int]$coverRect.x + [int]$coverRect.width - 40
  $negativeY = [int]$coverRect.y + [int]([int]$coverRect.height / 2)
  if (-not (Test-PointInRect $negativeX $negativeY $coverRect)) { throw "test setup: the negative click point is outside the cover" }
  if (Test-PointInRect $negativeX $negativeY $targetRect) { throw "test setup: the negative click point is inside the target window" }

  Pass ("target window up: handle 0x{0:X} pid {1} at {2},{3} {4}x{5}" -f $targetHandle, $script:TargetProc.Id,
    $targetRect.x, $targetRect.y, $targetRect.width, $targetRect.height)
  Pass ("cover window up: handle 0x{0:X} at {1},{2} {3}x{4}, overlapping the target" -f $coverHandle,
    $coverRect.x, $coverRect.y, $coverRect.width, $coverRect.height)

  # ---- 1. Ctrl+T reaches the target while the cover was in front -------------
  Focus-Foreground $coverHandle "the cover" | Out-Null
  Assert-Counter $script:TargetStatePath 'shortcuts' 0 "target shortcuts"

  # ---- 1a. the same chord is refused when the call does not ask for it ------
  $gatedCall = Invoke-Driver @('key', '-Combo', 'ctrl+t', '-Handle', [string]$targetHandle)
  if ($gatedCall.Code -ne 1) {
    throw "key without -AllowForeground was not refused (exit $($gatedCall.Code)): $($gatedCall.Command)`n$($gatedCall.Text)"
  }
  if ($gatedCall.Text -notmatch 'would capture the user') {
    throw "the refusal did not explain that foreground control needs an explicit opt-in: $($gatedCall.Command)`n$($gatedCall.Text)"
  }
  Assert-Counter $script:TargetStatePath 'shortcuts' 0 "target shortcuts"
  $gatedAudit = @()
  if ($env:TRCODE_DESKTOP_AUDIT -and (Test-Path -LiteralPath $env:TRCODE_DESKTOP_AUDIT)) {
    $gatedAudit = @(Get-Content -LiteralPath $env:TRCODE_DESKTOP_AUDIT | Where-Object { $_ -match '"action":\s*"key"' })
  }
  $lastAudit = $null
  if ($gatedAudit.Count) { try { $lastAudit = $gatedAudit[-1] | ConvertFrom-Json } catch { $lastAudit = $null } }
  if ($null -eq $lastAudit -or ([string]$lastAudit.status) -ne 'denied') {
    throw "the refused key call was not audited as denied (log: $env:TRCODE_DESKTOP_AUDIT)"
  }
  Pass "key: without -AllowForeground refused before any focus or keystroke, and audited as denied"

  $keyCall = Invoke-InputAction -What "key ctrl+t" -Action {
    Invoke-Driver @('key', '-Combo', 'ctrl+t', '-Handle', [string]$targetHandle, '-AllowForeground')
  }
  Assert-Ok $keyCall "key ctrl+t to the target"
  Wait-Counter $script:TargetStatePath 'shortcuts' 1 ("target shortcuts (ctrl+t; {0})" -f (Get-KeyMappingNote 't')) | Out-Null
  Assert-Counter $script:CoverStatePath 'shortcuts' 0 "cover shortcuts"
  Pass "key: ctrl+t reached the target while the cover held the foreground"

  # ---- 2. typing reaches the target only -------------------------------------
  # Someone may be typing at this desktop: keys pressed while a test window holds
  # the foreground land in its text box, and type aborts when another window grabs
  # the foreground. Compare against a baseline snapshot instead of demanding an
  # empty field, and keep asserting that this run's marker arrives complete: the
  # loop only exits when the field is exactly baseline + marker.
  $baseline = [string](Get-Snapshot $script:TargetStatePath "target").text
  $typeAttempts = 0
  while ($true) {
    $typeAttempts++
    Focus-Foreground $coverHandle "the cover" | Out-Null
    $current = [string](Get-Snapshot $script:TargetStatePath "target").text
    $want = $baseline + $typed
    if (-not $want.StartsWith($current)) {
      # foreign characters moved the field on; start again from what is there
      if ($typeAttempts -ge 5) { throw "the target's text box holds '$current', expected '$want'" }
      $baseline = $current
      Start-Sleep -Milliseconds 300
      continue
    }
    if ($current.Length -eq $want.Length) { break }
    $rest = $want.Substring($current.Length)
    $typeCall = Invoke-Driver @('type', '-Text', $rest, '-Handle', [string]$targetHandle, '-AllowForeground')
    if ($typeCall.Code -eq 0) { continue }
    if (-not (Test-FocusError $typeCall)) { Assert-Ok $typeCall "type into the target" }
    if ($typeAttempts -ge 5) { Assert-Ok $typeCall "type into the target" }
    Start-Sleep -Milliseconds 300
  }
  Start-Sleep -Milliseconds 250
  $targetState = Get-Snapshot $script:TargetStatePath "target"
  if (-not ([string]$targetState.text).Contains($typed)) {
    throw "the target's text box holds '$($targetState.text)', which no longer contains '$typed'"
  }
  $coverState = Get-Snapshot $script:CoverStatePath "cover"
  if (([string]$coverState.text).Contains($typed)) {
    throw "typing leaked into the cover window: '$($coverState.text)'"
  }
  Pass "typing: '$typed' reached the target and not the cover"

  # ---- 3. a targeted click increments only the target ------------------------
  Focus-Foreground $coverHandle "the cover" | Out-Null
  $clickCall = Invoke-InputAction -What "click on the target's button" -Action {
    Invoke-Driver @('click', '-X', [string][int]$targetState.buttonX, '-Y', [string][int]$targetState.buttonY, '-Handle', [string]$targetHandle, '-AllowForeground')
  }
  Assert-Ok $clickCall "click on the target's button"
  Wait-Counter $script:TargetStatePath 'clicks' 1 "target clicks" | Out-Null
  Assert-Counter $script:CoverStatePath 'clicks' 0 "cover clicks"
  Pass "click: one click on the target's button counted only on the target"

  # ---- 4. a click on the target handle but over the cover is refused ---------
  Focus-Foreground $coverHandle "the cover" | Out-Null
  $badCall = Invoke-InputAction -What "misplaced click" -Action {
    Invoke-Driver @('click', '-X', [string]$negativeX, '-Y', [string]$negativeY, '-Handle', [string]$targetHandle, '-AllowForeground')
  }
  if ($badCall.Code -ne 1) {
    throw "a click at $negativeX,$negativeY (over the cover) with the target handle was not refused (exit $($badCall.Code)): $($badCall.Command)`n$($badCall.Text)"
  }
  if ($badCall.Text -notmatch 'not over the target window') {
    throw "the refusal did not explain that the point is not over the target: $($badCall.Command)`n$($badCall.Text)"
  }
  Assert-Counter $script:TargetStatePath 'clicks' 1 "target clicks"
  Assert-Counter $script:CoverStatePath 'clicks' 0 "cover clicks"
  Pass "click: a point over the cover is refused with exit 1 and moved no counter"

  # ---- 5. a targeted drag increments the target only -------------------------
  Focus-Foreground $coverHandle "the cover" | Out-Null
  $dragCall = Invoke-InputAction -What "drag on the target's canvas" -Action {
    Invoke-Driver @('drag', '-X1', [string][int]$targetState.dragX1, '-Y1', [string][int]$targetState.dragY1,
      '-X2', [string][int]$targetState.dragX2, '-Y2', [string][int]$targetState.dragY2, '-Handle', [string]$targetHandle, '-AllowForeground')
  }
  Assert-Ok $dragCall "drag on the target's canvas"
  Wait-Counter $script:TargetStatePath 'drags' 1 "target drags" | Out-Null
  Assert-Counter $script:CoverStatePath 'drags' 0 "cover drags"
  Pass "drag: the drag counted only on the target"

  # ---- 6. the occluded target can still be captured, cover keeps the front ---
  $screenAttempts = 0
  while ($true) {
    $screenAttempts++
    Focus-Foreground $coverHandle "the cover" | Out-Null
    $screenCall = Invoke-Driver @('screen', '-Window', '-Handle', [string]$targetHandle, '-Path', $pngPath)
    Assert-Ok $screenCall "screen -Window -Handle <target>"
    $active = Get-ActiveWindow
    if ([long]$active.handle -eq $coverHandle) { break }
    if ([long]$active.handle -eq $targetHandle) {
      throw "screen -Window moved the foreground to the target; the cover must keep it"
    }
    if ($screenAttempts -ge 3) {
      throw ("the cover lost the foreground to '{0}' (0x{1:X}) right after the capture" -f $active.title, [long]$active.handle)
    }
    Start-Sleep -Milliseconds 300
  }
  if (-not (Test-Path -LiteralPath $pngPath)) { throw "screen reported success but wrote no file: $($screenCall.Command)" }
  $sizeMatch = [regex]::Match($screenCall.Text, '\((\d+)x(\d+)\)')
  if (-not $sizeMatch.Success) { throw "screen did not report a capture size: $($screenCall.Command)`n$($screenCall.Text)" }
  $image = $null
  try {
    $image = [Drawing.Image]::FromFile($pngPath)
    $pngWidth = $image.Width
    $pngHeight = $image.Height
  } finally {
    if ($image) { $image.Dispose() }
  }
  if ($pngWidth -ne [int]$targetRect.width -or $pngHeight -ne [int]$targetRect.height) {
    throw "the capture is ${pngWidth}x${pngHeight}, but the target window is $($targetRect.width)x$($targetRect.height)"
  }
  if ([int]$sizeMatch.Groups[1].Value -ne $pngWidth -or [int]$sizeMatch.Groups[2].Value -ne $pngHeight) {
    throw "screen reported $($sizeMatch.Groups[0].Value) but the PNG is ${pngWidth}x${pngHeight}"
  }
  Pass ("screen: captured the occluded target at {0}x{1} and left the cover in front" -f $pngWidth, $pngHeight)

  $script:BodyComplete = $true
  Write-Host ("PASS smoke test: {0} checks, no failures" -f $script:Checks)
} catch {
  $exitCode = 1
  Write-Host ("FAIL " + $_.Exception.Message)
} finally {
  # ---- cleanup: only the processes spawned here and the temp directory ------
  foreach ($process in $script:Apps) {
    if ($null -eq $process) { continue }
    try {
      if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction Stop }
    } catch { }
    try { $process.WaitForExit(3000) | Out-Null } catch { }
  }
  if ($null -eq $script:PrevAudit) {
    Remove-Item Env:TRCODE_DESKTOP_AUDIT -ErrorAction SilentlyContinue
  } else {
    $env:TRCODE_DESKTOP_AUDIT = $script:PrevAudit
  }
  for ($i = 0; $i -lt 6; $i++) {
    if (-not (Test-Path -LiteralPath $script:TempDir)) { break }
    try { Remove-Item -LiteralPath $script:TempDir -Recurse -Force -ErrorAction Stop } catch { Start-Sleep -Milliseconds 200 }
  }
  $leftProcesses = @($script:Apps | Where-Object { $null -ne $_ -and -not $_.HasExited }).Count
  $leftFiles = Test-Path -LiteralPath $script:TempDir
  if ($leftProcesses -gt 0 -or $leftFiles) {
    Write-Host ("FAIL cleanup: $leftProcesses process(es) still running, temp directory exists=$leftFiles ($($script:TempDir))")
    $exitCode = 1
  } elseif ($script:BodyComplete) {
    Write-Host ("PASS cleanup: {0} spawned process(es) stopped and the temp directory removed" -f $script:Apps.Count)
  }
}
exit $exitCode
