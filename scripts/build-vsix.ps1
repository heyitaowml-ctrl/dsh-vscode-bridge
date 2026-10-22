param(
  [switch]$Install
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'vscode-dsh-bridge'
$dist = Join-Path $root 'dist'
$version = '1.0.0'
$dest = Join-Path $dist "dsh-vscode-bridge-$version.vsix"

New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path -LiteralPath $dest) {
  Remove-Item -LiteralPath $dest -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$entries = @(
  @{ Source = (Join-Path $src 'vsix\[Content_Types].xml'); Entry = '[Content_Types].xml' },
  @{ Source = (Join-Path $src 'vsix\extension.vsixmanifest'); Entry = 'extension.vsixmanifest' },
  @{ Source = (Join-Path $src 'package.json'); Entry = 'extension/package.json' },
  @{ Source = (Join-Path $src 'extension.js'); Entry = 'extension/extension.js' },
  @{ Source = (Join-Path $src 'README.md'); Entry = 'extension/README.md' },
  @{ Source = (Join-Path $src 'CHANGELOG.md'); Entry = 'extension/CHANGELOG.md' },
  @{ Source = (Join-Path $src 'LICENSE.txt'); Entry = 'extension/LICENSE.txt' }
)

foreach ($entry in $entries) {
  if (-not (Test-Path -LiteralPath $entry.Source)) {
    throw "Missing VSIX source file: $($entry.Source)"
  }
}

$zip = [System.IO.Compression.ZipFile]::Open($dest, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($entry in $entries) {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zip,
      $entry.Source,
      $entry.Entry,
      [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
  }
} finally {
  $zip.Dispose()
}

$zip = [System.IO.Compression.ZipFile]::OpenRead($dest)
try {
  Write-Output "Built $dest ($((Get-Item -LiteralPath $dest).Length) bytes)"
  $zip.Entries | ForEach-Object { Write-Output ("  {0} ({1} bytes)" -f $_.FullName, $_.Length) }
} finally {
  $zip.Dispose()
}

if ($Install) {
  & code --install-extension $dest --force
  if ($LASTEXITCODE -ne 0) {
    throw "code --install-extension failed with exit code $LASTEXITCODE"
  }
}
