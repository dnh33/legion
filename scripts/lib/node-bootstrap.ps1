# Makes sure a usable Node.js exists before setup needs it. Dot-sourced by setup.ps1 (after legion-procs.ps1 and safe-io.ps1).
# Windows PowerShell 5.1 compatible, ASCII only.
#
# Order: Legion's own runtime in <install>\runtime\node  ->  a good Node on PATH  ->  ask once, then download the pinned official zip.
# The download route needs no admin and changes no system setting; the only network host is nodejs.org.

$script:LegionNodeVersion = '24.21.0'        # the Node.js LTS line Legion installs for a user who has none (the one place to bump it)
$script:LegionNodeMin = '20.10.0'            # package.json "engines.node": ">=20.10". Keep in step with it (a test checks).
$script:LegionNodeSizeMB = 36                # shown in the question; x64 is about 36 MB (arm64 a little less)
$script:LegionNodeHost = 'nodejs.org'
$script:LegionNodeZipMax = 120MB
$script:LegionNodeSumsMax = 64KB
$script:LegionWingetLine = 'winget install OpenJS.NodeJS.LTS'

function ConvertTo-NodeVersion {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
  $t = $Text.Trim().TrimStart('v', 'V')
  if ($t -notmatch '^\d+\.\d+\.\d+$') { return $null }
  try { return [version]$t } catch { return $null }
}

# True when Version is at least Min (major, then minor, then patch).
function Test-NodeVersionOk {
  param([string]$Version, [string]$Min = $script:LegionNodeMin)
  $v = ConvertTo-NodeVersion $Version
  $m = ConvertTo-NodeVersion $Min
  if ($null -eq $v -or $null -eq $m) { return $false }
  return ($v -ge $m)
}

# Production: https://nodejs.org/dist/v<pin>/. The only override is for tests and needs BOTH LEGION_TEST_MODE=1 and a loopback http mirror;
# with the flag unset the variable is ignored, so a stray LEGION_TEST_NODE_MIRROR in a user's environment changes nothing.
function Get-NodeSource {
  $v = $script:LegionNodeVersion
  $mirror = $env:LEGION_TEST_NODE_MIRROR
  if ($env:LEGION_TEST_MODE -eq '1' -and $mirror -match '^http://127\.0\.0\.1:\d{1,5}/?$') {
    return [pscustomobject]@{ Base = ($mirror.TrimEnd('/') + "/dist/v$v/"); Host = '127.0.0.1'; Https = $false; Test = $true }
  }
  return [pscustomobject]@{ Base = "https://$($script:LegionNodeHost)/dist/v$v/"; Host = $script:LegionNodeHost; Https = $true; Test = $false }
}

# 'x64', 'arm64' or $null (32-bit Windows and anything else: not supported by the bootstrap).
function Get-NodeArch {
  $a = $env:PROCESSOR_ARCHITEW6432
  if ([string]::IsNullOrEmpty($a)) { $a = $env:PROCESSOR_ARCHITECTURE }
  if ($env:LEGION_TEST_MODE -eq '1' -and -not [string]::IsNullOrEmpty($env:LEGION_TEST_ARCH)) { $a = $env:LEGION_TEST_ARCH }
  switch -Regex ($a) { '^(AMD64|x64)$' { return 'x64' } '^ARM64$' { return 'arm64' } default { return $null } }
}

# The sha256 for exactly File from SHASUMS256.txt text ("<64 hex>  <file>" per line), or $null.
function Get-ShaFromSums {
  param([string]$Text, [string]$File)
  foreach ($line in ($Text -split "`n")) {
    if ($line.Trim() -match '^([0-9a-fA-F]{64})\s+\*?(\S+)$' -and $Matches[2] -ceq $File) { return $Matches[1].ToLowerInvariant() }
  }
  return $null
}

# Runs <exe> -v and returns the text, or $null if it did not run. Never throws.
function Get-ExeVersionText {
  param([string]$Exe)
  try { $out = & $Exe -v 2>$null; if ($LASTEXITCODE -eq 0 -and $out) { return ([string](@($out)[0])).Trim() } } catch { }
  return $null
}

