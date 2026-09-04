<#
.SYNOPSIS
  Register a Windows Scheduled Task that DMs you a slack-waterline digest.

.EXAMPLE
  .\schedule-task.ps1 -Workspace acme -Period day  -Time 08:00
  .\schedule-task.ps1 -Workspace acme -Period week -Time 08:00 -DayOfWeek Monday
  .\schedule-task.ps1 -Workspace acme -Unregister

.NOTES
  Run `node report.mjs --workspace <w> --period <p> --send --dry-run` by hand
  first. A scheduled task that fails silently at 8am is worse than no task.

  The task runs as you, only when you are logged on, and does not wake the
  machine. It reads the token from the workspace's .env, so nothing secret is
  stored in the task definition.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Workspace,
  [ValidateSet('day', 'week')][string]$Period = 'day',
  [string]$Time = '08:00',
  [ValidateSet('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')]
  [string]$DayOfWeek = 'Monday',
  [switch]$Unregister
)

$ErrorActionPreference = 'Stop'

$taskName = "slack-waterline-$Workspace-$Period"

if ($Unregister) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed scheduled task '$taskName'."
  } else {
    Write-Host "No scheduled task named '$taskName'."
  }
  return
}

$scriptsDir = Split-Path -Parent $PSScriptRoot
$reportPath = Join-Path $scriptsDir 'scripts\report.mjs'
if (-not (Test-Path $reportPath)) {
  throw "Cannot find report.mjs at $reportPath — run this from the skill's assets directory."
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node is not on PATH.' }

$arguments = "`"$reportPath`" --workspace $Workspace --period $Period --send"
$action = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory (Join-Path $scriptsDir 'scripts')

$trigger = if ($Period -eq 'week') {
  New-ScheduledTaskTrigger -Weekly -DaysOfWeek $DayOfWeek -At $Time
} else {
  New-ScheduledTaskTrigger -Daily -At $Time
}

# StartWhenAvailable so a missed run (laptop shut) fires on the next wake rather
# than being skipped entirely — a digest an hour late still beats no digest.
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "slack-waterline $Period digest for the '$Workspace' workspace" `
  -Force | Out-Null

Write-Host "Registered '$taskName'."
Write-Host "  $node $arguments"
Write-Host ''
Write-Host 'Test it now with:'
Write-Host "  Start-ScheduledTask -TaskName '$taskName'"
Write-Host 'Remove it with:'
Write-Host "  .\schedule-task.ps1 -Workspace $Workspace -Unregister"
