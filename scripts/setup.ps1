<#
.SYNOPSIS
  Installs (or updates) Legion for the current user. Windows PowerShell 5.1 compatible.
.DESCRIPTION
  Copies the source to %LOCALAPPDATA%\Programs\Legion (override with -InstallDir), installs dependencies,
  builds, creates Desktop + Start-menu shortcuts and writes uninstall.cmd. Re-running updates in place.
.PARAMETER InstallDir  Target folder (default: %LOCALAPPDATA%\Programs\Legion).
.PARAMETER Yes         Don't ask questions (stops a running Legion, launches at the end).
                 Setup is also non-blocking, with the same defaults, when input is redirected (a script, CI,
                 a pipe); in that case it does not launch Legion at the end unless -Yes is given too.
.PARAMETER NoLaunch    Don't offer to launch at the end.
.PARAMETER DryRun      Print what would happen and change nothing.
.PARAMETER NodeOnly    Only make sure a usable Node.js exists (system, or Legion's own copy in <install>\runtime\node), then stop.

Node.js: needs 20.10 or newer (package.json engines). If there is none, setup asks once and then downloads the pinned Node 24 LTS
from nodejs.org into <install>\runtime\node (no admin, no system PATH change). -Yes is the go-ahead for that download.
#>
param(
  [string]$InstallDir = '',
  [switch]$Yes,
  [switch]$NoLaunch,
  [switch]$DryRun,
  [switch]$NodeOnly
)
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\legion-procs.ps1')
. (Join-Path $PSScriptRoot 'lib\safe-io.ps1')
. (Join-Path $PSScriptRoot 'lib\node-bootstrap.ps1')

# No terminal to ask on (stdin redirected, or not a user-interactive session): never block on Read-Host.
$script:NonInteractive = $false
try { $script:NonInteractive = [Console]::IsInputRedirected } catch { $script:NonInteractive = $false }
try { if (-not [Environment]::UserInteractive) { $script:NonInteractive = $true } } catch { $script:NonInteractive = $true }

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Step($m) { Write-Host ''; Write-Host "== $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host ''; Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }
function Ask($q, $default) {
  if ($Yes) { return $true }
  if ($script:NonInteractive) { Say "  ($q -> $(if ($default) { 'yes' } else { 'no' }), no terminal to ask on)" 'DarkGray'; return $default }
  # powershell -NonInteractive makes Read-Host throw; treat that like "no terminal" too.
  $a = ''
  try { $a = Read-Host "$q $(if ($default) { '[Y/n]' } else { '[y/N]' })" }
  catch { Say "  ($q -> $(if ($default) { 'yes' } else { 'no' }), no terminal to ask on)" 'DarkGray'; return $default }
  if ([string]::IsNullOrWhiteSpace($a)) { return $default }
  return ($a -match '^[Yy]')
}
function Invoke-Native($what, [scriptblock]$cmd) {
  if ($DryRun) { Say "  (dry run) $what" 'DarkGray'; return }
  & $cmd
  if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit code $LASTEXITCODE)." }
}

try {
  $src = Get-TrimmedFullPath (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
  if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { Fail 'LOCALAPPDATA is not set; pass -InstallDir.' }
    $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Legion'
  }
  # "C:" and "C:\" are checked as typed: GetFullPath turns a bare "C:" into the current folder of that drive.
  if (Test-DriveRoot $InstallDir) { Fail "Refusing to install into '$InstallDir': that is a drive root." }
  $InstallDir = Get-TrimmedFullPath $InstallDir
  $inPlace = $src.Equals($InstallDir, [System.StringComparison]::OrdinalIgnoreCase)

  Say "Legion setup" 'Green'
  Say "  source : $src"
  Say "  install: $InstallDir"
  if ($DryRun) { Say '  (dry run - nothing will be changed)' 'Yellow' }

  if (-not $inPlace -and ((Test-PathUnder $InstallDir $src) -or (Test-PathUnder $src $InstallDir))) {
    Fail 'The install folder and the source folder must not be inside each other.'
  }

  # robocopy /MIR below deletes everything in the target that is not in the source, so only a new, empty or already-Legion folder is allowed.
  $dataDir = if ($env:LEGION_HOME) { $env:LEGION_HOME } else { Join-Path $env:USERPROFILE '.legion' }
  $verdict = Get-InstallDirVerdict -Dir $InstallDir -UserProfile $env:USERPROFILE -DataDir $dataDir -LegionHome $env:LEGION_HOME
  Say "  install dir check: $(if ($verdict.Ok) { 'OK' } else { 'REFUSED' }) - $($verdict.Reason)" $(if ($verdict.Ok) { 'DarkGray' } else { 'Red' })
  if (-not $verdict.Ok) { Fail "Refusing to install into '$($verdict.Path)': $($verdict.Reason)." }

  # 1) Node.js (20.10+ by package.json engines): a good system Node, else Legion's own pinned copy (asked once, downloaded from nodejs.org).
  Step 'Checking Node.js'
  $nodeRes = Initialize-LegionNode -InstallDir $InstallDir -DryRun:$DryRun `
    -Ask { param($q, $d) Ask $q $d } -Say { param($m, $c) Say $m $c }
  if (-not $nodeRes.Ok) { Say $nodeRes.Message 'Red'; exit 1 }
  if ($nodeRes.NodeDir) {
    # this process only: setup's npm and node come from Legion's copy; the system PATH is never changed
    $env:PATH = $nodeRes.NodeDir + [System.IO.Path]::PathSeparator + $env:PATH
  }
  if (-not $DryRun -and -not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm was not found on PATH (it ships with Node.js; reinstall Node).' }
  if ($NodeOnly) { Say 'Node.js is ready.' 'Green'; exit 0 }

  # 2) Stop a running Legion, from any folder (it holds the port, the data folder and the files being replaced).
  #    Matched by what it is (see scripts\lib\legion-procs.ps1) and stopped by PID. Other node/electron programs are never touched.
  Step 'Checking for a running Legion'
  $running = @()
  try {
    $procs = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    # Never stop the processes that started this setup (e.g. an agent in Legion running setup from a tool call).
    $ancestors = @(Get-AncestorPids -Processes $procs -StartPid $PID)
    $running = @(Select-LegionProcesses -Processes $procs -SelfPid $PID -ExcludePids $ancestors)
    $parents = @(Select-LegionProcesses -Processes $procs -SelfPid $PID | Where-Object { $ancestors -contains $_.ProcessId })
    if ($parents.Count -gt 0) {
      Say "  (leaving PID $(($parents | ForEach-Object { $_.ProcessId }) -join ', ') running: it started this setup. Close Legion yourself if the copy below reports a file in use.)" 'Yellow'
    }
  } catch { Say "  (could not list processes: $($_.Exception.Message))" 'Yellow' }
  if ($running.Count -gt 0) {
    $roots = @($running | ForEach-Object { $_.Root } | Sort-Object -Unique)
    Say "Legion is running ($($running.Count) process(es)) from: $($roots -join ', ')" 'Yellow'
    if ($DryRun) { Say "  (dry run) would stop PID $(($running | ForEach-Object { $_.ProcessId }) -join ', ')" 'DarkGray' }
    elseif (Ask 'Stop it now so the update can proceed?' $true) {
      $left = @(Stop-LegionProcesses -Found $running)
      if ($left.Count -gt 0) { Fail "Could not stop Legion (PID $($left -join ', ')). Close it from the tray icon and run setup again." }
      Say 'Stopped.' 'Green'
    } else { Fail 'Close Legion and run setup again.' }
  } else { Say 'Not running.' 'Green' }

  # 3) Copy the source
  Step 'Copying files'
  if ($inPlace) {
    Say 'Source is already the install folder - skipping copy.' 'Yellow'
  } else {
    if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null }
    $xd = @('node_modules', 'dist', 'dist-ui', '.git', (Join-Path $InstallDir 'runtime'), (Join-Path $InstallDir '.update'), (Join-Path $src 'ui\dev\shots'), (Join-Path $src 'docs\demo'))
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
    # A downloaded release package is already built (dist and dist-ui, no src folder): nothing to compile.
    $prebuilt = (-not (Test-Path -LiteralPath (Join-Path $lockDir 'src'))) -and (Test-Path -LiteralPath (Join-Path $lockDir 'dist\src\bin\legion-core.js'))
    if ($prebuilt) { Say 'Release package: already built, skipping the build.' 'Green' }
    else { Invoke-Native 'npm run build' { npm run build } }
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
      'rem Removes Legion (shortcuts + install folder). Add /purge to also delete your Legion data (%USERPROFILE%\.legion).',
      'setlocal',
      'set "PURGE="',
      'if /i "%~1"=="/purge" set "PURGE=-Purge"',
      'set "TMPU=%TEMP%\legion-uninstall"',
      'if exist "%TMPU%" rd /s /q "%TMPU%" >nul 2>&1',
      'mkdir "%TMPU%"',
      'copy /y "%~dp0scripts\uninstall.ps1" "%TMPU%\uninstall.ps1" >nul',
      'if errorlevel 1 goto copyfail',
      'copy /y "%~dp0scripts\lib\legion-procs.ps1" "%TMPU%\legion-procs.ps1" >nul',
      'if errorlevel 1 goto copyfail',
      'rem One line on purpose: uninstall deletes this very file, and cmd must not read another line from it afterwards.',
      'powershell -NoProfile -ExecutionPolicy Bypass -File "%TMPU%\uninstall.ps1" -InstallDir "%~dp0." %PURGE% & cd /d "%TEMP%" & rd /s /q "%TMPU%" >nul 2>&1 & pause & exit /b 0',
      ':copyfail',
      'echo Could not copy the uninstall script from "%~dp0scripts". Nothing was removed.',
      'echo Run setup.cmd again from your Legion source folder, then run uninstall.cmd again.',
      'cd /d "%TEMP%"',
      'rd /s /q "%TMPU%" >nul 2>&1',
      'pause',
      'exit /b 1'
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

  if (-not $NoLaunch -and -not $DryRun -and -not ($script:NonInteractive -and -not $Yes)) {
    Write-Host ''
    if (Ask 'Launch Legion now?' $true) {
      Start-Process -FilePath $electron -ArgumentList ('"' + $InstallDir + '"') -WorkingDirectory $InstallDir
      Say 'Legion is starting.' 'Green'
    }
  }
} catch {
  Fail $_.Exception.Message
}
