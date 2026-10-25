$ErrorActionPreference = 'Stop'
$codeRoot = Split-Path (Split-Path (Get-Command code -ErrorAction Stop).Path -Parent) -Parent
$previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    & (Join-Path $codeRoot 'Code.exe') (Join-Path $PSScriptRoot 'test.cjs') | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Highlighting checks failed: $LASTEXITCODE" }
    $testRoot = Join-Path $PSScriptRoot '../lsp/tests'
    & (Join-Path $codeRoot 'Code.exe') --test (Join-Path $testRoot 'language.test.cjs') (Join-Path $testRoot 'service.test.cjs') (Join-Path $testRoot 'protocol.test.cjs') (Join-Path $testRoot 'decorators.test.cjs') (Join-Path $testRoot 'constants.test.cjs') (Join-Path $testRoot 'computation.test.cjs') | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "LSP checks failed: $LASTEXITCODE" }
} finally {
    $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode
}
