# Finds Legion's own processes. Dot-sourced by setup.ps1 and uninstall.ps1. Windows PowerShell 5.1 compatible, ASCII only.
#
# Legion is two kinds of process, wherever its folder is (install dir, a source checkout, an old install elsewhere):
#   1. Electron: <root>\node_modules\electron\dist\electron.exe   (main process and its renderer/GPU helpers)
#   2. Core:     node.exe running <root>\dist\src\bin\legion-core.js
# <root> only counts when it really is a Legion folder (RootCheck). Anything else named node.exe or electron.exe
# (VS Code, Discord, another app's Electron, your dev servers) is never matched.

function Test-PathUnder {
  param([string]$Path, [string]$Dir)
  if ([string]::IsNullOrEmpty($Path) -or [string]::IsNullOrEmpty($Dir)) { return $false }
  $d = $Dir.TrimEnd('\') + '\'
  return $Path.StartsWith($d, [System.StringComparison]::OrdinalIgnoreCase) -or
         ($Path.TrimEnd('\')).Equals($Dir.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)
}

# Joins path parts one at a time, so the result is right whatever the separator of the host is.
function Join-PathParts {
  param([string]$Base, [string[]]$Parts)
  $p = $Base
  foreach ($x in $Parts) { $p = Join-Path $p $x }
  return $p
}

# True when <Dir>\package.json parses and its "name" is exactly "legion". The one marker every Legion folder has.
function Test-LegionPackage {
  param([string]$Dir)
  if ([string]::IsNullOrEmpty($Dir)) { return $false }
  $pkg = Join-Path $Dir 'package.json'
  if (-not (Test-Path -LiteralPath $pkg -PathType Leaf)) { return $false }
  try {
    $j = Get-Content -Raw -LiteralPath $pkg -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    return ($null -ne $j) -and ($j.name -ceq 'legion')
  } catch { return $false }
}

# Default marker for "this folder is Legion": package.json named legion, one of the two Electron entry points, and the core entry point
# (built or source). A different Electron+TypeScript app that merely has src\electron\main.ts does not pass.
function Test-LegionRoot {
  param([string]$Root)
  if ([string]::IsNullOrEmpty($Root)) { return $false }
  if (-not (Test-LegionPackage $Root)) { return $false }
  $main = (Test-Path -LiteralPath (Join-PathParts $Root @('dist', 'src', 'electron', 'main.js')) -PathType Leaf) -or
          (Test-Path -LiteralPath (Join-PathParts $Root @('src', 'electron', 'main.ts')) -PathType Leaf)
  if (-not $main) { return $false }
  return (Test-Path -LiteralPath (Join-PathParts $Root @('dist', 'src', 'bin', 'legion-core.js')) -PathType Leaf) -or
         (Test-Path -LiteralPath (Join-PathParts $Root @('src', 'bin', 'legion-core.ts')) -PathType Leaf)
}

# Returns the Legion root a process belongs to, or $null. Pure: no file or process access.
function Get-LegionProcessRoot {
  param([string]$Name, [string]$ExePath, [string]$CommandLine)
  if ($Name -ieq 'electron.exe') {
    if ($ExePath -match '^(?<root>.+?)\\node_modules\\electron\\dist\\electron\.exe$') { return $Matches['root'] }
    return $null
  }
  if ($Name -ieq 'node.exe') {
    if ($CommandLine -match '(?<root>[A-Za-z]:\\[^"]*?)\\dist\\src\\bin\\legion-core\.js(?:["\s]|$)') { return $Matches['root'] }
    return $null
  }
  return $null
}

# Picks the Legion processes out of a list of objects with ProcessId, Name, ExecutablePath, CommandLine.
# -OnlyUnder limits it to one install folder (used by the uninstaller). -SelfPid is never returned.
# -RootCheck decides whether a root really is Legion (tests pass { $true }).
function Select-LegionProcesses {
  param(
    [object[]]$Processes,
    [string]$OnlyUnder = '',
    [int]$SelfPid = 0,
    [scriptblock]$RootCheck = { param($r) Test-LegionRoot $r }
  )
  $out = @()
  foreach ($p in $Processes) {
    if ($null -eq $p) { continue }
    if ([int]$p.ProcessId -eq $SelfPid) { continue }
    $root = Get-LegionProcessRoot -Name $p.Name -ExePath $p.ExecutablePath -CommandLine $p.CommandLine
    if (-not $root) { continue }
    if ($OnlyUnder -and -not (Test-PathUnder $root $OnlyUnder)) { continue }
    if (-not (& $RootCheck $root)) { continue }
    $out += [pscustomobject]@{ ProcessId = [int]$p.ProcessId; Name = $p.Name; Root = $root }
  }
  return $out
}

# Stops them by PID (never by image name) and waits for them to exit. Returns the PIDs still alive.
function Stop-LegionProcesses {
  param([object[]]$Found, [int]$WaitSeconds = 10)
  foreach ($f in $Found) { Stop-Process -Id $f.ProcessId -Force -ErrorAction SilentlyContinue }
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  do {
    $alive = @($Found | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
    if ($alive.Count -eq 0) { break }
    Start-Sleep -Milliseconds 300
  } while ((Get-Date) -lt $deadline)
  return @($alive | ForEach-Object { $_.ProcessId })
}
