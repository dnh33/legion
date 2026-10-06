# The prebuilt-package route of setup. Dot-sourced by setup.ps1 (after legion-procs.ps1 and safe-io.ps1). Windows PowerShell 5.1 compatible, ASCII only.
#
# A PACKAGE is a folder with build-info.json (kind "package", platform "win32-x64") and runtime\electron\electron.exe. For a package, setup needs no Node,
# no npm and no build: the package's own electron.exe (in node mode) runs scripts\package-install.mjs, which checks every file against its list while
# copying, swaps the new build in with the updater's own journaled swap, and smoke-tests it.
# This file also fetches the package when only a zip is at hand (a local file, or -PackageUrl after a yes). Hash before unpack, always.

$script:LegionPkgHost = 'github.com'
$script:LegionPkgRedirectHosts = @('github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com')
$script:LegionPkgMaxRedirects = 3
$script:LegionPkgZipMax = 450MB
$script:LegionPkgUnpackMax = 1200MB
$script:LegionPkgEntriesMax = 20000
$script:LegionPkgSizeMB = 270          # shown in the question; the real number is on the release page
$script:LegionPkgRepoPath = '/dnh33/legion/releases/download/'
$script:LegionPkgSemver = '(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})(?:-[a-z])?'

# 'package', 'source' or 'unknown' for a folder. Same rule as detectKind in scripts\lib\package-lib.mjs.
function Get-LegionFolderKind {
  param([string]$Dir)
  if ([string]::IsNullOrEmpty($Dir)) { return 'unknown' }
  $exe = Join-PathParts $Dir @('runtime', 'electron', 'electron.exe')
  $bi = Join-Path $Dir 'build-info.json'
  if ((Test-Path -LiteralPath $exe -PathType Leaf) -and (Test-Path -LiteralPath $bi -PathType Leaf)) {
    try {
      $j = Get-Content -Raw -LiteralPath $bi -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
      if ($null -ne $j -and $j.kind -ceq 'package' -and $j.platform -ceq 'win32-x64') { return 'package' }
    } catch { }
  }
  if ((Test-Path -LiteralPath (Join-Path $Dir 'package.json') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $Dir 'src') -PathType Container)) { return 'source' }
  return 'unknown'
}

# Test-only mirror: needs BOTH LEGION_TEST_MODE=1 and a loopback http address, exactly like the Node bootstrap. Otherwise $null.
function Get-PackageTestMirror {
  $m = $env:LEGION_TEST_PKG_MIRROR
  if ($env:LEGION_TEST_MODE -eq '1' -and $m -match '^http://127\.0\.0\.1:\d{1,5}$') { return $m }
  return $null
}

# Why an address may not be used for -PackageUrl, or $null when it is fine. Mirror of checkPackageUrl in package-lib.mjs.
function Test-PackageUrl {
  param([string]$Url)
  $mirror = Get-PackageTestMirror
  $u = $null
  try { $u = New-Object System.Uri($Url) } catch { return 'not a valid address' }
  if ($mirror -and $u.Scheme -eq 'http' -and $u.Host -eq '127.0.0.1') {
    if ($Url.StartsWith($mirror + '/', [System.StringComparison]::Ordinal)) { return $null }
    return 'test mirror: wrong address'
  }
  if ($u.Scheme -ne 'https') { return 'only https addresses are allowed' }
  if (-not [string]::IsNullOrEmpty($u.UserInfo)) { return 'the address carries user info' }
  if (-not $u.IsDefaultPort) { return 'a port in the address is not allowed' }
  if ($u.Host.ToLowerInvariant() -ne $script:LegionPkgHost) { return "the first host must be $($script:LegionPkgHost)" }
  if (-not [string]::IsNullOrEmpty($u.Query) -or -not [string]::IsNullOrEmpty($u.Fragment)) { return 'a query or fragment is not allowed' }
  $re = '^' + [regex]::Escape($script:LegionPkgRepoPath) + 'v(' + $script:LegionPkgSemver + ')/legion-(' + $script:LegionPkgSemver + ')-win-x64\.zip$'
  $m2 = [regex]::Match($u.AbsolutePath, $re)
  if (-not $m2.Success) { return 'the path must be /dnh33/legion/releases/download/v<version>/legion-<version>-win-x64.zip' }
  if ($m2.Groups[1].Value -ne $m2.Groups[2].Value) { return 'the version in the folder and in the file name differ' }
  return $null
}

function Test-Sha256Text {
  param([string]$Text)
  return (-not [string]::IsNullOrEmpty($Text)) -and ($Text.Trim() -match '^[0-9a-fA-F]{64}$')
}

