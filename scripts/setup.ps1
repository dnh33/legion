<#
.SYNOPSIS
  Installs (or updates) Legion for the current user. Windows PowerShell 5.1 compatible.
.DESCRIPTION
  Copies the source to %LOCALAPPDATA%\Programs\Legion (override with -InstallDir), installs dependencies,
  builds, creates Desktop + Start-menu shortcuts and writes uninstall.cmd. Re-running updates in place.
.PARAMETER InstallDir  Target folder (default: %LOCALAPPDATA%\Programs\Legion).
.PARAMETER Yes         Don't ask questions (stops a running Legion, launches at the end).
.PARAMETER NoLaunch    Don't offer to launch at the end.
.PARAMETER DryRun      Print what would happen and change nothing.
#>
param(
  [string]$InstallDir = '',
  [switch]$Yes,
  [switch]$NoLaunch,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Step($m) { Write-Host ''; Write-Host "== $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host ''; Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }
function Ask($q, $default) {
  if ($Yes) { return $true }
  $a = Read-Host "$q $(if ($default) { '[Y/n]' } else { '[y/N]' })"
  if ([string]::IsNullOrWhiteSpace($a)) { return $default }
  return ($a -match '^[Yy]')
}
function Invoke-Native($what, [scriptblock]$cmd) {
  if ($DryRun) { Say "  (dry run) $what" 'DarkGray'; return }
  & $cmd
  if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit code $LASTEXITCODE)." }
}
function Test-Under($path, $dir) {
  if ([string]::IsNullOrEmpty($path)) { return $false }
  $d = $dir.TrimEnd('\') + '\'
  return $path.StartsWith($d, [System.StringComparison]::OrdinalIgnoreCase)
}

try {
  $src = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')
  if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { Fail 'LOCALAPPDATA is not set; pass -InstallDir.' }
    $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Legion'
  }
  $InstallDir = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
  $inPlace = $src.Equals($InstallDir, [System.StringComparison]::OrdinalIgnoreCase)

  Say "Legion setup" 'Green'
  Say "  source : $src"
  Say "  install: $InstallDir"
  if ($DryRun) { Say '  (dry run - nothing will be changed)' 'Yellow' }

  if (-not $inPlace -and ((Test-Under $InstallDir $src) -or (Test-Under $src $InstallDir))) {
    Fail 'The install folder and the source folder must not be inside each other.'
  }

  # 1) Node >= 20, npm
  Step 'Checking Node.js'
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Say 'Node.js was not found. Install it with:' 'Red'
    Say '  winget install OpenJS.NodeJS.LTS'
    exit 1
  }
  $ver = (& node -v).TrimStart('v')
  if ([int]($ver.Split('.')[0]) -lt 20) {
    Say "Node $ver is too old (need 20+). Install a newer one with:" 'Red'
    Say '  winget install OpenJS.NodeJS.LTS'
    exit 1
  }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm was not found on PATH (it ships with Node.js; reinstall Node).' }
  Say "Node $ver OK" 'Green'

  # 2) Stop a running Legion that lives in the install dir
  Step 'Checking for a running Legion'
  $running = @()
  try {
    $procs = Get-CimInstance Win32_Process -ErrorAction Stop
    foreach ($p in $procs) {
      if ($p.Name -ieq 'electron.exe' -and (Test-Under $p.ExecutablePath $InstallDir)) { $running += $p }
      elseif ($p.Name -ieq 'node.exe' -and $p.CommandLine -and
              $p.CommandLine.IndexOf('legion-core.js', [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
              $p.CommandLine.IndexOf($InstallDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $running += $p }
    }
  } catch { Say "  (could not list processes: $($_.Exception.Message))" 'Yellow' }
  if ($running.Count -gt 0) {
    Say "Legion is running ($($running.Count) process(es)) from $InstallDir." 'Yellow'
    if ($DryRun) { Say '  (dry run) would stop them' 'DarkGray' }
    elseif (Ask 'Stop it now so the update can proceed?' $true) {
      foreach ($p in $running) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
      Start-Sleep -Seconds 2
      Say 'Stopped.' 'Green'
    } else { Fail 'Close Legion and run setup again.' }
  } else { Say 'Not running.' 'Green' }

  # 3) Copy the source
  Step 'Copying files'
  if ($inPlace) {
    Say 'Source is already the install folder - skipping copy.' 'Yellow'
  } else {
    if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null }
    $xd = @('node_modules', 'dist', 'dist-ui', '.git', (Join-Path $src 'ui\dev\shots'), (Join-Path $src 'docs\demo'))
    $rcArgs = @($src, $InstallDir, '/MIR', '/XD') + $xd + @('/XF', 'uninstall.cmd', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:1')
    if ($DryRun) {
      Say "  (dry run) robocopy $($rcArgs -join ' ')" 'DarkGray'
    } else {
      & robocopy @rcArgs | Out-Null
      if ($LASTEXITCODE -ge 8) { Fail "robocopy failed (exit code $LASTEXITCODE). Is a file in $InstallDir still open?" }
      $global:LASTEXITCODE = 0
      Say 'Files copied.' 'Green'
    }
  }

  # 4) Dependencies, Electron, build
  Step 'Installing dependencies'
  $electron = Join-Path $InstallDir 'node_modules\electron\dist\electron.exe'
  if (-not $DryRun) { Push-Location $InstallDir }
  try {
    $lockDir = $InstallDir
    if ($DryRun) { $lockDir = $src }
    $hasLock = Test-Path (Join-Path $lockDir 'package-lock.json')
    if ($hasLock) { Invoke-Native 'npm ci' { npm ci } } else { Invoke-Native 'npm install' { npm install } }

    if (-not $DryRun -and -not (Test-Path $electron)) {
      Say 'Electron binary missing - fetching it...' 'Yellow'
      Invoke-Native 'install-electron' { npx install-electron --no }
      if (-not (Test-Path $electron)) { Fail 'Could not install the Electron binary (check your network/proxy and retry).' }
    }
    if (-not $DryRun) { Say 'Electron OK' 'Green' }

    Step 'Building'
    Invoke-Native 'npm run build' { npm run build }
  } finally {
    if (-not $DryRun) { Pop-Location }
  }

  # 5) Claude Code (informational)
  Step 'Claude Code'
  if (Get-Command claude -ErrorAction SilentlyContinue) {
    Say 'claude CLI found. Legion uses the Claude sign-in of Claude Code; if not signed in yet, run `claude` and then /login.' 'Green'
  } else {
    Say 'claude CLI not found on PATH (informational). Legion uses the Claude sign-in of Claude Code; install it, run `claude`, then /login.' 'Yellow'
  }

  # 6) Shortcuts + uninstaller
  Step 'Creating shortcuts'
  $desktop = [Environment]::GetFolderPath('Desktop')
  $startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Legion.lnk'
  $links = @((Join-Path $desktop 'Legion.lnk'), $startMenu)
  if ($DryRun) {
    foreach ($l in $links) { Say "  (dry run) shortcut $l -> $electron `"$InstallDir`"" 'DarkGray' }
    Say "  (dry run) write $InstallDir\uninstall.cmd" 'DarkGray'
  } else {
    $sh = New-Object -ComObject WScript.Shell
    foreach ($l in $links) {
      $dir = Split-Path -Parent $l
      if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
      $s = $sh.CreateShortcut($l)
      $s.TargetPath = $electron
      $s.Arguments = '"' + $InstallDir + '"'
      $s.WorkingDirectory = $InstallDir
      $s.IconLocation = (Join-Path $InstallDir 'assets\icon.ico')
      $s.Description = 'Legion'
      $s.Save()
      Say "  $l" 'Green'
    }
    $unCmd = @(
      '@echo off',
      'rem Removes Legion (shortcuts + install folder). Add /purge to also delete %USERPROFILE%\.legion data.',
      'setlocal',
      'set "PURGE="',
      'if /i "%~1"=="/purge" set "PURGE=-Purge"',
      'copy /y "%~dp0scripts\uninstall.ps1" "%TEMP%\legion-uninstall.ps1" >nul',
      'if errorlevel 1 (echo Could not copy the uninstall script. & pause & exit /b 1)',
      'powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\legion-uninstall.ps1" -InstallDir "%~dp0." %PURGE%',
      'pause'
    ) -join "`r`n"
    [System.IO.File]::WriteAllText((Join-Path $InstallDir 'uninstall.cmd'), $unCmd + "`r`n", (New-Object System.Text.ASCIIEncoding))
    Say "  $InstallDir\uninstall.cmd" 'Green'
  }

  # 7) Next steps
  Step 'Done'
  Say "Legion is installed in: $InstallDir" 'Green'
  Say ''
  Say 'Next steps' 'Cyan'
  Say '  1. Launch Legion from the desktop / Start menu shortcut. The first run creates %USERPROFILE%\.legion\config.json.'
  Say '  2. Get a boat.dev API key and put it in config.json under boat.apiKey (or set BOAT_API_KEY).'
  Say '  3. Hook Legion into Claude Code (prints the command with your real token):'
  Say "       cd `"$InstallDir`""
  Say '       npm run mcp-config'
  Say '     (the token exists after the first launch)'
  Say '  Uninstall: run uninstall.cmd in the install folder (add /purge to delete your data too).'

  if (-not $NoLaunch -and -not $DryRun) {
    Write-Host ''
    if (Ask 'Launch Legion now?' $true) {
      Start-Process -FilePath $electron -ArgumentList ('"' + $InstallDir + '"') -WorkingDirectory $InstallDir
      Say 'Legion is starting.' 'Green'
    }
  }
} catch {
  Fail $_.Exception.Message
}
