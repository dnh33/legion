# Rehearsal-only: opens a file with no sharing and holds it, so a rename of a folder above it fails the way an open file does.
param([Parameter(Mandatory = $true)][string]$Path)
$fs = [System.IO.File]::Open($Path, 'Open', 'Read', 'None')
Write-Host 'locked'
while ($true) { Start-Sleep -Seconds 1 }
