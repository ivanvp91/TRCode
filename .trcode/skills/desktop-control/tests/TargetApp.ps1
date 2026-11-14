param(
  [Parameter(Mandatory = $true)][string]$StatePath,
  [string]$Title = "trcode-desktop-target",
  [int]$X = 80,
  [int]$Y = 80,
  [int]$Width = 760,
  [int]$Height = 560
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TestDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[TestDpi]::SetProcessDPIAware() | Out-Null

$state = [ordered]@{
  handle = 0
  pid = $PID
  text = ""
  shortcuts = 0
  clicks = 0
  drags = 0
  buttonX = 0
  buttonY = 0
  dragX1 = 0
  dragY1 = 0
  dragX2 = 0
  dragY2 = 0
}
function Write-State {
  [IO.File]::WriteAllText($StatePath, (ConvertTo-Json $state -Compress), [Text.UTF8Encoding]::new($false))
}

$form = New-Object Windows.Forms.Form
$form.Text = $Title
$form.StartPosition = "Manual"
$form.Location = New-Object Drawing.Point($X, $Y)
$form.Size = New-Object Drawing.Size($Width, $Height)
$form.TopMost = $false

$text = New-Object Windows.Forms.TextBox
$text.Location = New-Object Drawing.Point(20, 30)
$text.Size = New-Object Drawing.Size(500, 30)
$form.Controls.Add($text)

$button = New-Object Windows.Forms.Button
$button.Text = "Increment"
$button.Location = New-Object Drawing.Point(20, 90)
$button.Size = New-Object Drawing.Size(160, 42)
$form.Controls.Add($button)

$canvas = New-Object Windows.Forms.Panel
$canvas.BackColor = [Drawing.Color]::White
$canvas.BorderStyle = "FixedSingle"
$canvas.Location = New-Object Drawing.Point(20, 160)
$canvas.Size = New-Object Drawing.Size(680, 320)
$form.Controls.Add($canvas)

$script:drawn = New-Object 'System.Collections.Generic.List[object]'
$script:from = [Drawing.Point]::Empty
$script:drawing = $false

$text.add_KeyDown({
  if ($_.Control -and $_.KeyCode -eq [Windows.Forms.Keys]::T) {
    $_.SuppressKeyPress = $true
    $state.shortcuts++
    Write-State
  }
})
$text.add_TextChanged({ $state.text = $text.Text; Write-State })
$button.add_Click({ $state.clicks++; Write-State })
$canvas.add_MouseDown({
  if ($_.Button -eq [Windows.Forms.MouseButtons]::Left) {
    $script:drawing = $true
    $script:from = $_.Location
  }
})
$canvas.add_MouseMove({
  if ($script:drawing) {
    $script:drawn.Add(@($script:from, $_.Location))
    $script:from = $_.Location
    $canvas.Invalidate()
  }
})
$canvas.add_MouseUp({
  if ($script:drawing) {
    $script:drawing = $false
    $state.drags++
    Write-State
  }
})
$canvas.add_Paint({
  $pen = New-Object Drawing.Pen([Drawing.Color]::RoyalBlue, 3)
  try {
    foreach ($line in $script:drawn) { $_.Graphics.DrawLine($pen, $line[0], $line[1]) }
  } finally { $pen.Dispose() }
})
$form.add_Shown({
  $state.handle = $form.Handle.ToInt64()
  $p = $button.PointToScreen((New-Object Drawing.Point([int]($button.Width / 2), [int]($button.Height / 2))))
  $state.buttonX = $p.X; $state.buttonY = $p.Y
  $a = $canvas.PointToScreen((New-Object Drawing.Point(100, 100)))
  $b = $canvas.PointToScreen((New-Object Drawing.Point(500, 220)))
  $state.dragX1 = $a.X; $state.dragY1 = $a.Y
  $state.dragX2 = $b.X; $state.dragY2 = $b.Y
  $text.Focus() | Out-Null
  Write-State
})

Write-State
[Windows.Forms.Application]::Run($form)
