[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$PublishRegistry = "https://registry.npmjs.org/",
    [string]$RestoreRegistry = "",
    [string]$Access = "public",
    [string]$Otp = ""
)

$ErrorActionPreference = "Stop"
$userNpmrcPath = Join-Path $HOME ".npmrc"
$originalRegistry = ""

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

function Test-NpmLogin {
    param(
        [string]$Registry
    )

    & npm whoami --registry $Registry *> $null
    return $LASTEXITCODE -eq 0
}

function Show-UserNpmrcIfPresent {
    if (-not (Test-Path $userNpmrcPath)) {
        return
    }

    $item = Get-Item $userNpmrcPath -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::Hidden) -ne 0) {
        $item.Attributes = $item.Attributes -bxor [System.IO.FileAttributes]::Hidden
    }
}

function Hide-UserNpmrcIfPresent {
    if (-not (Test-Path $userNpmrcPath)) {
        return
    }

    $item = Get-Item $userNpmrcPath -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::Hidden) -eq 0) {
        $item.Attributes = $item.Attributes -bor [System.IO.FileAttributes]::Hidden
    }
}

$resolvedProjectRoot = (Resolve-Path $ProjectRoot).Path
$packageJsonPath = Join-Path $resolvedProjectRoot "package.json"

if (-not (Test-Path $packageJsonPath)) {
    throw "package.json not found under project root: $resolvedProjectRoot"
}

Push-Location $resolvedProjectRoot
try {
    Show-UserNpmrcIfPresent
    $originalRegistry = (& npm config get registry).Trim()
    if (-not $RestoreRegistry) {
        $RestoreRegistry = $originalRegistry
    }

    Invoke-Step -FilePath "npm" -Arguments @("config", "set", "registry", $PublishRegistry) -Description "Switch npm registry to the publish registry"
    Invoke-Step -FilePath "npm" -Arguments @("config", "get", "registry") -Description "Verify the npm publish registry"

    if (-not (Test-NpmLogin -Registry $PublishRegistry)) {
        Invoke-Step -FilePath "npm" -Arguments @("login", "--registry", $PublishRegistry) -Description "Log in to npm before publishing"
    }

    $publishArgs = @("publish", "--access", $Access)
    if ($Otp) {
        $publishArgs += "--otp=$Otp"
    }

    Invoke-Step -FilePath "npm" -Arguments $publishArgs -Description "Publish the package to npm"
}
finally {
    try {
        if ($RestoreRegistry) {
            Invoke-Step -FilePath "npm" -Arguments @("config", "set", "registry", $RestoreRegistry) -Description "Restore the original npm registry"
            Invoke-Step -FilePath "npm" -Arguments @("config", "get", "registry") -Description "Verify the restored npm registry"
        }
    }
    finally {
        Hide-UserNpmrcIfPresent
        Pop-Location
    }
}

Write-Host ""
Write-Host "npm publish flow completed."
Write-Host "Publish registry: $PublishRegistry"
Write-Host "Registry restored to: $RestoreRegistry"
