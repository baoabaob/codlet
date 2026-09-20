/* Session-scoped interception of the updater's Windows restart registration.
 * Loaded only in a child created by Core. No files, registry, executable code,
 * or imports outside the selected updater module are modified.
 * The documented RegisterApplicationRestart API has no external-launcher
 * argument. Its updater IAT slot is replaced while a live Core owns restart.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <wchar.h>
#include <string.h>

#define BRIDGE_MAGIC 0x43524c54u
#define BRIDGE_ABI 1u
#define PATH_CAP 2048
typedef struct {
    DWORD magic, abi, size, owner_pid;
    uintptr_t owner_handle;
    uintptr_t registration_event;
    volatile LONG enabled, stop, status, registrations, suppressed;
    volatile LONG last_error;
    WCHAR updater_path[PATH_CAP];
} Bridge;
typedef HRESULT (WINAPI *RegisterRestart)(PCWSTR, DWORD);
static Bridge *bridge;
static RegisterRestart original_register;
static PVOID volatile *slot;
static LONG initialized;
static SRWLOCK registration_lock = SRWLOCK_INIT;
static WCHAR saved_command[4096];
static DWORD saved_flags;
static int saved_registration;

static HRESULT WINAPI managed_restart(PCWSTR command, DWORD flags) {
    AcquireSRWLockExclusive(&registration_lock);
    Bridge *b = bridge;
    if (!b || !b->enabled || b->stop ||
        WaitForSingleObject((HANDLE)b->owner_handle, 0) != WAIT_TIMEOUT ||
        !command || wcsnlen(command, 4096) >= 4096) {
        ReleaseSRWLockExclusive(&registration_lock);
        return original_register(command, flags);
    }
    /* Remove any older registration, too. An updater cancellation does not
     * restart anything; Core requires installation state and package change. */
    HRESULT result = UnregisterApplicationRestart();
    if (FAILED(result)) {
        InterlockedExchange(&b->last_error, result);
        ReleaseSRWLockExclusive(&registration_lock);
        return result;
    }
    if (!SetEvent((HANDLE)b->registration_event)) {
        InterlockedExchange(&b->last_error, GetLastError());
        ReleaseSRWLockExclusive(&registration_lock);
        return original_register(command, flags);
    }
    wcscpy(saved_command, command); saved_flags = flags; saved_registration = 1;
    InterlockedIncrement(&b->suppressed);
    InterlockedIncrement(&b->registrations);
    ReleaseSRWLockExclusive(&registration_lock);
    return S_OK;
}

static int in_image(DWORD rva, SIZE_T bytes, DWORD size) {
    return rva && rva < size && bytes <= size - rva;
}
static int same_file(PCWSTR first, PCWSTR second) {
    HANDLE a = CreateFileW(first, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, 0, NULL);
    if (a == INVALID_HANDLE_VALUE) return 0;
    HANDLE b = CreateFileW(second, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, 0, NULL);
    if (b == INVALID_HANDLE_VALUE) { CloseHandle(a); return 0; }
    BY_HANDLE_FILE_INFORMATION left, right;
    int equal = GetFileInformationByHandle(a, &left) && GetFileInformationByHandle(b, &right) &&
        left.dwVolumeSerialNumber == right.dwVolumeSerialNumber &&
        left.nFileIndexHigh == right.nFileIndexHigh && left.nFileIndexLow == right.nFileIndexLow;
    CloseHandle(a); CloseHandle(b); return equal;
}

