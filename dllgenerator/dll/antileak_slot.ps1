$script:AntileakMagic = [byte[]](0x9e, 0x41, 0xd7, 0x2b, 0x6c, 0xf3, 0x18, 0xa5, 0x7d, 0xe0, 0x34, 0xbb, 0x52, 0xc9, 0x86, 0x1f)
$script:AntileakKeyMax = 64
$script:AntileakKeyLen = 32
$script:AntileakIdMax = 200
$script:AntileakSigMax = 32

$script:AntileakKeyLenOff = $script:AntileakMagic.Length
$script:AntileakKeyOff = $script:AntileakKeyLenOff + 1
$script:AntileakIdLenOff = $script:AntileakKeyOff + $script:AntileakKeyMax
$script:AntileakIdOff = $script:AntileakIdLenOff + 1
$script:AntileakSigLenOff = $script:AntileakIdOff + $script:AntileakIdMax
$script:AntileakSigOff = $script:AntileakSigLenOff + 1

function Find-AntileakSlot {
    param([Parameter(Mandatory)][byte[]]$Bytes)

    $needle = $script:AntileakMagic
    $hits = @()
    $last = $Bytes.Length - $needle.Length
    for ($i = 0; $i -le $last; $i++) {
        if ($Bytes[$i] -ne $needle[0]) { continue }
        $match = $true
        for ($j = 1; $j -lt $needle.Length; $j++) {
            if ($Bytes[$i + $j] -ne $needle[$j]) { $match = $false; break }
        }
        if ($match) { $hits += $i }
    }

    if ($hits.Count -ne 1) {
        throw "expected exactly 1 id slot in the binary, found $($hits.Count) - antileak_id.c or the compiler flags changed"
    }
    return $hits[0]
}

function Set-AntileakBuildId {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$BuildId,
        [string]$Signature = ""
    )

    $idBytes = [System.Text.Encoding]::ASCII.GetBytes($BuildId)
    if ($idBytes.Length -eq 0) { throw "build id is empty" }
    if ($idBytes.Length -gt $script:AntileakIdMax) {
        throw "build id is $($idBytes.Length) bytes, max is $($script:AntileakIdMax)"
    }

    $sigBytes = [byte[]]@()
    if ($Signature -ne "") {
        if ($Signature -notmatch '^[0-9a-fA-F]+$' -or ($Signature.Length % 2) -ne 0) {
            throw "signature must be an even-length hex string"
        }
        $sigBytes = New-Object byte[] ($Signature.Length / 2)
        for ($i = 0; $i -lt $sigBytes.Length; $i++) {
            $sigBytes[$i] = [Convert]::ToByte($Signature.Substring($i * 2, 2), 16)
        }
        if ($sigBytes.Length -gt $script:AntileakSigMax) {
            throw "signature is $($sigBytes.Length) bytes, max is $($script:AntileakSigMax)"
        }
    }
    $key = New-Object byte[] $script:AntileakKeyLen
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($key)

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $slot = Find-AntileakSlot -Bytes $bytes

    $bytes[$slot + $script:AntileakKeyLenOff] = [byte]$key.Length
    for ($i = 0; $i -lt $key.Length; $i++) { $bytes[$slot + $script:AntileakKeyOff + $i] = $key[$i] }
    $bytes[$slot + $script:AntileakIdLenOff] = [byte]$idBytes.Length
    for ($i = 0; $i -lt $idBytes.Length; $i++) {
        $bytes[$slot + $script:AntileakIdOff + $i] = $idBytes[$i] -bxor $key[$i % $key.Length]
    }
    $bytes[$slot + $script:AntileakSigLenOff] = [byte]$sigBytes.Length
    for ($i = 0; $i -lt $sigBytes.Length; $i++) {
        $bytes[$slot + $script:AntileakSigOff + $i] = $sigBytes[$i]
    }

    [System.IO.File]::WriteAllBytes($Path, $bytes)
    return $slot
}
