/* Local test fixture: calls the real registration API, never installs updates. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <wchar.h>
#ifdef FIXTURE_DLL
__declspec(dllexport) HRESULT WINAPI fixture_register(void) {
    return RegisterApplicationRestart(L"--codlet-fixture", 0);
}
#else
int wmain(int argc, wchar_t **argv) {
    if (argc < 4) return 2;
    HMODULE target = LoadLibraryW(argv[2]), other = LoadLibraryW(argv[3]);
    if (!target || !other) return 3;
    typedef HRESULT (WINAPI *Call)(void);
    Call run = (Call)GetProcAddress(target, "fixture_register");
    Call unrelated = (Call)GetProcAddress(other, "fixture_register");
    wchar_t request[4096], response[4096];
    _snwprintf(request, 4096, L"%ls/request", argv[1]);
    _snwprintf(response, 4096, L"%ls/response", argv[1]);
    for (int tries = 0; tries < 6000; tries++) {
        FILE *file = _wfopen(request, L"rb");
        if (!file) { Sleep(10); continue; }
        int command = fgetc(file); fclose(file); DeleteFileW(request);
        if (command == 'q') return 0;
        if (command == 'x') { run(); return 0; }
        HRESULT result = command == 'r' ? run() : command == 'o' ? unrelated() : S_OK;
        if (command == 'u') UnregisterApplicationRestart();
        wchar_t text[1024]; DWORD length = 1024, flags = 0;
        HRESULT registered = GetApplicationRestartSettings(GetCurrentProcess(), text, &length, &flags);
        file = _wfopen(response, L"wb");
        if (!file) return 4;
        fprintf(file, "{\"call\":%ld,\"registered\":%s}", (long)result, registered == S_OK ? "true" : "false");
        fclose(file);
    }
    return 5;
}
#endif
