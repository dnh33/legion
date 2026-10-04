# Finds Legion's own processes. Dot-sourced by setup.ps1 and uninstall.ps1. Windows PowerShell 5.1 compatible, ASCII only.
#
# Legion is two kinds of process, wherever its folder is (install dir, a source checkout, an old install elsewhere):
#   1. Electron: <root>\node_modules\electron\dist\electron.exe   (main process and its renderer/GPU helpers)
#      or, in a prebuilt package, <root>\runtime\electron\electron.exe (which is also what runs the core, in node mode)
#   2. Core:     node.exe running <root>\dist\src\bin\legion-core.js
# <root> only counts when it really is a Legion folder (RootCheck). Anything else named node.exe or electron.exe
# (VS Code, Discord, another app's Electron, your dev servers) is never matched.

function Test-PathUnder {
  param([string]$Path, [string]$Dir)
  if ([string]::IsNullOrEmpty($Path) -or [string]::IsNullOrEmpty($Dir)) { return $false }
  $p = $Path.Replace('/', '\')
  $dd = $Dir.Replace('/', '\').TrimEnd('\')
  $d = $dd + '\'
  return $p.StartsWith($d, [System.StringComparison]::OrdinalIgnoreCase) -or
         ($p.TrimEnd('\')).Equals($dd, [System.StringComparison]::OrdinalIgnoreCase)
}

# GetFullPath, minus a trailing separator - but a drive root keeps its backslash ("C:\" stays "C:\", never the drive-relative "C:").
function Get-TrimmedFullPath {
  param([string]$Path)
  $full = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetPathRoot($full)
  $t = $full.TrimEnd('\', '/')
  if ($t.Length -lt $root.Length) { return $root }
  return $t
}

# True for "C:", "C:\", "c:/" and for whatever the host calls a filesystem root.
function Test-DriveRoot {
  param([string]$Path)
  if ([string]::IsNullOrEmpty($Path)) { return $false }
  if ($Path -match '^[A-Za-z]:[\\/]*$') { return $true }
  $r = ''
  try { $r = [System.IO.Path]::GetPathRoot($Path) } catch { $r = '' }
  return (-not [string]::IsNullOrEmpty($r)) -and ($Path.TrimEnd('\', '/') -ieq $r.TrimEnd('\', '/'))
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
    if ($ExePath -match '^(?<root>.+?)\\runtime\\electron\\electron\.exe$') { return $Matches['root'] }
    return $null
  }
  if ($Name -ieq 'node.exe') {
    if ($CommandLine -match '(?<root>[A-Za-z]:\\[^"]*?)\\dist\\src\\bin\\legion-core\.js(?:["\s]|$)') { return $Matches['root'] }
    return $null
  }
  return $null
}

# The chain of parent PIDs above StartPid (parent, grandparent, ...), from a list of objects with ProcessId and ParentProcessId.
# Setup must not stop the Legion process that started it (an agent running setup from a tool call). Stops at a loop or a missing parent.
# Returns $null for an empty chain; callers wrap the call in @().
function Get-AncestorPids {
  param([object[]]$Processes, [int]$StartPid)
  $parent = @{}
  foreach ($p in $Processes) {
    if ($null -eq $p -or $null -eq $p.ProcessId -or $null -eq $p.ParentProcessId) { continue }
    $parent[[int]$p.ProcessId] = [int]$p.ParentProcessId
  }
  $chain = @()
  $cur = $StartPid
  for ($i = 0; $i -lt 64; $i++) {
    if (-not $parent.ContainsKey($cur)) { break }
    $next = $parent[$cur]
    if ($next -le 0 -or $next -eq $StartPid -or ($chain -contains $next)) { break }
    $chain += $next
    $cur = $next
  }
  return $chain
}

# Picks the Legion processes out of a list of objects with ProcessId, Name, ExecutablePath, CommandLine.
# -OnlyUnder limits it to one install folder (used by the uninstaller). -SelfPid and -ExcludePids (e.g. the ancestors of this
# script, see Get-AncestorPids) are never returned. Returns $null when nothing matches; callers wrap the call in @().
# -RootCheck decides whether a root really is Legion (tests pass { $true }).
function Select-LegionProcesses {
  param(
    [object[]]$Processes,
    [string]$OnlyUnder = '',
    [int]$SelfPid = 0,
    [int[]]$ExcludePids = @(),
    [scriptblock]$RootCheck = { param($r) Test-LegionRoot $r }
  )
  $out = @()
  foreach ($p in $Processes) {
    if ($null -eq $p) { continue }
    if ([int]$p.ProcessId -eq $SelfPid) { continue }
    if ($ExcludePids -contains [int]$p.ProcessId) { continue }
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

# Decides whether setup may mirror (robocopy /MIR, which DELETES everything else in the target) into -Dir.
# Returns @{ Ok; Reason; Path }. Refuses: a drive root, the user profile folder (or a folder that contains it), the Legion data folder or
# LEGION_HOME (or a folder that contains them or sits inside the data folder), a file, a git checkout, and any non-empty folder that is not
# already a Legion install (package.json named legion). A missing or empty folder is fine.
function Get-InstallDirVerdict {
  param([string]$Dir, [string]$UserProfile = '', [string]$DataDir = '', [string]$LegionHome = '')
  if ([string]::IsNullOrWhiteSpace($Dir)) { return [pscustomobject]@{ Ok = $false; Reason = 'no install folder given'; Path = '' } }
  if (Test-DriveRoot $Dir) { return [pscustomobject]@{ Ok = $false; Reason = 'that is a drive root'; Path = $Dir } }
  $full = Get-TrimmedFullPath $Dir
  if (Test-DriveRoot $full) { return [pscustomobject]@{ Ok = $false; Reason = 'that is a drive root'; Path = $full } }

  $guards = @(
    @{ Label = 'your user profile folder'; Path = $UserProfile; AlsoInside = $false },
    @{ Label = 'the Legion data folder'; Path = $DataDir; AlsoInside = $true },
    @{ Label = 'LEGION_HOME'; Path = $LegionHome; AlsoInside = $true }
  )
  foreach ($g in $guards) {
    if ([string]::IsNullOrWhiteSpace($g.Path)) { continue }
    $gp = $g.Path
    try { $gp = Get-TrimmedFullPath $g.Path } catch { $gp = $g.Path }
    if (Test-PathUnder $gp $full) { return [pscustomobject]@{ Ok = $false; Reason = "that is, or contains, $($g.Label) ($gp)"; Path = $full } }
    if ($g.AlsoInside -and (Test-PathUnder $full $gp)) { return [pscustomobject]@{ Ok = $false; Reason = "that is inside $($g.Label) ($gp)"; Path = $full } }
  }

  if (Test-Path -LiteralPath $full -PathType Leaf) { return [pscustomobject]@{ Ok = $false; Reason = 'that is a file, not a folder'; Path = $full } }
  if (-not (Test-Path -LiteralPath $full -PathType Container)) { return [pscustomobject]@{ Ok = $true; Reason = 'the folder does not exist yet and will be created'; Path = $full } }
  $kids = @()
  try { $kids = @(Get-ChildItem -LiteralPath $full -Force -ErrorAction Stop) }
  catch { return [pscustomobject]@{ Ok = $false; Reason = "the folder cannot be read ($($_.Exception.Message))"; Path = $full } }
  # A failed first run can leave only Legion's own marked runtime\node download behind; that still counts as empty.
  $kids = @($kids | Where-Object { -not ($_.Name -eq 'runtime' -and (Test-RuntimeOwned (Join-Path $_.FullName 'node'))) })
  if ($kids.Count -eq 0) { return [pscustomobject]@{ Ok = $true; Reason = 'the folder is empty'; Path = $full } }

  # A git checkout is refused BEFORE the "is it a Legion install" test, because a worktree also has package.json named
  # legion and would sail through it. Installing into a checkout makes the app un-updatable from inside itself: the
  # updater sees .git and permanently reports "this is a git checkout", so the auto-update control stays dead and every
  # push to the repository lands inside the installed app. That happened on the owner's PC on 2026-10-04.
  $gitMarker = Join-Path $full '.git'
  if (Test-Path -LiteralPath $gitMarker) {
    $kind = if (Test-Path -LiteralPath $gitMarker -PathType Container) { 'clone' } else { 'worktree or submodule' }
    return [pscustomobject]@{ Ok = $false; Reason = "that folder is a git $kind (.git is present), not an installed copy of Legion. Installing here would make the app unable to update itself. Choose an empty folder, or remove the .git marker from this one first"; Path = $full }
  }

  if (Test-LegionPackage $full) { return [pscustomobject]@{ Ok = $true; Reason = 'the folder is an existing Legion install (package.json name is legion) and will be updated'; Path = $full } }
  return [pscustomobject]@{ Ok = $false; Reason = 'the folder is not empty and is not a Legion install (no package.json named legion); setup would delete its other contents. Pick a new or empty folder'; Path = $full }
}

# Decides whether uninstall -Purge may delete the data folder. Returns @{ Ok; Reason; Path }.
# Refuses a drive root, the user profile folder (or a parent of it), and - when the folder came from LEGION_HOME rather than the
# default %USERPROFILE%\.legion - any folder without Legion's config.json (so a mistyped LEGION_HOME cannot delete a foreign folder).
function Get-PurgeVerdict {
  param([string]$DataDir, [string]$UserProfile = '', [bool]$FromEnv = $false)
  if ([string]::IsNullOrWhiteSpace($DataDir)) { return [pscustomobject]@{ Ok = $false; Reason = 'no data folder'; Path = '' } }
  if (Test-DriveRoot $DataDir) { return [pscustomobject]@{ Ok = $false; Reason = 'that is a drive root'; Path = $DataDir } }
  $full = Get-TrimmedFullPath $DataDir
  if (Test-DriveRoot $full) { return [pscustomobject]@{ Ok = $false; Reason = 'that is a drive root'; Path = $full } }
  if (-not [string]::IsNullOrWhiteSpace($UserProfile)) {
    $up = $UserProfile
    try { $up = Get-TrimmedFullPath $UserProfile } catch { $up = $UserProfile }
    if (Test-PathUnder $up $full) { return [pscustomobject]@{ Ok = $false; Reason = "that is, or contains, your user profile folder ($up)"; Path = $full } }
  }
  if (-not (Test-Path -LiteralPath $full -PathType Container)) { return [pscustomobject]@{ Ok = $true; Reason = 'the folder does not exist'; Path = $full } }
  if ($FromEnv -and -not (Test-Path -LiteralPath (Join-Path $full 'config.json') -PathType Leaf)) {
    return [pscustomobject]@{ Ok = $false; Reason = 'LEGION_HOME points to a folder without Legion''s config.json, so it is not deleted'; Path = $full }
  }
  return [pscustomobject]@{ Ok = $true; Reason = 'looks like Legion data'; Path = $full }
}

# ---- Legion-owned Node.js runtime (<install>\runtime\node). Shared by setup (node-bootstrap.ps1) and uninstall.
# A runtime folder is Legion's only when it holds the marker file setup writes LAST, after the download was verified.
$script:LegionRuntimeMarker = '.legion-owned'

function Get-RuntimeNodeDir {
  param([string]$InstallDir)
  return (Join-Path (Join-Path $InstallDir 'runtime') 'node')
}

function Test-RuntimeOwned {
  param([string]$NodeDir)
  if ([string]::IsNullOrEmpty($NodeDir)) { return $false }
  return (Test-Path -LiteralPath (Join-Path $NodeDir $script:LegionRuntimeMarker) -PathType Leaf)
}

function Test-ReparsePoint {
  param([string]$Path)
  try {
    $a = [System.IO.File]::GetAttributes($Path)
    return (($a -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
  } catch { return $false }
}

# Deletes a tree WITHOUT following links: a junction or symlink is removed as a link (non-recursive), its target is never touched.
# (Windows PowerShell 5.1 Remove-Item -Recurse can delete through a link; this is the replacement.)
function Remove-TreeNoFollow {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  if (Test-ReparsePoint $Path) {
    if (Test-Path -LiteralPath $Path -PathType Container) { [System.IO.Directory]::Delete($Path, $false) } else { [System.IO.File]::Delete($Path) }
    return
  }
  if (Test-Path -LiteralPath $Path -PathType Container) {
    foreach ($k in @(Get-ChildItem -LiteralPath $Path -Force)) { Remove-TreeNoFollow $k.FullName }
    [System.IO.Directory]::Delete($Path, $false)
  } else {
    [System.IO.File]::SetAttributes($Path, [System.IO.FileAttributes]::Normal)
    [System.IO.File]::Delete($Path)
  }
}

# Removes <InstallDir>\runtime\node when Legion owns it (marker present) or when it is only a link (the link goes, never the target).
# Returns @{ Removed; Reason }. A folder without the marker is not ours and is left alone.
function Remove-LegionRuntime {
  param([string]$InstallDir, [switch]$DryRun)
  $nodeDir = Get-RuntimeNodeDir $InstallDir
  $runtime = Join-Path $InstallDir 'runtime'
  if (Test-ReparsePoint $runtime) {
    if ($DryRun) { return [pscustomobject]@{ Removed = $false; Reason = 'dry run: would detach the link' } }
    Remove-TreeNoFollow $runtime
    return [pscustomobject]@{ Removed = $true; Reason = 'runtime was a link; the link was removed and its target left alone' }
  }
  if (-not (Test-Path -LiteralPath $nodeDir)) { return [pscustomobject]@{ Removed = $false; Reason = 'no runtime folder' } }
  if (-not (Test-ReparsePoint $nodeDir) -and -not (Test-RuntimeOwned $nodeDir)) {
    return [pscustomobject]@{ Removed = $false; Reason = 'runtime\node has no Legion marker, so it is not ours and was left alone' }
  }
  if ($DryRun) { return [pscustomobject]@{ Removed = $false; Reason = 'dry run: would remove runtime\node' } }
  Remove-TreeNoFollow $nodeDir
  # runtime\ itself only if nothing else is in it (a staging leftover of ours has the .staging- prefix)
  foreach ($k in @(Get-ChildItem -LiteralPath $runtime -Force -ErrorAction SilentlyContinue)) {
    if ($k.Name -like '.staging-*') { Remove-TreeNoFollow $k.FullName }
  }
  if (@(Get-ChildItem -LiteralPath $runtime -Force -ErrorAction SilentlyContinue).Count -eq 0) { [System.IO.Directory]::Delete($runtime, $false) }
  return [pscustomobject]@{ Removed = $true; Reason = 'removed runtime\node' }
}
