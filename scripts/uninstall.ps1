<#
.SYNOPSIS
  Removes Legion: stops it, deletes shortcuts and the install folder. Keeps data unless -Purge.
  Normally started via uninstall.cmd in the install folder. Windows PowerShell 5.1 compatible.
#>
param(
  [string]$InstallDir = '',
  [switch]$Purge,
  [switch]$Yes,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
# uninstall.cmd copies this script and the helper into one temp folder; a source checkout has the helper in lib\.
$procLib = Join-Path $PSScriptRoot 'legion-procs.ps1'
if (-not (Test-Path -LiteralPath $procLib)) { $procLib = Join-Path $PSScriptRoot 'lib\legion-procs.ps1' }
. $procLib
function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }

try {
  if ([string]::IsNullOrWhiteSpace($InstallDir)) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Legion' }
  $InstallDir = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
  $dataDir = if ($env:LEGION_HOME) { $env:LEGION_HOME } else { Join-Path $env:USERPROFILE '.legion' }

  # Safety: only delete a folder that looks like a Legion install.
  if (-not (Test-Path (Join-Path $InstallDir 'legion-core.js')) -and
      -not (Test-Path (Join-Path $InstallDir 'dist\src\bin\legion-core.js')) -and
      -not (Test-Path (Join-Path $InstallDir 'scripts\uninstall.ps1'))) {
    throw "'$InstallDir' does not look like a Legion install; refusing to delete it."
  }

  Say 'Legion uninstall' 'Green'
  Say "  install folder: $InstallDir"
  Say ("  your data     : $dataDir " + $(if ($Purge) { '(will be DELETED)' } else { '(kept)' }))
  if ($DryRun) { Say '  (dry run - nothing will be changed)' 'Yellow' }

  if (-not $Yes -and -not $DryRun) {
    $a = Read-Host 'Remove Legion? [y/N]'
    if ($a -notmatch '^[Yy]') { Say 'Cancelled.' 'Yellow'; exit 0 }
  }
  $doPurge = $false
  if ($Purge) {
    if ($Yes -or $DryRun) { $doPurge = $true }
    else {
      Say "This permanently deletes $dataDir (config, tokens, agents, task history)." 'Red'
      $t = Read-Host 'Type DELETE to confirm'
      if ($t -ceq 'DELETE') { $doPurge = $true } else { Say 'Data will be kept.' 'Yellow' }
    }
  }

  # Stop this install's running processes (matched by what they are, stopped by PID; nothing else is touched)
  $procs = @()
  try { $procs = @(Select-LegionProcesses -Processes @(Get-CimInstance Win32_Process -ErrorAction Stop) -OnlyUnder $InstallDir -SelfPid $PID) }
  catch { Say "  (could not list processes: $($_.Exception.Message))" 'Yellow' }
  if ($procs.Count -gt 0) {
    if ($DryRun) { Say "  (dry run) stop PID $(($procs | ForEach-Object { $_.ProcessId }) -join ', ')" 'DarkGray' }
    else {
      $left = @(Stop-LegionProcesses -Found $procs)
      if ($left.Count -gt 0) { throw "Could not stop Legion (PID $($left -join ', ')); close it and run uninstall again." }
    }
  }

  # Shortcuts (desktop and Start menu). A Legion.lnk that points at another install is left alone.
  $links = @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Legion.lnk'),
             (Join-Path ([Environment]::GetFolderPath('Programs')) 'Legion.lnk'))
  foreach ($l in $links) {
    if (-not (Test-Path -LiteralPath $l)) { continue }
    $target = ''
    try { $target = (New-Object -ComObject WScript.Shell).CreateShortcut($l).TargetPath } catch { $target = '' }
    if ($target -and -not (Test-PathUnder $target $InstallDir)) { Say "  kept $l (it points to $target, not to this install)" 'Yellow'; continue }
    if ($DryRun) { Say "  (dry run) remove $l" 'DarkGray' } else { Remove-Item -LiteralPath $l -Force; Say "  removed $l" }
  }

  # Install folder
  if (Test-Path $InstallDir) {
    if ($DryRun) { Say "  (dry run) remove $InstallDir" 'DarkGray' }
    else {
      Set-Location $env:TEMP   # don't sit inside the folder we delete
      Remove-Item -LiteralPath $InstallDir -Recurse -Force
      Say "  removed $InstallDir"
    }
  }

  if ($doPurge -and (Test-Path $dataDir)) {
    if ($DryRun) { Say "  (dry run) remove $dataDir" 'DarkGray' }
    else { Remove-Item -LiteralPath $dataDir -Recurse -Force; Say "  removed $dataDir" }
  }

  Say 'Legion has been removed.' 'Green'
  if (-not $doPurge) { Say "Your data is still in $dataDir (delete that folder to remove it)." }
} catch {
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
