<#
.SYNOPSIS
    Builds antileak_id.dll, optionally stamped with a tester build id.

.DESCRIPTION
    antileak_id.c is compiled once into a template whose id slot is empty. The
    build id is stamped afterwards by patching the linked binary, so a stamped
    DLL can be produced with no compiler at all - that is what lets the Worker
    mint tester builds without a Windows runner.

    -BuildId <id>   compile the template, then stamp it (the original behaviour,
                    so the existing tester-build workflow needs no changes)
    -Template       compile the template and leave the slot empty, for upload to
                    R2 where the Worker picks it up
#>
param(
    [string]$BuildId = "",
    [string]$OutDir = "$PSScriptRoot",
    [switch]$Template
)

$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\antileak_slot.ps1"

if ($Template -and $BuildId) { throw "-Template and -BuildId are mutually exclusive" }

$dll = Join-Path $OutDir "antileak_id.dll"
cl.exe /LD /nologo /O2 /Fo:"$OutDir\" /Fe:"$dll" "$PSScriptRoot\antileak_id.c"
if ($LASTEXITCODE -ne 0) { throw "DLL compile failed" }

foreach ($junk in 'antileak_id.obj', 'antileak_id.exp', 'antileak_id.lib') {
    Remove-Item (Join-Path $OutDir $junk) -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $PSScriptRoot $junk) -Force -ErrorAction SilentlyContinue
}

$slot = Find-AntileakSlot -Bytes ([System.IO.File]::ReadAllBytes($dll))
Write-Host "Built antileak_id.dll (id slot at offset $slot)"

if ($BuildId) {
    Set-AntileakBuildId -Path $dll -BuildId $BuildId | Out-Null
    Write-Host "Stamped antileak_id.dll for build_id=$BuildId"
}
else {
    Write-Host "Template left unstamped (empty id -> fail-closed until stamped)"
}
