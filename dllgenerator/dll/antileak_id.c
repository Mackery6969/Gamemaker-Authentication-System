#include <stddef.h>

/* Placeholder values - build.ps1 regenerates both of these (a fresh random
   key + the XOR-encoded build id) every time it runs, so what's checked in
   here never actually gets compiled as-is. See build.ps1 / README.md. */
static const unsigned char XOR_KEY[] = "REPLACE_ME";
static const unsigned char ENCODED_ID[] = { 0x00 };
static const size_t ENCODED_ID_LEN = 1;

__declspec(dllexport) const char* antileak_get_build_id(void) {
    static char decoded[256];
    size_t key_len = sizeof(XOR_KEY) - 1;
    size_t i;
    for (i = 0; i < ENCODED_ID_LEN && i < sizeof(decoded) - 1; i++) {
        decoded[i] = (char)(ENCODED_ID[i] ^ XOR_KEY[i % key_len]);
    }
    decoded[i] = '\0';
    return decoded;
}
