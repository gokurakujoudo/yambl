[CmdletBinding()]
param([switch]$PackageOnly)

$ErrorActionPreference = 'Stop'
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json
$buildDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../build/vscode'))
[IO.Directory]::CreateDirectory($buildDirectory) | Out-Null
$vsixPath = Join-Path $buildDirectory "$($manifest.name)-$($manifest.version).vsix"

# Package the extension and its complete language server; no npm installation is needed.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [IO.File]::Open($vsixPath, [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite)
$archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in @('package.json', 'language-configuration.json', 'syntaxes/yambl.tmLanguage.json', 'README.md', 'extension.cjs')) {
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, (Join-Path $PSScriptRoot $file), "extension/$file"
        ) | Out-Null
    }
    $lspRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../lsp'))
    foreach ($relative in @('server.cjs', 'service.cjs', 'repository.cjs', 'protocol.cjs', 'language/syntax.cjs', 'language/validation.cjs', 'language/relationships.cjs', 'language/expressions.cjs', 'README.md')) {
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, (Join-Path $lspRoot $relative), "extension/lsp/$relative"
        ) | Out-Null
    }
    $modelsRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../lang'))
    foreach ($model in Get-ChildItem -LiteralPath $modelsRoot -File -Recurse | Where-Object { $_.Extension -in '.yambl', '.lclcfg' }) {
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $model.FullName, "extension/lsp/lang/$([IO.Path]::GetRelativePath($modelsRoot, $model.FullName).Replace('\', '/'))") | Out-Null
    }
    $documents = @{
        '[Content_Types].xml' = @'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="yambl" ContentType="text/plain" />
  <Default Extension="lclcfg" ContentType="text/plain" />
  <Default Extension="cjs" ContentType="application/javascript" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>
'@
        'extension.vsixmanifest' = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="$($manifest.name)" Version="$($manifest.version)" Publisher="$($manifest.publisher)" />
    <DisplayName>YAMBL</DisplayName>
    <Description xml:space="preserve">YAMBL highlighting and language server.</Description>
    <Categories>Programming Languages</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$($manifest.engines.vscode)" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>
"@
    }
    foreach ($name in $documents.Keys) {
        $writer = [IO.StreamWriter]::new($archive.CreateEntry($name).Open(), [Text.UTF8Encoding]::new($false))
        try { $writer.Write($documents[$name]) } finally { $writer.Dispose() }
    }
} finally {
    $archive.Dispose()
}

Write-Output "Packaged $vsixPath"
if (-not $PackageOnly) {
    $codeCommand = Get-Command code -ErrorAction Stop
    & $codeCommand.Path --install-extension $vsixPath --force
    if ($LASTEXITCODE -ne 0) { throw "VS Code installation failed: $LASTEXITCODE" }
    Write-Output 'Installed YAMBL. Reload the VS Code window if it is already open.'
}