# The sha256 for exactly this file name from a SHA256SUMS.txt next to the zip, or $null.
function Get-PackageSumFromFile {
  param([string]$SumsFile, [string]$FileName)
  if (-not (Test-Path -LiteralPath $SumsFile -PathType Leaf)) { return $null }
  if ((Get-Item -LiteralPath $SumsFile).Length -gt 64KB) { return $null }
  foreach ($line in ([System.IO.File]::ReadAllText($SumsFile) -split "`n")) {
    if ($line.Trim() -match '^([0-9a-fA-F]{64})\s+\*?(\S+)$' -and $Matches[2] -ceq $FileName) { return $Matches[1].ToLowerInvariant() }
  }
  return $null
}

# Gets a package folder from a zip. Returns @{ Ok; Dir; Temp; Message }. Dir is the unpacked legion-<version> folder, Temp is the folder to delete afterwards.
#  -PackagePath / -PackageUrl: the zip (a local file, or an https release address, downloaded ONLY after the question is answered yes; -Yes answers it).
#  -Sha256: the checksum from the release page. Needed for -PackageUrl. For a local file without one: SHA256SUMS.txt next to it, else the computed value
#           is shown and the person is asked whether it matches the page (a script cannot answer that: -Yes does not).
# Order: size check, hash compare, THEN unpack (Expand-ZipSafe), then the shape of what was unpacked.
function Get-LegionPackageFolder {
  param(
    [string]$PackagePath, [string]$PackageUrl, [string]$Sha256,
    [scriptblock]$Ask, [scriptblock]$Say, [bool]$AssumeYes = $false, [bool]$Interactive = $true, [string]$TempRoot = ''
  )
  $fail = { param($m) return [pscustomobject]@{ Ok = $false; Dir = ''; Temp = ''; Message = $m } }
  if ([string]::IsNullOrWhiteSpace($TempRoot)) { $TempRoot = [System.IO.Path]::GetTempPath() }
  if (-not [string]::IsNullOrWhiteSpace($Sha256)) {
    if (-not (Test-Sha256Text $Sha256)) { return (& $fail '-PackageSha256 is not 64 hex characters.') }
    $Sha256 = $Sha256.Trim().ToLowerInvariant()
  }
  $temp = Join-Path $TempRoot ("legion-setup-" + $PID)
  if (Test-Path -LiteralPath $temp) { Remove-TreeNoFollow $temp }
  [void][System.IO.Directory]::CreateDirectory($temp)
  $ok = $false
  try {
    $zip = ''
    $zipName = ''
    if (-not [string]::IsNullOrWhiteSpace($PackageUrl)) {
      $why = Test-PackageUrl $PackageUrl
      if ($why) { return (& $fail "Refusing -PackageUrl: $why.") }
      if (-not $Sha256) { return (& $fail '-PackageUrl needs -PackageSha256 (the SHA-256 shown on the release page); a download is never trusted without it.') }
      $zipName = [System.IO.Path]::GetFileName(([System.Uri]$PackageUrl).AbsolutePath)
      $mirror = Get-PackageTestMirror
      $q = "Download Legion ($zipName, about $($script:LegionPkgSizeMB) MB) from $(([System.Uri]$PackageUrl).Host)? It is checked against the SHA-256 you gave before anything is unpacked."
      if (-not $AssumeYes) {
        if (-not $Interactive) { return (& $fail "No download: there is no terminal to ask on and -Yes was not given.") }
        if (-not (& $Ask $q $false)) { return (& $fail 'No download: you said no.') }
      }
      $zip = Join-Path $temp $zipName
      & $Say "Downloading $zipName ..." 'Cyan'
      $hosts = $script:LegionPkgRedirectHosts
      $https = $true
      $redir = $script:LegionPkgMaxRedirects
      $max = $script:LegionPkgZipMax
      if ($mirror) { $hosts = @('127.0.0.1'); $https = $false; $redir = 0; if ($env:LEGION_TEST_PKG_ZIP_MAX -match '^\d+$') { $max = [long]$env:LEGION_TEST_PKG_ZIP_MAX } }
      try { Invoke-BoundedDownload -Url $PackageUrl -Dest $zip -MaxBytes $max -AllowedHosts $hosts -MaxRedirects $redir -RequireHttps $https -TimeoutSec 900 }
      catch { return (& $fail "The download failed: $($_.Exception.Message)") }
    } elseif (-not [string]::IsNullOrWhiteSpace($PackagePath)) {
      if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) { return (& $fail "The package file was not found: $PackagePath") }
      $zip = (Resolve-Path -LiteralPath $PackagePath).Path
      $zipName = [System.IO.Path]::GetFileName($zip)
      if ((Get-Item -LiteralPath $zip).Length -gt $script:LegionPkgZipMax) { return (& $fail "The package file is over the size limit ($([int]($script:LegionPkgZipMax / 1MB)) MB).") }
      if (-not $Sha256) { $Sha256 = Get-PackageSumFromFile (Join-Path (Split-Path -Parent $zip) 'SHA256SUMS.txt') $zipName }
    } else {
      return (& $fail 'No package given.')
    }

    # 1) hash BEFORE unpacking
    $got = Get-Sha256Hex $zip
    if ($Sha256) {
      if ($got -ne $Sha256) {
        if ($PackageUrl) { Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue }
        return (& $fail "The package does not match the SHA-256 you gave (expected $($Sha256.Substring(0, 12))..., got $($got.Substring(0, 12))...). Nothing was unpacked.")
      }
    } else {
      & $Say "SHA-256 of $zipName : $got" 'Yellow'
      # -Yes never answers "does this match the page?": a script run without questions must bring a checksum.
      if ($AssumeYes -or -not $Interactive) { return (& $fail 'No checksum to compare with: give -PackageSha256, or put SHA256SUMS.txt next to the zip. Setup does not accept a package it cannot check when it runs without questions. Nothing was unpacked.') }
      if (-not (& $Ask 'Does that match the SHA-256 on the download page?' $false)) { return (& $fail 'Not confirmed. Nothing was unpacked.') }
    }

    # 2) unpack safely, then check the shape
    $unpack = Join-Path $temp 'x'
    [void][System.IO.Directory]::CreateDirectory($unpack)
    try { [void](Expand-ZipSafe -Zip $zip -Dest $unpack -MaxEntries $script:LegionPkgEntriesMax -MaxTotalBytes $script:LegionPkgUnpackMax) }
    catch { return (& $fail "The package could not be unpacked safely: $($_.Exception.Message)") }
    $tops = @(Get-ChildItem -LiteralPath $unpack -Force)
    if ($tops.Count -ne 1 -or -not $tops[0].PSIsContainer -or $tops[0].Name -cnotmatch ('^legion-' + $script:LegionPkgSemver + '$')) { return (& $fail 'The zip does not hold exactly one legion-<version> folder.') }
    if ((Get-LegionFolderKind $tops[0].FullName) -ne 'package') { return (& $fail 'The zip is not a Legion Windows package (no build-info.json of kind package, or no runtime\electron\electron.exe).') }
    $ok = $true
    return [pscustomobject]@{ Ok = $true; Dir = $tops[0].FullName; Temp = $temp; Message = '' }
  } finally {
    if (-not $ok) { Remove-TreeNoFollow $temp }
  }
}

