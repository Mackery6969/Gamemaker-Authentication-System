$script:AntileakMagic = [byte[]](0x9e, 0x41, 0xd7, 0x2b, 0x6c, 0xf3, 0x18, 0xa5, 0x7d, 0xe0, 0x34, 0xbb, 0x52, 0xc9, 0x86, 0x1f)
$script:AntileakKeyMax = 64
$script:AntileakKeyLen = 32
$script:AntileakIdMax = 200

$script:AntileakKeyLenOff = $script:AntileakMagic.Length
$script:AntileakKeyOff = $script:AntileakKeyLenOff + 1
$script:AntileakIdLenOff = $script:AntileakKeyOff + $script:AntileakKeyMax
$script:AntileakIdOff = $script:AntileakIdLenOff + 1

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
        [Parameter(Mandatory)][string]$BuildId
    )

    $idBytes = [System.Text.Encoding]::ASCII.GetBytes($BuildId)
    if ($idBytes.Length -eq 0) { throw "build id is empty" }
    if ($idBytes.Length -gt $script:AntileakIdMax) {
        throw "build id is $($idBytes.Length) bytes, max is $($script:AntileakIdMax)"
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

    [System.IO.File]::WriteAllBytes($Path, $bytes)
    return $slot
}
