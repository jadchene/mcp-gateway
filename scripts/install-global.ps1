[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$ExampleConfigPath = "",
    [switch]$KeepTarball
)

$ErrorActionPreference = "Stop"

function Invoke-Step {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$Description
    )

    $argumentText = if ($Arguments.Count -gt 0) { $Arguments -join " " } else { "" }
    $target = if ($argumentText) { "$FilePath $argumentText" } else { $FilePath }

    if ($PSCmdlet.ShouldProcess($target, $Description)) {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code ${LASTEXITCODE}: $target"
        }
    }
}

function Invoke-CaptureStep {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$Description
    )

    $argumentText = if ($Arguments.Count -gt 0) { $Arguments -join " " } else { "" }
    $target = if ($argumentText) { "$FilePath $argumentText" } else { $FilePath }

    if ($PSCmdlet.ShouldProcess($target, $Description)) {
        $output = & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code ${LASTEXITCODE}: $target"
        }

        return $output
    }

    return @()
}

function Resolve-PackedTarballPath {
    param(
        [string[]]$PackOutput,
        [string]$ProjectRoot
    )

    if ($PackOutput.Count -eq 0) {
        throw "npm pack did not return package metadata."
    }

    $parsedOutput = $PackOutput -join "`n" | ConvertFrom-Json
    $packInfo = if ($parsedOutput -is [System.Array]) {
        $parsedOutput[0]
    }
    else {
        @($parsedOutput.PSObject.Properties.Value)[0]
    }
    $filename = [string]$packInfo.filename

    if ([string]::IsNullOrWhiteSpace($filename)) {
        throw "npm pack metadata did not contain a tarball filename."
    }
    if ([IO.Path]::GetFileName($filename) -ne $filename -or [IO.Path]::GetExtension($filename) -ne ".tgz") {
        throw "npm pack returned an unsafe tarball filename: $filename"
    }

    $tarballPath = [IO.Path]::GetFullPath((Join-Path $ProjectRoot $filename))
    $tarballParent = [IO.Path]::GetDirectoryName($tarballPath)
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals($tarballParent, $ProjectRoot)) {
        throw "npm pack returned a tarball outside the project root: $tarballPath"
    }
    if (-not (Test-Path -LiteralPath $tarballPath -PathType Leaf)) {
        throw "Packed tarball was not created: $tarballPath"
    }

    return $tarballPath
}

$resolvedProjectRoot = (Resolve-Path $ProjectRoot).Path
$packageJsonPath = Join-Path $resolvedProjectRoot "package.json"
$defaultConfigPath = Join-Path $resolvedProjectRoot "config.example.json"
$resolvedConfigPath = if ($ExampleConfigPath) { $ExampleConfigPath } else { $defaultConfigPath }

if (-not (Test-Path $packageJsonPath)) {
    throw "package.json not found under project root: $resolvedProjectRoot"
}

$packageInfo = Get-Content -Raw $packageJsonPath | ConvertFrom-Json
$packageName = [string]$packageInfo.name
if ([string]::IsNullOrWhiteSpace($packageName)) {
    throw "package.json does not contain a package name."
}

Push-Location $resolvedProjectRoot
try {
    Invoke-Step -FilePath "npm" -Arguments @("install") -Description "Install project dependencies"
    Invoke-Step -FilePath "npm" -Arguments @("run", "build") -Description "Build the MCP gateway"
    $packOutput = Invoke-CaptureStep -FilePath "npm" -Arguments @("pack", "--json") -Description "Create a package tarball for global installation"
    $tarballPath = Resolve-PackedTarballPath -PackOutput $packOutput -ProjectRoot $resolvedProjectRoot

    Invoke-Step -FilePath "npm" -Arguments @("uninstall", "-g", $packageName) -Description "Remove any previous global installation of $packageName"

    Invoke-Step -FilePath "npm" -Arguments @("install", "-g", $tarballPath) -Description "Install the packaged mcp-gateway-service tarball globally"

    if (-not $KeepTarball -and (Test-Path -LiteralPath $tarballPath -PathType Leaf)) {
        Remove-Item -LiteralPath $tarballPath -Force
    }
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "Global installation completed."
Write-Host "Command: mcp-gateway-service"
Write-Host "Example start command:"
Write-Host "  mcp-gateway-service"
Write-Host ""
Write-Host "Example MCP server configuration:"

$example = @{
    mcpServers = @{
        gateway = @{
            command = "mcp-gateway-service"
            args = @(
                "--config",
                $resolvedConfigPath
            )
        }
    }
} | ConvertTo-Json -Depth 6

Write-Host $example
