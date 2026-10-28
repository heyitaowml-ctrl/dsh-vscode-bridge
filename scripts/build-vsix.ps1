# Packages the VS Code extension half with the official vsce CLI.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File packages/scripts/build-vsix.ps1
#   powershell ... -File packages/scripts/build-vsix.ps1 -Install
#
# vsce generates the VSIX manifest and [Content_Types].xml itself, which is why the
# hand-maintained copies that used to live in vscode-dsh-bridge/vsix/ are gone: they
# hard-coded Publisher="local" and could not carry a PNG icon.
#
# Publishing to the Marketplace (one-time setup is in the README):
#   1. create a publisher at https://marketplace.visualstudio.com/manage
#   2. create an Azure DevOps PAT with the Marketplace > Manage scope
#   3. $env:VSCE_PAT = '<pat>'
#   4. powershell ... -File packages/scripts/build-vsix.ps1 -Publish

param(
  [switch]$Install,
  [switch]$Publish
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$ext = Join-Path $root 'vscode-dsh-bridge'
$dist = Join-Path $root 'dist'
$vsix = Join-Path $dist 'dsh-vscode-bridge.vsix'

if (-not (Test-Path $ext)) { throw "extension directory not found: $ext" }
New-Item -ItemType Directory -Force -Path $dist | Out-Null

# The repository uses `master`; vsce would otherwise rewrite relative README links
# against `main` and point them at files that do not exist.
Push-Location $ext
try {
  if ($Publish) {
    if (-not $env:VSCE_PAT) { throw 'VSCE_PAT is not set; create an Azure DevOps PAT with the Marketplace > Manage scope first' }
    npx --yes @vscode/vsce publish --githubBranch master
    if ($LASTEXITCODE -ne 0) { throw "vsce publish failed with exit code $LASTEXITCODE" }
  } else {
    npx --yes @vscode/vsce package --githubBranch master --out $vsix
    if ($LASTEXITCODE -ne 0) { throw "vsce package failed with exit code $LASTEXITCODE" }
    Write-Output ("Built {0} ({1} bytes)" -f $vsix, (Get-Item -LiteralPath $vsix).Length)

    # The DSH package carries a copy so `dsh plugin add` can offer a one-click
    # install with no network fetch. Keep the two from drifting.
    $bundled = Join-Path $root 'dsh-vscode-bridge\dsh-vscode-bridge.vsix'
    Copy-Item -LiteralPath $vsix -Destination $bundled -Force
    Write-Output ("Synced {0}" -f $bundled)
  }
} finally {
  Pop-Location
}

if ($Install) {
  & code --install-extension $vsix --force
  if ($LASTEXITCODE -ne 0) { throw "code --install-extension failed with exit code $LASTEXITCODE" }
}