# Legion's own runtime: marker present and node.exe runs. Version must equal the pin (a test can accept any version in test mode).
function Test-LegionRuntimeNode {
  param([string]$InstallDir)
  $dir = Get-RuntimeNodeDir $InstallDir
  $no = [pscustomobject]@{ Ok = $false; Dir = $dir; Version = ''; Reason = 'no Legion Node runtime' }
  if (-not (Test-RuntimeOwned $dir) -or (Test-ReparsePoint $dir)) { return $no }
  $exe = Join-Path $dir 'node.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { return $no }
  $txt = Get-ExeVersionText $exe
  $v = ConvertTo-NodeVersion $txt
  if ($null -eq $v) { $no.Reason = 'the Legion Node runtime does not run'; return $no }
  if ($env:LEGION_TEST_MODE -ne '1' -and $v.ToString() -ne $script:LegionNodeVersion) { $no.Reason = "the Legion Node runtime is $v, not the pinned $($script:LegionNodeVersion)"; return $no }
  return [pscustomobject]@{ Ok = $true; Dir = $dir; Version = $v.ToString(); Reason = 'Legion Node runtime found' }
}

# A Node on PATH that meets engines.node and has npm next to it on PATH.
function Get-SystemNode {
  $no = [pscustomobject]@{ Ok = $false; Version = ''; Reason = 'Node.js was not found' }
  $cmd = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { return $no }
  $txt = Get-ExeVersionText $cmd.Source
  $v = ConvertTo-NodeVersion $txt
  if ($null -eq $v) { $no.Reason = 'Node.js was found but did not report a version'; return $no }
  if (-not (Test-NodeVersionOk $v.ToString())) { $no.Version = $v.ToString(); $no.Reason = "Node $v is too old (need $($script:LegionNodeMin) or newer)"; return $no }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { $no.Version = $v.ToString(); $no.Reason = 'npm was not found next to Node.js'; return $no }
  return [pscustomobject]@{ Ok = $true; Version = $v.ToString(); Reason = 'system Node.js is fine' }
}

# Which route to take. Pure decision, no download. Action: use-runtime | use-system | need-download.
function Get-NodeDecision {
  param([string]$InstallDir)
  $rt = Test-LegionRuntimeNode $InstallDir
  if ($rt.Ok) { return [pscustomobject]@{ Action = 'use-runtime'; NodeDir = $rt.Dir; Version = $rt.Version; Reason = $rt.Reason } }
  $sys = Get-SystemNode
  if ($sys.Ok) { return [pscustomobject]@{ Action = 'use-system'; NodeDir = ''; Version = $sys.Version; Reason = $sys.Reason } }
  return [pscustomobject]@{ Action = 'need-download'; NodeDir = ''; Version = ''; Reason = $sys.Reason }
}

