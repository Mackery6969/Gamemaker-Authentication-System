#include <stddef.h>

#define AL_MAGIC_LEN 16
#define AL_KEY_MAX 64
#define AL_ID_MAX 200
#define AL_SIG_MAX 32

#define AL_KEYLEN_OFF AL_MAGIC_LEN
#define AL_KEY_OFF (AL_KEYLEN_OFF + 1)
#define AL_IDLEN_OFF (AL_KEY_OFF + AL_KEY_MAX)
#define AL_ID_OFF (AL_IDLEN_OFF + 1)
#define AL_SIGLEN_OFF (AL_ID_OFF + AL_ID_MAX)
#define AL_SIG_OFF (AL_SIGLEN_OFF + 1)
#define AL_SLOT_SIZE (AL_SIG_OFF + AL_SIG_MAX)

static volatile unsigned char ID_SLOT[AL_SLOT_SIZE] =
    "\x9e\x41\xd7\x2b\x6c\xf3\x18\xa5\x7d\xe0\x34\xbb\x52\xc9\x86\x1f";

__declspec(dllexport) const char *antileak_get_build_id(void)
{
    static char decoded[AL_ID_MAX + 1];
    size_t key_len = (size_t)ID_SLOT[AL_KEYLEN_OFF];
    size_t n = (size_t)ID_SLOT[AL_IDLEN_OFF];
    size_t i;

    if (key_len == 0 || key_len > AL_KEY_MAX || n > AL_ID_MAX)
        n = 0;
    for (i = 0; i < n; i++)
    {
        decoded[i] = (char)(ID_SLOT[AL_ID_OFF + i] ^ ID_SLOT[AL_KEY_OFF + (i % key_len)]);
    }
    decoded[i] = '\0';
    return decoded;
}

__declspec(dllexport) const char *antileak_get_build_sig(void)
{
    static const char HEXD[] = "0123456789abcdef";
    static char hex[AL_SIG_MAX * 2 + 1];
    size_t n = (size_t)ID_SLOT[AL_SIGLEN_OFF];
    size_t i;

    if (n > AL_SIG_MAX)
        n = 0;
    for (i = 0; i < n; i++)
    {
        hex[i * 2] = HEXD[(ID_SLOT[AL_SIG_OFF + i] >> 4) & 0x0f];
        hex[i * 2 + 1] = HEXD[ID_SLOT[AL_SIG_OFF + i] & 0x0f];
    }
    hex[i * 2] = '\0';
    return hex;
}
