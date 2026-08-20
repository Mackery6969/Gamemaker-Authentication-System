param(
    [string]$OutDir = "$PSScriptRoot"
)

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
cl.exe /nologo /O2 /W3 /D_CRT_SECURE_NO_WARNINGS /Fo:"$OutDir\" /Fe:"$OutDir\updater.exe" "$PSScriptRoot\updater.c" "$PSScriptRoot\miniz.c" /link /SUBSYSTEM:WINDOWS
if ($LASTEXITCODE -ne 0) { throw "build failed" }

Remove-Item (Join-Path $OutDir "updater.obj") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $OutDir "miniz.obj") -Force -ErrorAction SilentlyContinue
Write-Host "Built updater.exe -> $OutDir"
