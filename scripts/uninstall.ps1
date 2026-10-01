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
function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Test-Under($path, $dir) {
  if ([string]::IsNullOrEmpty($path)) { return $false }
  return $path.StartsWith(($dir.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase)
}

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

  # Stop running processes
  $procs = @()
  try {
    foreach ($p in (Get-CimInstance Win32_Process -ErrorAction Stop)) {
      if ($p.Name -ieq 'electron.exe' -and (Test-Under $p.ExecutablePath $InstallDir)) { $procs += $p }
      elseif ($p.Name -ieq 'node.exe' -and $p.CommandLine -and
              $p.CommandLine.IndexOf('legion-core.js', [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
              $p.CommandLine.IndexOf($InstallDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $procs += $p }
    }
  } catch { Say "  (could not list processes: $($_.Exception.Message))" 'Yellow' }
  foreach ($p in $procs) {
    if ($DryRun) { Say "  (dry run) stop PID $($p.ProcessId)" 'DarkGray' }
    else { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  if ($procs.Count -gt 0 -and -not $DryRun) { Start-Sleep -Seconds 2 }

  # Shortcuts
  $links = @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Legion.lnk'),
             (Join-Path ([Environment]::GetFolderPath('Programs')) 'Legion.lnk'))
  foreach ($l in $links) {
    if (Test-Path $l) {
      if ($DryRun) { Say "  (dry run) remove $l" 'DarkGray' } else { Remove-Item -LiteralPath $l -Force; Say "  removed $l" }
    }
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
