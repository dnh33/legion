# Bounded download and path-safe zip extraction for the setup bootstrap. Dot-sourced by node-bootstrap.ps1 and release-bootstrap.ps1.
# Windows PowerShell 5.1 compatible, ASCII only. Deliberately not the high-level web cmdlets (they follow redirects and buffer the whole body).

function Get-Sha256Hex {
  param([string]$Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $fs = [System.IO.File]::OpenRead($Path)
  try { return ([System.BitConverter]::ToString($sha.ComputeHash($fs)).Replace('-', '').ToLowerInvariant()) }
  finally { $fs.Dispose(); $sha.Dispose() }
}

# Downloads Url to Dest. Refuses: a scheme other than the required one, user info in the URL, a host not in AllowedHosts (on EVERY hop),
# more than MaxRedirects redirects (0 = any redirect is refused), a status other than 200, a Content-Length over MaxBytes, a body that
# grows past MaxBytes (the stream is aborted), a body shorter than its Content-Length. On any failure Dest is deleted and it throws.
function Invoke-BoundedDownload {
  param(
    [string]$Url, [string]$Dest, [long]$MaxBytes, [string[]]$AllowedHosts,
    [int]$MaxRedirects = 0, [bool]$RequireHttps = $true, [int]$TimeoutSec = 60
  )
  try { [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12 } catch { }
  $cur = $Url
  $ok = $false
  try {
    for ($hop = 0; $hop -le $MaxRedirects; $hop++) {
      $u = New-Object System.Uri($cur)
      $want = 'https'
      if (-not $RequireHttps) { $want = 'http' }
      if ($u.Scheme -ne $want) { throw "refused: $($u.Scheme) is not allowed here (need $want)" }
      if (-not [string]::IsNullOrEmpty($u.UserInfo)) { throw 'refused: the URL carries user info' }
      if (@($AllowedHosts) -notcontains $u.Host.ToLowerInvariant()) { throw "refused: host $($u.Host) is not on the allowed list" }
      $req = [System.Net.HttpWebRequest]::Create($u)
      $req.AllowAutoRedirect = $false
      $req.Timeout = $TimeoutSec * 1000
      $req.ReadWriteTimeout = $TimeoutSec * 1000
      $req.UserAgent = 'Legion-Setup'
      if ($u.Host -eq '127.0.0.1') { $req.Proxy = $null }   # only reachable in test mode (loopback fake server)
      $resp = $null
      try { $resp = $req.GetResponse() }
      catch [System.Net.WebException] { $resp = $_.Exception.Response; if ($null -eq $resp) { throw } }
      try {
        $code = [int]$resp.StatusCode
        if ($code -ge 300 -and $code -lt 400) {
          if ($hop -ge $MaxRedirects) { throw "refused: the server redirected (HTTP $code) and redirects are not allowed here" }
          $loc = $resp.Headers['Location']
          if ([string]::IsNullOrEmpty($loc)) { throw "refused: redirect (HTTP $code) without a Location" }
          $cur = (New-Object System.Uri($u, $loc)).AbsoluteUri
          continue
        }
        if ($code -ne 200) { throw "download failed: HTTP $code" }
        $len = $resp.ContentLength
        if ($len -gt $MaxBytes) { throw "refused: the file is $len bytes, over the limit of $MaxBytes" }
        $in = $resp.GetResponseStream()
        $out = [System.IO.File]::Create($Dest)
        try {
          $buf = New-Object byte[] 81920
          [long]$total = 0
          while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
            $total += $n
            if ($total -gt $MaxBytes) { throw "refused: the download grew past the limit of $MaxBytes bytes" }
            $out.Write($buf, 0, $n)
          }
        } finally { $out.Dispose(); $in.Dispose() }
        if ($len -ge 0 -and $total -ne $len) { throw "download truncated: got $total of $len bytes" }
        $ok = $true
        return
      } finally { $resp.Close() }
    }
    throw 'refused: too many redirects'
  } finally {
    if (-not $ok -and (Test-Path -LiteralPath $Dest)) { Remove-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue }
  }
}

$script:ReservedNames = '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$'

# Why an entry name from a zip is unsafe, or $null when it is fine.
function Get-ZipNameProblem {
  param([string]$Name)
  if ([string]::IsNullOrEmpty($Name)) { return 'empty name' }
  if ($Name.Contains('\')) { return 'backslash in name' }
  if ($Name.Contains(':')) { return 'colon in name' }
  if ($Name.StartsWith('/')) { return 'absolute path' }
  foreach ($c in $Name.ToCharArray()) { if ([int]$c -lt 32) { return 'control character in name' } }
  $segs = $Name.TrimEnd('/').Split('/')
  foreach ($s in $segs) {
    if ($s -eq '') { return 'empty path segment' }
    if ($s -eq '.' -or $s -eq '..') { return 'dot segment' }
    if ($s.EndsWith('.') -or $s.EndsWith(' ')) { return 'segment ends with a dot or space' }
    if ($s -match $script:ReservedNames) { return 'reserved device name' }
  }
  return $null
}

# Extracts Zip into Dest (an existing, empty, Legion-made folder). Every entry is checked by name AND by its resolved path; sizes are
# counted from the bytes actually written. Throws on the first problem; the caller deletes Dest. Returns the number of files written.
function Expand-ZipSafe {
  param([string]$Zip, [string]$Dest, [int]$MaxEntries = 20000, [long]$MaxTotalBytes = 600MB)
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $destFull = [System.IO.Path]::GetFullPath($Dest).TrimEnd('\', '/')
  $sep = [System.IO.Path]::DirectorySeparatorChar
  $prefix = $destFull + $sep
  $archive = [System.IO.Compression.ZipFile]::OpenRead($Zip)
  try {
    if ($archive.Entries.Count -gt $MaxEntries) { throw "unsafe zip: $($archive.Entries.Count) entries (limit $MaxEntries)" }
    [long]$declared = 0
    $seen = @{}
    foreach ($e in $archive.Entries) {
      $problem = Get-ZipNameProblem $e.FullName
      if ($problem) { throw "unsafe zip entry '$($e.FullName)': $problem" }
      $key = $e.FullName.TrimEnd('/').ToLowerInvariant()
      if ($seen.ContainsKey($key)) { throw "unsafe zip: duplicate entry '$($e.FullName)'" }
      $seen[$key] = $true
      $declared += $e.Length
      if ($declared -gt $MaxTotalBytes) { throw "unsafe zip: unpacked size over $MaxTotalBytes bytes" }
    }
    [long]$written = 0
    $files = 0
    foreach ($e in $archive.Entries) {
      $isDir = $e.FullName.EndsWith('/')
      $target = [System.IO.Path]::GetFullPath((Join-Path $destFull ($e.FullName.TrimEnd('/').Replace('/', [string]$sep))))
      if (-not $target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw "unsafe zip entry '$($e.FullName)': it resolves outside the target folder" }
      if ($isDir) { [void][System.IO.Directory]::CreateDirectory($target); continue }
      $parent = [System.IO.Path]::GetDirectoryName($target)
      [void][System.IO.Directory]::CreateDirectory($parent)
      $in = $e.Open()
      $out = [System.IO.File]::Create($target)
      try {
        $buf = New-Object byte[] 81920
        while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
          $written += $n
          if ($written -gt $MaxTotalBytes) { throw "unsafe zip: unpacked size over $MaxTotalBytes bytes" }
          $out.Write($buf, 0, $n)
        }
      } finally { $out.Dispose(); $in.Dispose() }
      $files++
      if ($sep -eq '/') { try { [System.IO.File]::SetUnixFileMode($target, [System.IO.UnixFileMode]'UserRead,UserWrite,UserExecute') } catch { } }
    }
    return $files
  } finally { $archive.Dispose() }
}
