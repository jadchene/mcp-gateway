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

$resolvedProjectRoot = (Resolve-Path $ProjectRoot).Path
$packageJsonPath = Join-Path $resolvedProjectRoot "package.json"
$defaultConfigPath = Join-Path $resolvedProjectRoot "config.example.json"
$resolvedConfigPath = if ($ExampleConfigPath) { $ExampleConfigPath } else { $defaultConfigPath }
$packageName = "mcp-gateway-service"

if (-not (Test-Path $packageJsonPath)) {
    throw "package.json not found under project root: $resolvedProjectRoot"
}

$packageInfo = Get-Content -Raw $packageJsonPath | ConvertFrom-Json

Push-Location $resolvedProjectRoot
try {
    Invoke-Step -FilePath "npm" -Arguments @("install") -Description "Install project dependencies"
    Invoke-Step -FilePath "npm" -Arguments @("run", "build") -Description "Build the MCP gateway"
    $packOutput = Invoke-CaptureStep -FilePath "npm" -Arguments @("pack", "--json") -Description "Create a package tarball for global installation"
    if ($packOutput.Count -gt 0) {
        $packInfo = ($packOutput -join "`n" | ConvertFrom-Json)[0]
        $tarballPath = Join-Path $resolvedProjectRoot $packInfo.filename
    } else {
        $tarballPath = Join-Path $resolvedProjectRoot "$($packageInfo.name)-$($packageInfo.version).tgz"
    }

    try {
        Invoke-Step -FilePath "npm" -Arguments @("uninstall", "-g", $packageName) -Description "Remove any previous global installation of mcp-gateway-service"
    }
    catch {
        Write-Host "Previous global installation was not removed cleanly. Continuing with fresh install."
    }

    Invoke-Step -FilePath "npm" -Arguments @("install", "-g", $tarballPath) -Description "Install the packaged mcp-gateway-service tarball globally"

    if (-not $KeepTarball -and (Test-Path $tarballPath)) {
        Remove-Item $tarballPath -Force
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