static int install(HMODULE module, Bridge *b) {
    BYTE *base = (BYTE*)module;
    MEMORY_BASIC_INFORMATION memory;
    if (!VirtualQuery(base, &memory, sizeof(memory)) || memory.Type != MEM_IMAGE ||
        memory.RegionSize < sizeof(IMAGE_NT_HEADERS))
        return 0;
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER*)base;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE || dos->e_lfanew <= 0 ||
        (SIZE_T)dos->e_lfanew > memory.RegionSize - sizeof(IMAGE_NT_HEADERS)) return 0;
    IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS*)(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE || nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR_MAGIC)
        return 0;
    DWORD size = nt->OptionalHeader.SizeOfImage;
    IMAGE_DATA_DIRECTORY imports = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (!in_image(imports.VirtualAddress, imports.Size, size)) return 0;
    RegisterRestart expected = (RegisterRestart)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "RegisterApplicationRestart");
    if (!expected) return 0;
    PVOID volatile *found = NULL;
    IMAGE_IMPORT_DESCRIPTOR *descriptors = (IMAGE_IMPORT_DESCRIPTOR*)(base + imports.VirtualAddress);
    for (SIZE_T d = 0; d < imports.Size / sizeof(*descriptors); d++) {
        IMAGE_IMPORT_DESCRIPTOR *entry = &descriptors[d];
        if (!entry->Name) break;
        if (!entry->OriginalFirstThunk || !entry->FirstThunk) continue;
        for (SIZE_T i = 0; i < size / sizeof(IMAGE_THUNK_DATA); i++) {
            SIZE_T offset = i * sizeof(IMAGE_THUNK_DATA);
            if (offset > MAXDWORD - entry->OriginalFirstThunk || offset > MAXDWORD - entry->FirstThunk) return 0;
            DWORD name_rva = entry->OriginalFirstThunk + (DWORD)offset;
            DWORD slot_rva = entry->FirstThunk + (DWORD)offset;
            if (!in_image(name_rva, sizeof(IMAGE_THUNK_DATA), size) ||
                !in_image(slot_rva, sizeof(IMAGE_THUNK_DATA), size)) return 0;
            IMAGE_THUNK_DATA *name = (IMAGE_THUNK_DATA*)(base + name_rva);
            if (!name->u1.AddressOfData) break;
            if (IMAGE_SNAP_BY_ORDINAL(name->u1.Ordinal)) continue;
            if (name->u1.AddressOfData > MAXDWORD) return 0;
            DWORD rva = (DWORD)name->u1.AddressOfData;
            const char label[] = "RegisterApplicationRestart";
            if (!in_image(rva, sizeof(WORD) + sizeof(label), size)) continue;
            IMAGE_IMPORT_BY_NAME *import = (IMAGE_IMPORT_BY_NAME*)(base + rva);
            if (memcmp(import->Name, label, sizeof(label))) continue;
            PVOID volatile *candidate = (PVOID volatile*)(base + slot_rva);
            if (found || *candidate != (PVOID)expected) return 0;
            found = candidate;
        }
    }
    if (!found) return 0;
    DWORD protection;
    if (!VirtualProtect((LPVOID)found, sizeof(PVOID), PAGE_READWRITE, &protection)) return 0;
    original_register = expected;
    slot = found;
    PVOID prior = InterlockedCompareExchangePointer(found, (PVOID)managed_restart, (PVOID)expected);
    DWORD ignored;
    BOOL restored = VirtualProtect((LPVOID)found, sizeof(PVOID), protection, &ignored);
    if (prior != (PVOID)expected) { slot = NULL; return 0; }
    if (!restored) { InterlockedExchange(&b->last_error, GetLastError()); return 0; }
    return 1;
}

static DWORD WINAPI watch_module(LPVOID parameter) {
    Bridge *b = parameter;
    const WCHAR *name = wcsrchr(b->updater_path, L'\\');
    name = name ? name + 1 : b->updater_path;
    while (!b->stop && WaitForSingleObject((HANDLE)b->owner_handle, 100) == WAIT_TIMEOUT) {
        HMODULE module = NULL;
        /* Pin the selected image while our import slot may be referenced. */
        if (!GetModuleHandleExW(0, name, &module)) continue;
        WCHAR actual[PATH_CAP];
        DWORD length = GetModuleFileNameW(module, actual, PATH_CAP);
        if (!length || length >= PATH_CAP || !same_file(actual, b->updater_path)) {
            FreeLibrary(module); InterlockedExchange(&b->status, -1); break;
        }
        if (!install(module, b)) { InterlockedExchange(&b->status, -2); break; }
        InterlockedExchange(&b->status, 1);
        while (!b->stop && WaitForSingleObject((HANDLE)b->owner_handle, 100) == WAIT_TIMEOUT) {}
        break;
    }
    AcquireSRWLockExclusive(&registration_lock);
    if (saved_registration && (b->stop || WaitForSingleObject((HANDLE)b->owner_handle, 0) == WAIT_OBJECT_0))
        original_register(saved_command, saved_flags);
    InterlockedExchange(&b->enabled, 0);
    ReleaseSRWLockExclusive(&registration_lock);
    /* Only remove our own slot; never overwrite a later patch. DLL and state
     * remain mapped until process exit so in-flight calls cannot use freed code. */
    if (slot) {
        DWORD protection;
        if (VirtualProtect((LPVOID)slot, sizeof(PVOID), PAGE_READWRITE, &protection)) {
            InterlockedCompareExchangePointer(slot, (PVOID)original_register, (PVOID)managed_restart);
            DWORD ignored;
            VirtualProtect((LPVOID)slot, sizeof(PVOID), protection, &ignored);
        }
    }
    /* Retain the owner handle too: an in-flight hook may still be reading it.
     * Both this single handle and the module reference die with the process. */
    return 0;
}

__declspec(dllexport) DWORD WINAPI codlet_restart_initialize(LPVOID parameter) {
    Bridge *b = parameter;
    if (!b || b->magic != BRIDGE_MAGIC || b->abi != BRIDGE_ABI || b->size != sizeof(Bridge) ||
        !b->owner_handle || !b->registration_event || GetProcessId((HANDLE)b->owner_handle) != b->owner_pid ||
        !b->updater_path[0] || b->updater_path[PATH_CAP-1] != 0 ||
        InterlockedCompareExchange(&initialized, 1, 0)) return 1;
    bridge = b;
    HANDLE thread = CreateThread(NULL, 0, watch_module, b, 0, NULL);
    if (!thread) { b->status = -3; b->last_error = GetLastError(); return 2; }
    CloseHandle(thread);
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) DisableThreadLibraryCalls(instance);
    return TRUE;
}
