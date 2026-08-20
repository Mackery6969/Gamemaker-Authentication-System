#include <windows.h>
#include <shellapi.h>

#pragma comment(lib, "shell32.lib")

__declspec(dllexport) double antileak_launch_process(const char* path, const char* args) {
    HINSTANCE result = ShellExecuteA(NULL, "open", path, args, NULL, SW_SHOWNORMAL);
    return (double)((INT_PTR)result > 32);
}

__declspec(dllexport) double antileak_is_wine(void) {
    HMODULE ntdll = GetModuleHandleA("ntdll.dll");
    if (!ntdll) return 0.0;
    return (double)(GetProcAddress(ntdll, "wine_get_version") != NULL);
}