# Runs scripts\package-install.mjs of the package on the package's OWN electron.exe in node mode. The environment variable is set for that child only.
# stderr (progress and the error text) goes straight to this console; stdout carries one JSON line. Returns @{ ExitCode; Json }.
function Invoke-PackageInstaller {
  param([string]$Src, [string]$Dest, [string[]]$DataDirs = @())
  $exe = Join-PathParts $Src @('runtime', 'electron', 'electron.exe')
  $script = Join-PathParts $Src @('scripts', 'package-install.mjs')
  $quote = { param($p) '"' + $p.TrimEnd('\') + '"' }
  $argText = (& $quote $script) + ' --src ' + (& $quote $Src) + ' --dest ' + (& $quote $Dest)
  foreach ($d in $DataDirs) { if (-not [string]::IsNullOrWhiteSpace($d)) { $argText += ' --data-dir ' + (& $quote $d) } }
  $argText += ' --json'
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = $argText
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $false
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEnd()
  $p.WaitForExit()
  $json = $null
  $last = @($out -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
  if ($last.Count -gt 0 -and $last[0]) { try { $json = $last[0] | ConvertFrom-Json -ErrorAction Stop } catch { $json = $null } }
  return [pscustomobject]@{ ExitCode = $p.ExitCode; Json = $json }
}

# One call for setup.ps1: install the package in $Src into $InstallDir. Returns @{ Ok; Message; Code }.
function Install-LegionPackageFolder {
  param([string]$Src, [string]$InstallDir, [string[]]$DataDirs = @(), [scriptblock]$Say)
  & $Say "Installing the prebuilt package (no Node, no npm, no build needed) ..." 'Cyan'
  $r = Invoke-PackageInstaller -Src $Src -Dest $InstallDir -DataDirs $DataDirs
  if ($r.ExitCode -eq 0) { return [pscustomobject]@{ Ok = $true; Message = ''; Code = 0 } }
  $msg = 'The package could not be installed.'
  if ($r.Json -and $r.Json.message) { $msg = [string]$r.Json.message }
  return [pscustomobject]@{ Ok = $false; Message = $msg; Code = $r.ExitCode }
}