# Downloads, verifies and installs the pinned Node into <InstallDir>\runtime\node. Throws on any problem; nothing half-installed is left.
function Install-LegionNode {
  param([string]$InstallDir)
  $arch = Get-NodeArch
  if (-not $arch) { throw 'This Windows is not 64-bit x64 or arm64, so the automatic Node.js download is not available.' }
  $src = Get-NodeSource
  $v = $script:LegionNodeVersion
  $name = "node-v$v-win-$arch"
  $zipName = "$name.zip"
  $runtime = Join-Path $InstallDir 'runtime'
  $final = Get-RuntimeNodeDir $InstallDir
  if ((Test-Path -LiteralPath $final) -and -not (Test-RuntimeOwned $final) -and -not (Test-ReparsePoint $final)) {
    throw "$final already exists and is not Legion's (no marker file). Remove or rename it, then run setup again."
  }
  if (Test-ReparsePoint $runtime) { throw "$runtime is a link; refusing to download into it." }
  [void][System.IO.Directory]::CreateDirectory($runtime)
  $staging = Join-Path $runtime ".staging-$PID"
  if (Test-Path -LiteralPath $staging) { Remove-TreeNoFollow $staging }
  [void][System.IO.Directory]::CreateDirectory($staging)
  try {
    $hosts = @($src.Host)
    $sumsFile = Join-Path $staging 'SHASUMS256.txt'
    $zipFile = Join-Path $staging $zipName
    Invoke-BoundedDownload -Url ($src.Base + 'SHASUMS256.txt') -Dest $sumsFile -MaxBytes $script:LegionNodeSumsMax -AllowedHosts $hosts -MaxRedirects 0 -RequireHttps $src.Https
    $want = Get-ShaFromSums ([System.IO.File]::ReadAllText($sumsFile)) $zipName
    if (-not $want) { throw "SHASUMS256.txt has no checksum for $zipName." }
    $zipMax = $script:LegionNodeZipMax
    if ($src.Test -and $env:LEGION_TEST_NODE_ZIP_MAX -match '^\d+$') { $zipMax = [long]$env:LEGION_TEST_NODE_ZIP_MAX }   # tests only (needs the test flag)
    Invoke-BoundedDownload -Url ($src.Base + $zipName) -Dest $zipFile -MaxBytes $zipMax -AllowedHosts $hosts -MaxRedirects 0 -RequireHttps $src.Https -TimeoutSec 300
    $got = Get-Sha256Hex $zipFile
    if ($got -ne $want) { throw "The downloaded file does not match the official checksum (expected $($want.Substring(0, 12))..., got $($got.Substring(0, 12))...). Nothing was installed." }
    $unpack = Join-Path $staging 'unpack'
    [void][System.IO.Directory]::CreateDirectory($unpack)
    [void](Expand-ZipSafe -Zip $zipFile -Dest $unpack)
    $top = Join-Path $unpack $name
    $exe = Join-Path $top 'node.exe'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "The download does not contain $name\node.exe." }
    $txt = Get-ExeVersionText $exe
    $ver = ConvertTo-NodeVersion $txt
    if ($null -eq $ver) { throw 'The downloaded node.exe does not run.' }
    if (-not $src.Test -and $ver.ToString() -ne $v) { throw "The downloaded node.exe reports $ver, not $v." }
    # swap in: only an owned (or absent) runtime\node may be replaced
    if (Test-Path -LiteralPath $final) { Remove-TreeNoFollow $final }
    [System.IO.Directory]::Move($top, $final)
    $marker = @{ version = $ver.ToString(); sha256 = $got; file = $zipName; source = $src.Base } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText((Join-Path $final $script:LegionRuntimeMarker), $marker + "`r`n", (New-Object System.Text.ASCIIEncoding))
    return [pscustomobject]@{ NodeDir = $final; Version = $ver.ToString() }
  } finally {
    Remove-TreeNoFollow $staging
  }
}

# The whole step for setup.ps1. Ask is a scriptblock taking (question, default) and returning $true/$false; Say takes (text, color).
# Returns @{ Ok; NodeDir; Message }. NodeDir is '' when the system Node is used. On not-Ok the Message already includes the winget line.
function Initialize-LegionNode {
  param([string]$InstallDir, [scriptblock]$Ask, [scriptblock]$Say, [switch]$DryRun)
  $d = Get-NodeDecision $InstallDir
  switch ($d.Action) {
    'use-runtime' { & $Say "Node $($d.Version) OK (Legion's own copy in $($d.NodeDir))" 'Green'; return [pscustomobject]@{ Ok = $true; NodeDir = $d.NodeDir; Message = '' } }
    'use-system' { & $Say "Node $($d.Version) OK" 'Green'; return [pscustomobject]@{ Ok = $true; NodeDir = ''; Message = '' } }
  }
  & $Say "$($d.Reason)." 'Yellow'
  $winget = "Install it yourself with:`n  $($script:LegionWingetLine)`nthen run setup again."
  if ($DryRun) {
    & $Say "  (dry run) would ask: Legion needs Node.js 24 LTS. Install it now? About $($script:LegionNodeSizeMB) MB from nodejs.org; then download and verify it into $(Get-RuntimeNodeDir $InstallDir)" 'DarkGray'
    return [pscustomobject]@{ Ok = $true; NodeDir = ''; Message = '' }
  }
  $q = "Legion needs Node.js 24 LTS. Install it now? It downloads about $($script:LegionNodeSizeMB) MB from nodejs.org into Legion's own folder (no admin, nothing system-wide changes)."
  if (-not (& $Ask $q $false)) {
    return [pscustomobject]@{ Ok = $false; NodeDir = ''; Message = "Node.js was not installed (you said no, or there was no way to ask).`n$winget" }
  }
  & $Say "Downloading Node.js $($script:LegionNodeVersion) from nodejs.org ..." 'Cyan'
  try {
    $r = Install-LegionNode -InstallDir $InstallDir
  } catch {
    return [pscustomobject]@{ Ok = $false; NodeDir = ''; Message = "The automatic Node.js install failed: $($_.Exception.Message)`n$winget" }
  }
  & $Say "Node $($r.Version) installed in $($r.NodeDir)" 'Green'
  return [pscustomobject]@{ Ok = $true; NodeDir = $r.NodeDir; Message = '' }
}
