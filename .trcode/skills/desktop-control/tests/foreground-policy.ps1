# Non-GUI regression: raw input and focus changes are denied before side effects.
$ErrorActionPreference = "Stop"
$driver = Join-Path (Split-Path $PSScriptRoot -Parent) "scripts\desktop.ps1"
$temp = Join-Path ([IO.Path]::GetTempPath()) ("trcode-foreground-policy-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temp | Out-Null
$oldAudit = $env:TRCODE_DESKTOP_AUDIT
$env:TRCODE_DESKTOP_AUDIT = Join-Path $temp "audit.jsonl"

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ForegroundPolicyProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  public struct POINT { public int X, Y; }
}
'@

function Snapshot {
  $p = New-Object ForegroundPolicyProbe+POINT
  [ForegroundPolicyProbe]::GetCursorPos([ref]$p) | Out-Null
  return @([ForegroundPolicyProbe]::GetForegroundWindow().ToInt64(), $p.X, $p.Y)
}
function Invoke-Driver([string[]]$Arguments) {
  $output = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $driver @Arguments 2>&1
  return @($LASTEXITCODE, ((@($output) | ForEach-Object { [string]$_ }) -join "`n"))
}

$before = Snapshot
$cases = @(
  @("focus", @("focus")),
  @("key", @("key", "-Combo", "ctrl+t")),
  @("type", @("type", "-Text", "policy")),
  @("click", @("click", "-X", [string]$before[1], "-Y", [string]$before[2])),
  @("drag", @("drag", "-X1", [string]$before[1], "-Y1", [string]$before[2], "-X2", [string]($before[1] + 5), "-Y2", [string]$before[2])),
  @("scroll", @("scroll", "-Amount", "1")),
  @("move", @("move", "-X", [string]$before[1], "-Y", [string]$before[2]))
)
$failed = 0
try {
  foreach ($case in $cases) {
    $name = $case[0]
    $result = Invoke-Driver $case[1]
    if ($result[0] -ne 1 -or $result[1] -notmatch "would capture the user") {
      Write-Host "FAIL $name was not denied correctly: exit=$($result[0]) $($result[1])"
      $failed++
    } else {
      Write-Host "PASS $name denied without -AllowForeground"
    }
  }
  $after = Snapshot
  if ($before[0] -ne $after[0] -or $before[1] -ne $after[1] -or $before[2] -ne $after[2]) {
    # The person at the machine may switch windows or move the pointer while this
    # probe runs. Every injected action was denied, so external changes are notes,
    # not failures. The refusal text and audit are the regression assertion.
    Write-Host "NOTE foreground/pointer changed externally during the probe; no input call was allowed"
  } else {
    Write-Host "NOTE foreground and pointer stayed unchanged during the probe"
  }
  $lines = @(Get-Content $env:TRCODE_DESKTOP_AUDIT | ForEach-Object { $_ | ConvertFrom-Json })
  $denied = @($lines | Where-Object { $_.status -eq "denied" })
  if ($denied.Count -ne $cases.Count) {
    Write-Host "FAIL audit has $($denied.Count) denied lines, expected $($cases.Count)"
    $failed++
  } else {
    Write-Host "PASS every refusal is audited as denied"
  }
  if ($failed) { exit 1 }
  Write-Host "PASS foreground policy: $($cases.Count + 1) checks"
  exit 0
} finally {
  if ($null -eq $oldAudit) { Remove-Item Env:TRCODE_DESKTOP_AUDIT -ErrorAction SilentlyContinue } else { $env:TRCODE_DESKTOP_AUDIT = $oldAudit }
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
