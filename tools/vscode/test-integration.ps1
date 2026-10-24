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
[IO.File]::WriteAllText((Join-Path $workspace 'yambl-root.lclcfg'), "prefix: ''")
[IO.File]::WriteAllText((Join-Path $workspace 'base.yambl'), 'namespace core entity Base {}')
[IO.File]::WriteAllText((Join-Path $workspace 'decodes.yambl'), 'namespace core decodes Currencies {}')
[IO.File]::WriteAllText((Join-Path $workspace 'child.yambl'), @'
namespace core
entity Child inherits Base{
@title('Currencies')
@description('Child\'s currencies')
attr kinds:values<code<'Currencies'>>
attr currency:code<Currencies>
attr source:code<'PriceSources'>
attr price:decimal[precision:18,scale:4]
attr dynamic:code<Missing>
}
'@)
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $build "$($manifest.name)-$($manifest.version).vsix"), (Join-Path $testRoot 'package'))
$codeRoot = Split-Path (Split-Path (Get-Command code -ErrorAction Stop).Path -Parent) -Parent
$codeArgs = @('--new-window', '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu',
    "--user-data-dir=`"$profile`"", "--extensions-dir=`"$(Join-Path $testRoot 'extensions')`"",
    "--extensionDevelopmentPath=`"$(Join-Path $testRoot 'package/extension')`"",
    "--extensionTestsPath=`"$(Join-Path $PSScriptRoot 'tests/integration.cjs')`"", "`"$workspace`"")
$process = Start-Process -FilePath (Join-Path $codeRoot 'Code.exe') -ArgumentList $codeArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $testRoot 'stdout.log') -RedirectStandardError (Join-Path $testRoot 'stderr.log')
Write-Output "Integration logs: $testRoot"
if (-not $process.WaitForExit(45000)) {
    $process.Kill($true)
    throw "VS Code test timed out; its isolated process tree was stopped. Inspect $testRoot."
}
$resultPath = Join-Path $workspace 'result.json'
if (-not (Test-Path -LiteralPath $resultPath)) { throw "VS Code exited with code $($process.ExitCode) before returning test results. Inspect $testRoot/stdout.log and stderr.log." }
$result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
if (-not $result.ok) { throw $result.error }
Write-Output ('Passed packaged VS Code integration: ' + ($result.features -join ', '))
