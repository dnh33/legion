# Legion installer for Windows. Windows PowerShell 5.1 and PowerShell 7. ASCII only.
#
#   irm https://getlegion.xyz | iex
#
# With options (a pinned version, another folder, no launch at the end):
#   & ([scriptblock]::Create((irm https://getlegion.xyz))) -Version <version> -NoLaunch
#
# What it does:
#   1. Finds the latest release from https://github.com/dnh33/legion/releases/latest (or uses -Version).
#   2. Downloads legion-<version>-win-x64.zip and SHA256SUMS.txt from that release over HTTPS.
#   3. The zip is downloaded from GitHub Releases over HTTPS and checked against the release's SHA-256.
#      If it does not match, nothing is unpacked or installed.
#   4. Unpacks the zip into a temp folder and runs the setup script from inside it. Setup installs for
#      your user (no admin) and creates shortcuts.
#   5. Deletes its temp folder.
# Setup is run with -Yes, so if Legion is open it is closed without a question (setup stops it before it replaces the files).
# The zip is not code-signed. The check above shows the download is the file the release lists,
# not who made it. It sends nothing anywhere and changes only the folders named above.
#
# The whole script is one function called on the last line, so a download that is cut off runs nothing.

function Install-Legion {
  param(
    [switch]$NoLaunch,
    [string]$Version = '',
    [string]$InstallDir = ''
  )
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  # LEGION_INSTALL_BASE replaces https://github.com. It exists so CI can point the script at a fake server.
  $base = 'https://github.com'
  $baseOverridden = $false
  if (-not [string]::IsNullOrWhiteSpace($env:LEGION_INSTALL_BASE)) { $base = $env:LEGION_INSTALL_BASE.TrimEnd('/'); $baseOverridden = $true }
  $repo = '/dnh33/legion/releases'
  $zipMax = 450MB

  try { [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12 } catch { }

  # Same rule as Invoke-BoundedDownload in the package (scripts\lib\safe-io.ps1, which is not unpacked yet): https only, no user info,
  # at most 3 redirects, and EVERY hop must be on the list. With LEGION_INSTALL_BASE only that one host is allowed, over http or https.
  $allowedHosts = @('github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com')
  $baseHost = ([System.Uri]$base).Host.ToLowerInvariant()
  $maxRedirects = 3

  function Assert-AllowedUrl([System.Uri]$u) {
    if (-not [string]::IsNullOrEmpty($u.UserInfo)) { throw "Refusing an address with user info: $($u.Host)" }
    if ($baseOverridden) {
      if ($u.Scheme -ne 'https' -and $u.Scheme -ne 'http') { throw "Refusing the address scheme $($u.Scheme)" }
      if ($u.Host.ToLowerInvariant() -ne $baseHost) { throw "Refusing host $($u.Host): not the LEGION_INSTALL_BASE host." }
    } else {
      if ($u.Scheme -ne 'https') { throw "Refusing a non-HTTPS address: $($u.AbsoluteUri)" }
      if ($allowedHosts -notcontains $u.Host.ToLowerInvariant()) { throw "Refusing host $($u.Host): it is not one of GitHub's download hosts." }
    }
  }

  # One request, redirects NOT followed (the caller follows them, hop by hop, through Assert-AllowedUrl).
  function Open-Response([System.Uri]$u) {
    Assert-AllowedUrl $u
    $req = [System.Net.HttpWebRequest]::Create($u)
    $req.AllowAutoRedirect = $false
    $req.UserAgent = 'Legion-Install'
    $req.Timeout = 60000
    $req.ReadWriteTimeout = 120000
    if ($baseOverridden -and $u.Host -eq '127.0.0.1') { $req.Proxy = $null }
    elseif ($null -ne $req.Proxy) { try { $req.Proxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials } catch { } }
    try { return $req.GetResponse() }
    catch [System.Net.WebException] {
      if ($null -ne $_.Exception.Response) { return $_.Exception.Response }
      throw "Could not reach $($u.Host): $($_.Exception.Message)"
    }
  }

  function Save-Download([string]$Url, [string]$Dest, [long]$Max) {
    $cur = New-Object System.Uri($Url)
    $deadline = [DateTime]::UtcNow.AddMinutes(20)
    for ($hop = 0; $hop -le $maxRedirects; $hop++) {
      $resp = Open-Response $cur
      try {
        $code = [int]$resp.StatusCode
        if ($code -ge 300 -and $code -lt 400) {
          if ($hop -ge $maxRedirects) { throw "Too many redirects (more than $maxRedirects) for $Url" }
          $loc = $resp.Headers['Location']
          if ([string]::IsNullOrEmpty($loc)) { throw "Redirect (HTTP $code) without a Location: $Url" }
          $cur = New-Object System.Uri($cur, $loc)
          continue
        }
        if ($code -ne 200) { throw "Download failed (HTTP $code): $Url" }
        if ($resp.ContentLength -gt $Max) { throw "The file is larger than expected ($($resp.ContentLength) bytes). Stopping." }
        $in = $resp.GetResponseStream()
        $out = [System.IO.File]::Create($Dest)
        try {
          $buf = New-Object byte[] 81920
          [long]$total = 0
          while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
            $total += $n
            if ($total -gt $Max) { throw 'The download grew past the expected size. Stopping.' }
            if ([DateTime]::UtcNow -gt $deadline) { throw 'The download took longer than 20 minutes. Stopping.' }
            $out.Write($buf, 0, $n)
          }
          if ($resp.ContentLength -ge 0 -and $total -ne $resp.ContentLength) { throw "The download was cut off ($total of $($resp.ContentLength) bytes)." }
        } finally { $out.Dispose(); $in.Dispose() }
        return
      } finally { $resp.Close() }
    }
    throw "Too many redirects (more than $maxRedirects) for $Url"
  }

  function Get-FileSha256([string]$Path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $fs = [System.IO.File]::OpenRead($Path)
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($fs)).Replace('-', '').ToLowerInvariant()) }
    finally { $fs.Dispose(); $sha.Dispose() }
  }

  $semver = '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?\z'
  $temp = Join-Path ([System.IO.Path]::GetTempPath()) ('legion-install-' + [guid]::NewGuid().ToString('N'))
  try {
    Write-Host 'Legion installer'
    if ($baseOverridden) { Write-Host "Note: LEGION_INSTALL_BASE is set. Downloads come from $base, not from github.com." }

    # 1) which version
    if ([string]::IsNullOrWhiteSpace($Version)) {
      $resp = Open-Response (New-Object System.Uri($base + $repo + '/latest'))
      try {
        $loc = $resp.Headers['Location']
        if ([int]$resp.StatusCode -lt 300 -or [int]$resp.StatusCode -ge 400 -or [string]::IsNullOrEmpty($loc)) { throw 'Could not find the latest release (no redirect from the releases page).' }
        $target = (New-Object System.Uri((New-Object System.Uri($base + '/')), $loc)).AbsolutePath
      } finally { $resp.Close() }
      $m = [regex]::Match($target, '/releases/tag/v([^/]+)$')
      if (-not $m.Success) { throw "Could not read a version from the latest-release address: $target" }
      $Version = $m.Groups[1].Value
    } else {
      $Version = $Version.TrimStart('v')
    }
    if ($Version -notmatch $semver) { throw "That is not a version number: $Version" }
    Write-Host "Version: $Version"

    # 2) download the zip and the checksum list
    $zipName = "legion-$Version-win-x64.zip"
    $dl = $base + $repo + '/download/v' + $Version + '/'
    [void][System.IO.Directory]::CreateDirectory($temp)
    $sums = Join-Path $temp 'SHA256SUMS.txt'
    Save-Download ($dl + 'SHA256SUMS.txt') $sums 65536
    $want = $null
    foreach ($line in ([System.IO.File]::ReadAllText($sums) -split "`n")) {
      if ($line.Trim() -match '^([0-9a-fA-F]{64})\s+\*?(\S+)$' -and $Matches[2] -ceq $zipName) { $want = $Matches[1].ToLowerInvariant() }
    }
    if (-not $want) { throw "SHA256SUMS.txt of release v$Version does not list $zipName." }
    $zip = Join-Path $temp $zipName
    Write-Host "Downloading $zipName from GitHub Releases ..."
    Save-Download ($dl + $zipName) $zip $zipMax

    # 3) check it against the release's SHA-256, before anything is unpacked
    $got = Get-FileSha256 $zip
    if ($got -ne $want) { throw "The download does not match the release's SHA-256 (expected $($want.Substring(0, 12))..., got $($got.Substring(0, 12))...). Nothing was unpacked or installed." }
    Write-Host "Checked against the release's SHA-256: it matches."

    # 4) unpack and run the package's own setup. The zip's own safe unpacker does the unpacking.
    #    (Not setup's -PackagePath route: setup of a release built before the lettered-version fix refuses lettered versions such as 0.2.5-g.
    #    This route works with every release, and the hash was already checked above.)
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $top = "legion-$Version"
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
    try {
      $entry = $archive.GetEntry("$top/scripts/lib/safe-io.ps1")
      if ($null -eq $entry) { throw 'The zip is not a Legion package (scripts\lib\safe-io.ps1 is missing).' }
      $rd = New-Object System.IO.StreamReader($entry.Open())
      try { $safeIo = $rd.ReadToEnd() } finally { $rd.Dispose() }
    } finally { $archive.Dispose() }
    # Loaded as text, so it also works when the PowerShell script policy blocks script files.
    . ([scriptblock]::Create($safeIo))
    $unpack = Join-Path $temp 'x'
    [void][System.IO.Directory]::CreateDirectory($unpack)
    Write-Host 'Unpacking ...'
    [void](Expand-ZipSafe -Zip $zip -Dest $unpack -MaxEntries 20000 -MaxTotalBytes 1200MB)
    $pkg = Join-Path $unpack $top
    $setup = Join-Path $pkg 'scripts\setup.ps1'
    if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) { throw 'The package has no scripts\setup.ps1.' }
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue

    $setupArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $setup, '-Yes')
    if ($NoLaunch) { $setupArgs += '-NoLaunch' }
    if (-not [string]::IsNullOrWhiteSpace($InstallDir)) { $setupArgs += @('-InstallDir', $InstallDir) }
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $ps)) { $ps = 'powershell.exe' }
    Write-Host 'Running setup ...'
    & $ps @setupArgs
    if ($LASTEXITCODE -ne 0) { throw "Setup failed (exit code $LASTEXITCODE). The messages above say why." }
  } catch {
    throw "Legion was not installed: $($_.Exception.Message)"
  } finally {
    # 5) clean up
    if (Test-Path -LiteralPath $temp) { try { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction Stop } catch { Write-Host "(Could not delete the temp folder $temp. You can delete it.)" } }
  }
}

Install-Legion @args
