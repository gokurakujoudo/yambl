$ErrorActionPreference = 'Stop'
$codeRoot = Split-Path (Split-Path (Get-Command code -ErrorAction Stop).Path -Parent) -Parent
$previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    & (Join-Path $codeRoot 'Code.exe') (Join-Path $PSScriptRoot 'test.cjs') | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Highlighting checks failed: $LASTEXITCODE" }
} finally {
    $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode
}
