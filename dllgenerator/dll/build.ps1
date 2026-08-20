param(
    [string]$BuildId = "DEV",
    [string]$OutDir = "$PSScriptRoot"
)

# Each build gets its own freshly-generated random key - there's no reason
# for it to be consistent across builds (every DLL is self-contained: the key
# and the encoded id are baked in together, atomically, right here) and not
# reusing one means there's no single secret that, if this repo is shared,
# would tell anyone anything about builds you've already shipped.
#
# This is casual obfuscation, not real security - anyone who dumps strings
# from one compiled DLL and understands single-byte-repeating-key XOR can
# recover that DLL's id. The actual anti-leak enforcement happens server-side
# (see ../../site) via Discord membership checks; this DLL just carries an
# opaque watermark so a leaked build can be traced back to whoever it was
# issued to.
function New-RandomKey([int]$Length = 16) {
    # Alphanumeric only - it's just XOR-key soup, no need for symbol entropy,
    # and this way there's no risk of landing on '"' or '\' and breaking the
    # C string literal it gets embedded into below.
    $alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    $bytes = New-Object byte[] $Length
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $chars = $bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] }
    return -join $chars
}

$Key = New-RandomKey

$keyBytes = [System.Text.Encoding]::ASCII.GetBytes($Key)
$idBytes = [System.Text.Encoding]::ASCII.GetBytes($BuildId)
$encoded = New-Object byte[] $idBytes.Length
for ($i = 0; $i -lt $idBytes.Length; $i++) {
    $encoded[$i] = $idBytes[$i] -bxor $keyBytes[$i % $keyBytes.Length]
}
$hexList = ($encoded | ForEach-Object { "0x{0:x2}" -f $_ }) -join ", "
if (-not $hexList) { $hexList = "0x00" }

$src = Get-Content "$PSScriptRoot\antileak_id.c" -Raw
$src = $src -replace 'static const unsigned char XOR_KEY\[\] = "[^"]*";', "static const unsigned char XOR_KEY[] = `"$Key`";"
$src = $src -replace 'static const unsigned char ENCODED_ID\[\] = \{[^}]*\};', "static const unsigned char ENCODED_ID[] = { $hexList };"
$src = $src -replace 'static const size_t ENCODED_ID_LEN = \d+;', "static const size_t ENCODED_ID_LEN = $($idBytes.Length);"
$tmpSrc = Join-Path $OutDir "antileak_id_generated.c"
Set-Content -Path $tmpSrc -Value $src -NoNewline

cl.exe /LD /nologo /O2 /Fe:"$OutDir\antileak_id.dll" $tmpSrc
if ($LASTEXITCODE -ne 0) { Remove-Item $tmpSrc -Force -ErrorAction SilentlyContinue; throw "DLL compile failed" }

Remove-Item $tmpSrc -Force
Remove-Item (Join-Path $OutDir "antileak_id_generated.obj") -Force -ErrorAction SilentlyContinue
Write-Host "Built antileak_id.dll for build_id=$BuildId"
