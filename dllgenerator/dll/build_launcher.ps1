param(
    [string]$OutDir = "$PSScriptRoot"
)

# Unlike antileak_id.dll, this one is identical for every build - it's just a
# thin process-launch/Wine-detection helper, nothing tester-specific to bake
# in. Build it once and copy antileak_launcher.dll into your GameMaker
# project's extension folder (see ../../gamemaker/README.md).

cl.exe /LD /nologo /O2 /Fe:"$OutDir\antileak_launcher.dll" "$PSScriptRoot\antileak_launcher.c"
if ($LASTEXITCODE -ne 0) { throw "DLL compile failed" }

Remove-Item (Join-Path $PSScriptRoot "antileak_launcher.obj") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $OutDir "antileak_launcher.exp") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $OutDir "antileak_launcher.lib") -Force -ErrorAction SilentlyContinue
Write-Host "Built antileak_launcher.dll -> $OutDir"
