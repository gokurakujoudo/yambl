[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'install.ps1') -PackageOnly
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json
$build = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../build/vscode'))
$testRoot = Join-Path $build ('integration-' + [Guid]::NewGuid().ToString('N'))
$workspace = Join-Path $testRoot 'workspace'
$profile = Join-Path $testRoot 'profile'
[IO.Directory]::CreateDirectory($workspace) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $profile 'User')) | Out-Null
[IO.File]::WriteAllText((Join-Path $profile 'User/settings.json'), '{"telemetry.telemetryLevel":"off","update.mode":"none","extensions.autoUpdate":false,"extensions.autoCheckUpdates":false,"window.restoreWindows":"none"}')
[IO.File]::WriteAllText((Join-Path $workspace 'yambl-root.lclcfg'), '')
[IO.File]::WriteAllText((Join-Path $workspace 'base.yambl'), 'namespace core entity Base {}')
[IO.File]::WriteAllText((Join-Path $workspace 'child.yambl'), "namespace core`nentity Child inherits Base{attr kind:code<Missing>}`n")
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $build "$($manifest.name)-$($manifest.version).vsix"), (Join-Path $testRoot 'package'))
$codeRoot = Split-Path (Split-Path (Get-Command code -ErrorAction Stop).Path -Parent) -Parent
$codeArgs = @('--new-window', '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu',
    "--user-data-dir=`"$profile`"", "--extensions-dir=`"$(Join-Path $testRoot 'extensions')`"",
    "--extensionDevelopmentPath=`"$(Join-Path $testRoot 'package/extension')`"",
    "--extensionTestsPath=`"$(Join-Path $PSScriptRoot 'tests/integration.cjs')`"", "`"$workspace`"")
$process = Start-Process -FilePath (Join-Path $codeRoot 'Code.exe') -ArgumentList $codeArgs -WindowStyle Hidden -PassThru
Write-Output "Integration logs: $testRoot"
if (-not $process.WaitForExit(45000)) {
    $process.Kill($true)
    throw "VS Code test timed out; its isolated process tree was stopped. Inspect $testRoot."
}
$result = Get-Content -LiteralPath (Join-Path $workspace 'result.json') -Raw | ConvertFrom-Json
if (-not $result.ok) { throw $result.error }
Write-Output ('Passed packaged VS Code integration: ' + ($result.features -join ', '))
