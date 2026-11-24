$ErrorActionPreference = "Stop"

$GuiDir = Join-Path $PSScriptRoot "gui"
if (-not (Test-Path $GuiDir)) {
    Write-Error "GUI directory not found at $GuiDir"
    exit 1
}

Push-Location $GuiDir
try {
    npm run tauri build
}
finally {
    Pop-Location
}
