#include <windows.h>
#include <wininet.h>
#include <commctrl.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <string.h>
#include <bcrypt.h>
#include "miniz.h"

#pragma comment(lib, "wininet.lib")
#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "bcrypt.lib")

/* Fallback location (used only if update_job.txt isn't found next to
   updater.exe itself) - %APPDATA%\<this>\update_job.txt. "PizzaTower_GM2" is
   the .yyp project name and most mods use by
   default (GameMaker's save/appdata folder matches the project name) -
   override this if your mod's .yyp was renamed. */
#define GAME_APPDATA_FOLDER_NAME "PizzaTower_GM2"

#define WM_APP_PROGRESS (WM_APP + 1)
#define WM_APP_STATUS   (WM_APP + 2)
#define WM_APP_DONE     (WM_APP + 3)
#define WM_APP_FAILED   (WM_APP + 4)
#define DOWNLOAD_MAX_ATTEMPTS 6
#define MAX_VERIFY_FILES 64

typedef struct {
    char path[MAX_PATH];
    char sha256[70];
} VerifyEntry;

typedef struct {
    char download_url[2048];
    char mode[16];
    char target_sha[128];
    char package_sha256[80];
    char install_dir[MAX_PATH];
    char relaunch_exe[MAX_PATH];
    VerifyEntry verify[MAX_VERIFY_FILES];
    int verify_count;
} Job;

static Job g_job;
static HWND g_hwnd, g_hStatus, g_hProgress;
static char g_selfDir[MAX_PATH];
static char g_jobPath[MAX_PATH];

static void GetSelfDir(char* out, size_t outSize) {
    char path[MAX_PATH];
    GetModuleFileNameA(NULL, path, MAX_PATH);
    char* slash = strrchr(path, '\\');
    if (slash) *(slash + 1) = '\0';
    strncpy(out, path, outSize - 1);
    out[outSize - 1] = '\0';
}

static BOOL JoinPath(char* out, size_t outSize, const char* dir, const char* name) {
    size_t len = strlen(dir);
    int written;
    if (len > 0 && (dir[len - 1] == '\\' || dir[len - 1] == '/')) {
        written = snprintf(out, outSize, "%s%s", dir, name);
    } else {
        written = snprintf(out, outSize, "%s\\%s", dir, name);
    }
    return written > 0 && (size_t)written < outSize;
}

static BOOL GetGameAppDataDir(char* out, size_t outSize) {
    char appData[MAX_PATH];
    DWORD len = GetEnvironmentVariableA("APPDATA", appData, sizeof(appData));
    if (len == 0 || len >= sizeof(appData)) return FALSE;
    return JoinPath(out, outSize, appData, GAME_APPDATA_FOLDER_NAME);
}

static void LogError(const char* msg) {
    char logPath[MAX_PATH];
    snprintf(logPath, sizeof(logPath), "%supdate_error.log", g_job.install_dir);
    FILE* f = fopen(logPath, "a");
    if (f) {
        SYSTEMTIME t;
        GetLocalTime(&t);
        fprintf(f, "[%04d-%02d-%02d %02d:%02d:%02d] %s\r\n",
            t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, msg);
        fclose(f);
    }
}

static void SetStatus(const char* msg) {
    PostMessageA(g_hwnd, WM_APP_STATUS, 0, (LPARAM)_strdup(msg));
}

static int TrimLine(char* s) {
    size_t n = strlen(s);
    while (n > 0 && (s[n - 1] == '\r' || s[n - 1] == '\n')) s[--n] = '\0';
    return (int)n;
}

static BOOL LoadJob(const char* path) {
    FILE* f = fopen(path, "r");
    if (!f) return FALSE;
    char line[2200];
    ZeroMemory(&g_job, sizeof(g_job));
    while (fgets(line, sizeof(line), f)) {
        TrimLine(line);
        char* eq = strchr(line, '=');
        if (!eq) continue;
        *eq = '\0';
        const char* key = line;
        const char* val = eq + 1;
        if (strcmp(key, "download_url") == 0) strncpy(g_job.download_url, val, sizeof(g_job.download_url) - 1);
        else if (strcmp(key, "mode") == 0) strncpy(g_job.mode, val, sizeof(g_job.mode) - 1);
        else if (strcmp(key, "target_sha") == 0) strncpy(g_job.target_sha, val, sizeof(g_job.target_sha) - 1);
        else if (strcmp(key, "package_sha256") == 0) strncpy(g_job.package_sha256, val, sizeof(g_job.package_sha256) - 1);
        else if (strcmp(key, "install_dir") == 0) strncpy(g_job.install_dir, val, sizeof(g_job.install_dir) - 1);
        else if (strcmp(key, "relaunch_exe") == 0) strncpy(g_job.relaunch_exe, val, sizeof(g_job.relaunch_exe) - 1);
        else if (strcmp(key, "verify") == 0 && g_job.verify_count < MAX_VERIFY_FILES) {
            char* bar = strchr(val, '|');
            if (bar) {
                *bar = '\0';
                VerifyEntry* entry = &g_job.verify[g_job.verify_count];
                strncpy(entry->path, val, sizeof(entry->path) - 1);
                strncpy(entry->sha256, bar + 1, sizeof(entry->sha256) - 1);
                g_job.verify_count++;
            }
        }
    }
    fclose(f);
    return g_job.download_url[0] && g_job.mode[0] && g_job.install_dir[0] && g_job.relaunch_exe[0];
}

static BOOL LoadFirstAvailableJob(void) {
    char candidate[MAX_PATH];

    if (JoinPath(candidate, sizeof(candidate), g_selfDir, "update_job.txt") && LoadJob(candidate)) {
        strncpy(g_jobPath, candidate, sizeof(g_jobPath) - 1);
        g_jobPath[sizeof(g_jobPath) - 1] = '\0';
        return TRUE;
    }

    char appDataDir[MAX_PATH];
    if (GetGameAppDataDir(appDataDir, sizeof(appDataDir))
        && JoinPath(candidate, sizeof(candidate), appDataDir, "update_job.txt")
        && LoadJob(candidate)) {
        strncpy(g_jobPath, candidate, sizeof(g_jobPath) - 1);
        g_jobPath[sizeof(g_jobPath) - 1] = '\0';
        return TRUE;
    }

    return FALSE;
}

static int RunAndWait(char* cmdLine) {
    STARTUPINFOA si = { sizeof(si) };
    PROCESS_INFORMATION pi;
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    if (!CreateProcessA(NULL, cmdLine, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        return -1;
    }
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return (int)code;
}

static void EnsureDirCreated(char* path, BOOL isFile) {
    for (char* p = path; *p; p++) {
        if (*p == '\\' || *p == '/') {
            char saved = *p;
            *p = '\0';
            CreateDirectoryA(path, NULL);
            *p = saved;
        }
    }
    if (!isFile) CreateDirectoryA(path, NULL);
}

static void StripTrailingBackslashes(const char* s, char* out, size_t outSize) {
    size_t len = strlen(s);
    while (len > 0 && s[len - 1] == '\\') len--;
    if (len >= outSize) len = outSize - 1;
    memcpy(out, s, len);
    out[len] = '\0';
}

static BOOL Sha256File(const char* path, char* hexOut, size_t hexOutSize) {
    if (hexOutSize < 65) return FALSE;
    BOOL ok = FALSE;
    BCRYPT_ALG_HANDLE hAlg = NULL;
    BCRYPT_HASH_HANDLE hHash = NULL;
    UCHAR hashObj[512];
    ULONG hashObjLen = 0, resultLen = 0;
    UCHAR digest[32];
    FILE* f = fopen(path, "rb");
    if (!f) return FALSE;

    if (BCryptOpenAlgorithmProvider(&hAlg, BCRYPT_SHA256_ALGORITHM, NULL, 0) != 0) goto done;
    if (BCryptGetProperty(hAlg, BCRYPT_OBJECT_LENGTH, (PUCHAR)&hashObjLen, sizeof(hashObjLen), &resultLen, 0) != 0) goto done;
    if (hashObjLen == 0 || hashObjLen > sizeof(hashObj)) goto done;
    if (BCryptCreateHash(hAlg, &hHash, hashObj, hashObjLen, NULL, 0, 0) != 0) goto done;

    {
        unsigned char buf[65536];
        size_t n;
        while ((n = fread(buf, 1, sizeof(buf), f)) > 0) {
            if (BCryptHashData(hHash, buf, (ULONG)n, 0) != 0) goto done;
        }
    }
    if (BCryptFinishHash(hHash, digest, sizeof(digest), 0) != 0) goto done;

    for (int i = 0; i < 32; i++) snprintf(hexOut + i * 2, 3, "%02x", digest[i]);
    ok = TRUE;

done:
    if (hHash) BCryptDestroyHash(hHash);
    if (hAlg) BCryptCloseAlgorithmProvider(hAlg, 0);
    fclose(f);
    return ok;
}

static ULONGLONG FileSize64(const char* path) {
    WIN32_FILE_ATTRIBUTE_DATA data;
    if (!GetFileAttributesExA(path, GetFileExInfoStandard, &data)) return 0;
    return (((ULONGLONG)data.nFileSizeHigh) << 32) | data.nFileSizeLow;
}

static BOOL DownloadFile(const char* url, const char* outPath, char* errBuf, size_t errBufSize) {
    if (strncmp(url, "https://", 8) != 0) {
        snprintf(errBuf, errBufSize, "refusing to download from non-https URL");
        return FALSE;
    }

    HINTERNET hInet = InternetOpenA("generic-updater/1.0", INTERNET_OPEN_TYPE_PRECONFIG, NULL, NULL, 0);
    if (!hInet) { snprintf(errBuf, errBufSize, "InternetOpen failed (%lu)", GetLastError()); return FALSE; }

    DWORD timeoutMs = 30000;
    InternetSetOptionA(hInet, INTERNET_OPTION_CONNECT_TIMEOUT, &timeoutMs, sizeof(timeoutMs));
    InternetSetOptionA(hInet, INTERNET_OPTION_RECEIVE_TIMEOUT, &timeoutMs, sizeof(timeoutMs));
    InternetSetOptionA(hInet, INTERNET_OPTION_SEND_TIMEOUT, &timeoutMs, sizeof(timeoutMs));

    DeleteFileA(outPath);
    char lastErr[512] = "download failed";

    for (int attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
        ULONGLONG existing = FileSize64(outPath);
        char rangeHeader[96];
        const char* headers = NULL;
        DWORD headersLen = 0;
        if (existing > 0) {
            snprintf(rangeHeader, sizeof(rangeHeader), "Range: bytes=%llu-\r\n", (unsigned long long)existing);
            headers = rangeHeader;
            headersLen = (DWORD)-1L;
        }

        DWORD flags = INTERNET_FLAG_NO_UI | INTERNET_FLAG_RELOAD | INTERNET_FLAG_NO_CACHE_WRITE
            | INTERNET_FLAG_PRAGMA_NOCACHE | INTERNET_FLAG_KEEP_CONNECTION;
        HINTERNET hUrl = InternetOpenUrlA(hInet, url, headers, headersLen, flags, 0);
        if (!hUrl) {
            snprintf(lastErr, sizeof(lastErr), "InternetOpenUrl failed for %s (%lu)", url, GetLastError());
            Sleep(1000 * attempt);
            continue;
        }

        DWORD statusCode = 0, statusSize = sizeof(statusCode);
        HttpQueryInfoA(hUrl, HTTP_QUERY_STATUS_CODE | HTTP_QUERY_FLAG_NUMBER, &statusCode, &statusSize, NULL);
        if (statusCode == 416 && existing > 0) {
            snprintf(lastErr, sizeof(lastErr), "server rejected resume at %llu bytes", (unsigned long long)existing);
            InternetCloseHandle(hUrl);
            DeleteFileA(outPath);
            Sleep(1000 * attempt);
            continue;
        }
        if (statusCode != 0 && statusCode >= 400) {
            snprintf(lastErr, sizeof(lastErr), "download got HTTP %lu for %s", statusCode, url);
            InternetCloseHandle(hUrl);
            if (statusCode < 500) break;
            Sleep(1000 * attempt);
            continue;
        }
        if (existing > 0 && statusCode != 206) {
            snprintf(lastErr, sizeof(lastErr), "server did not resume download, restarting");
            InternetCloseHandle(hUrl);
            DeleteFileA(outPath);
            Sleep(1000 * attempt);
            continue;
        }

        DWORD contentLength = 0, clSize = sizeof(contentLength);
        BOOL haveLength = HttpQueryInfoA(hUrl, HTTP_QUERY_CONTENT_LENGTH | HTTP_QUERY_FLAG_NUMBER, &contentLength, &clSize, NULL) && contentLength > 0;
        ULONGLONG expectedTotal = haveLength ? existing + (ULONGLONG)contentLength : 0;

        FILE* out = fopen(outPath, existing > 0 ? "ab" : "wb");
        if (!out) {
            snprintf(errBuf, errBufSize, "could not create %s (%lu)", outPath, GetLastError());
            InternetCloseHandle(hUrl);
            InternetCloseHandle(hInet);
            return FALSE;
        }

        char buf[65536];
        DWORD bytesRead = 0;
        ULONGLONG totalRead = existing;
        BOOL readOk = TRUE;
        BOOL writeOk = TRUE;
        DWORD readErr = 0;
        for (;;) {
            if (!InternetReadFile(hUrl, buf, sizeof(buf), &bytesRead)) {
                readOk = FALSE;
                readErr = GetLastError();
                break;
            }
            if (bytesRead == 0) break;
            if (fwrite(buf, 1, bytesRead, out) != bytesRead) {
                writeOk = FALSE;
                break;
            }
            totalRead += bytesRead;
            PostMessageA(g_hwnd, WM_APP_PROGRESS, (WPARAM)totalRead, (LPARAM)expectedTotal);
        }
        fclose(out);
        InternetCloseHandle(hUrl);

        if (!writeOk) {
            snprintf(errBuf, errBufSize, "disk write failed for %s", outPath);
            InternetCloseHandle(hInet);
            return FALSE;
        }
        if (!readOk) {
            snprintf(lastErr, sizeof(lastErr), "download read failed after %llu bytes (%lu)", (unsigned long long)totalRead, readErr);
        } else if (expectedTotal > 0 && totalRead == expectedTotal) {
            InternetCloseHandle(hInet);
            return TRUE;
        } else if (expectedTotal == 0 && totalRead > existing) {
            InternetCloseHandle(hInet);
            return TRUE;
        } else if (expectedTotal > 0) {
            snprintf(lastErr, sizeof(lastErr), "download incomplete: got %llu of %llu bytes", (unsigned long long)totalRead, (unsigned long long)expectedTotal);
        } else {
            snprintf(lastErr, sizeof(lastErr), "download returned no data");
        }

        if (attempt < DOWNLOAD_MAX_ATTEMPTS) Sleep(1000 * attempt);
    }

    InternetCloseHandle(hInet);
    snprintf(errBuf, errBufSize, "%s", lastErr);
    return FALSE;
}

static BOOL FindProcessIdByName(const char* exeName, DWORD* outPid) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return FALSE;
    PROCESSENTRY32 pe;
    pe.dwSize = sizeof(pe);
    BOOL found = FALSE;
    if (Process32First(snap, &pe)) {
        do {
            if (_stricmp(pe.szExeFile, exeName) == 0) {
                found = TRUE;
                if (outPid) *outPid = pe.th32ProcessID;
                break;
            }
        } while (Process32Next(snap, &pe));
    }
    CloseHandle(snap);
    return found;
}

static void EnsureGameClosed(const char* exeName) {
    if (!exeName[0]) return;
    DWORD pid;
    for (int i = 0; i < 20; i++) {
        if (!FindProcessIdByName(exeName, &pid)) return;
        Sleep(500);
    }
    if (FindProcessIdByName(exeName, &pid)) {
        HANDLE h = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, FALSE, pid);
        if (h) {
            TerminateProcess(h, 1);
            WaitForSingleObject(h, 5000);
            CloseHandle(h);
        }
    }
}

static BOOL FileExistsA(const char* path) {
    DWORD attrs = GetFileAttributesA(path);
    return attrs != INVALID_FILE_ATTRIBUTES && !(attrs & FILE_ATTRIBUTE_DIRECTORY);
}

static void StageSelfForUpdate(char* pendingPath, size_t pendingPathSize) {
    pendingPath[0] = '\0';
    char selfPath[MAX_PATH];
    snprintf(selfPath, sizeof(selfPath), "%supdater.exe", g_job.install_dir);
    if (!FileExistsA(selfPath)) return;

    char candidate[MAX_PATH];
    snprintf(candidate, sizeof(candidate), "%supdater.exe.old", g_job.install_dir);
    DeleteFileA(candidate);
    if (MoveFileExA(selfPath, candidate, MOVEFILE_REPLACE_EXISTING)) {
        strncpy(pendingPath, candidate, pendingPathSize - 1);
        pendingPath[pendingPathSize - 1] = '\0';
    }
}

static void RestoreSelfIfNotReplaced(const char* pendingPath) {
    if (!pendingPath[0]) return;
    char selfPath[MAX_PATH];
    snprintf(selfPath, sizeof(selfPath), "%supdater.exe", g_job.install_dir);
    if (!FileExistsA(selfPath)) {
        MoveFileExA(pendingPath, selfPath, MOVEFILE_REPLACE_EXISTING);
    }
}

static BOOL ExtractZipNative(const char* zipPath, const char* destDir, char* errBuf, size_t errBufSize) {
    mz_zip_archive zip;
    memset(&zip, 0, sizeof(zip));
    if (!mz_zip_reader_init_file(&zip, zipPath, 0)) {
        snprintf(errBuf, errBufSize, "could not open downloaded zip as a zip archive");
        return FALSE;
    }

    mz_uint numFiles = mz_zip_reader_get_num_files(&zip);
    BOOL ok = TRUE;
    for (mz_uint i = 0; i < numFiles; i++) {
        mz_zip_archive_file_stat st;
        if (!mz_zip_reader_file_stat(&zip, i, &st)) continue;

        char rel[MAX_PATH];
        strncpy(rel, st.m_filename, sizeof(rel) - 1);
        rel[sizeof(rel) - 1] = '\0';
        for (char* p = rel; *p; p++) if (*p == '/') *p = '\\';

        char outPath[MAX_PATH];
        snprintf(outPath, sizeof(outPath), "%s%s", destDir, rel);

        if (mz_zip_reader_is_file_a_directory(&zip, i)) {
            EnsureDirCreated(outPath, FALSE);
            continue;
        }

        EnsureDirCreated(outPath, TRUE);
        if (!mz_zip_reader_extract_to_file(&zip, i, outPath, 0)) {
            snprintf(errBuf, errBufSize, "failed to extract %s from zip", st.m_filename);
            ok = FALSE;
            break;
        }
    }

    mz_zip_reader_end(&zip);
    return ok;
}

static BOOL ExtractZipWithRetry(const char* zipPath, const char* destDir, char* errBuf, size_t errBufSize) {
    for (int attempt = 0; attempt < 15; attempt++) {
        if (ExtractZipNative(zipPath, destDir, errBuf, errBufSize)) return TRUE;
        Sleep(2000);
    }
    return FALSE;
}

static BOOL CopyDirRecursive(const char* srcDir, const char* dstDir, char* errBuf, size_t errBufSize) {
    CreateDirectoryA(dstDir, NULL);

    char searchPath[MAX_PATH];
    snprintf(searchPath, sizeof(searchPath), "%s\\*", srcDir);

    WIN32_FIND_DATAA fd;
    HANDLE h = FindFirstFileA(searchPath, &fd);
    if (h == INVALID_HANDLE_VALUE) return TRUE; /* nothing to copy */

    BOOL ok = TRUE;
    do {
        if (strcmp(fd.cFileName, ".") == 0 || strcmp(fd.cFileName, "..") == 0) continue;

        char srcPath[MAX_PATH], dstPath[MAX_PATH];
        snprintf(srcPath, sizeof(srcPath), "%s\\%s", srcDir, fd.cFileName);
        snprintf(dstPath, sizeof(dstPath), "%s\\%s", dstDir, fd.cFileName);

        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            if (!CopyDirRecursive(srcPath, dstPath, errBuf, errBufSize)) { ok = FALSE; break; }
        } else {
            SetFileAttributesA(dstPath, FILE_ATTRIBUTE_NORMAL); /* clear read-only left by a previous copy */
            if (!CopyFileA(srcPath, dstPath, FALSE)) {
                snprintf(errBuf, errBufSize, "failed to copy %s (%lu)", fd.cFileName, GetLastError());
                ok = FALSE;
                break;
            }
        }
    } while (FindNextFileA(h, &fd));
    FindClose(h);
    return ok;
}

static BOOL ApplyPatchWithRetry(const char* hdiffPath, const char* installDir, const char* outDir, char* errBuf, size_t errBufSize) {
    char hpatchzPath[MAX_PATH];
    snprintf(hpatchzPath, sizeof(hpatchzPath), "%shpatchz.exe", g_job.install_dir);

    char installDirArg[MAX_PATH];
    StripTrailingBackslashes(installDir, installDirArg, sizeof(installDirArg));

    char rmCmd[MAX_PATH + 32];
    snprintf(rmCmd, sizeof(rmCmd), "cmd.exe /c rmdir /s /q \"%s\"", outDir);
    RunAndWait(rmCmd);

    char cmd[4096];
    snprintf(cmd, sizeof(cmd), "\"%s\" \"%s\" \"%s\" \"%s\"", hpatchzPath, installDirArg, hdiffPath, outDir);
    int code = RunAndWait(cmd);
    if (code != 0) {
        snprintf(errBuf, errBufSize, "hpatchz.exe exited with code %d", code);
        return FALSE;
    }

    char selfUpdatePending[MAX_PATH];
    StageSelfForUpdate(selfUpdatePending, sizeof(selfUpdatePending));

    for (int attempt = 0; attempt < 15; attempt++) {
        if (CopyDirRecursive(outDir, installDirArg, errBuf, errBufSize)) {
            RestoreSelfIfNotReplaced(selfUpdatePending);
            return TRUE;
        }
        Sleep(2000);
    }
    RestoreSelfIfNotReplaced(selfUpdatePending);
    return FALSE;
}

static BOOL VerifyInstallMatchesPatchBaseline(char* errBuf, size_t errBufSize) {
    for (int i = 0; i < g_job.verify_count; i++) {
        char relPath[MAX_PATH];
        strncpy(relPath, g_job.verify[i].path, sizeof(relPath) - 1);
        relPath[sizeof(relPath) - 1] = '\0';
        for (char* p = relPath; *p; p++) if (*p == '/') *p = '\\';

        char fullPath[MAX_PATH];
        if (!JoinPath(fullPath, sizeof(fullPath), g_job.install_dir, relPath)) {
            snprintf(errBuf, errBufSize, "verify path too long: %s", g_job.verify[i].path);
            return FALSE;
        }

        char actual[65];
        if (!FileExistsA(fullPath) || !Sha256File(fullPath, actual, sizeof(actual))) {
            snprintf(errBuf, errBufSize, "local file is missing before patching: %s", g_job.verify[i].path);
            return FALSE;
        }
        if (_stricmp(actual, g_job.verify[i].sha256) != 0) {
            snprintf(errBuf, errBufSize, "local file doesn't match what this patch expects: %s", g_job.verify[i].path);
            return FALSE;
        }
    }
    return TRUE;
}

static void FailAndExit(const char* msg) {
    LogError(msg);
    char box[1024];
    snprintf(box, sizeof(box),
        "Update failed:\n%s\n\nSee update_error.log in your game folder for details.\nTry again later.",
        msg);
    PostMessageA(g_hwnd, WM_APP_FAILED, 0, (LPARAM)_strdup(box));
}

static DWORD WINAPI WorkerThread(LPVOID param) {
    (void)param;
    char err[512];
    BOOL isPatch = (strcmp(g_job.mode, "patch") == 0);

    SetStatus("Waiting for game to close...");
    EnsureGameClosed(g_job.relaunch_exe);

    if (isPatch && g_job.verify_count > 0) {
        SetStatus("Verifying local files...");
        if (!VerifyInstallMatchesPatchBaseline(err, sizeof(err))) {
            char msg[768];
            snprintf(msg, sizeof(msg),
                "%s\n\nYour installed files don't match what this incremental update expects, sorryy "
                "so it can't be safely applied. so do /generate in Discord for a fresh full build instead.",
                err);
            FailAndExit(msg);
            return 1;
        }
    }

    SetStatus("Downloading update...");

    char tempDir[MAX_PATH];
    GetTempPathA(sizeof(tempDir), tempDir);
    char dlPath[MAX_PATH];
    snprintf(dlPath, sizeof(dlPath), "%supdate_dl.%s", tempDir, isPatch ? "hdiff" : "zip");

    if (!DownloadFile(g_job.download_url, dlPath, err, sizeof(err))) {
        FailAndExit(err);
        return 1;
    }

    if (g_job.package_sha256[0]) {
        SetStatus("Verifying update...");
        char actual[65];
        if (!Sha256File(dlPath, actual, sizeof(actual)) || _stricmp(actual, g_job.package_sha256) != 0) {
            DeleteFileA(dlPath);
            FailAndExit("downloaded update failed integrity verification (hash mismatch)");
            return 1;
        }
    } else {
        LogError("WARNING: update_job.txt had no package_sha256 - integrity check skipped");
    }

    SetStatus("Applying update...");

    if (isPatch) {
        char outDir[MAX_PATH];
        snprintf(outDir, sizeof(outDir), "%supdate_patch_out", tempDir);
        if (!ApplyPatchWithRetry(dlPath, g_job.install_dir, outDir, err, sizeof(err))) {
            FailAndExit(err);
            return 1;
        }
    } else {
        char selfUpdatePending[MAX_PATH];
        StageSelfForUpdate(selfUpdatePending, sizeof(selfUpdatePending));
        if (!ExtractZipWithRetry(dlPath, g_job.install_dir, err, sizeof(err))) {
            RestoreSelfIfNotReplaced(selfUpdatePending);
            FailAndExit(err);
            return 1;
        }
        RestoreSelfIfNotReplaced(selfUpdatePending);
    }

    DeleteFileA(dlPath);

    if (g_jobPath[0]) DeleteFileA(g_jobPath);

    SetStatus("Restarting game...");

    char relaunchPath[MAX_PATH];
    snprintf(relaunchPath, sizeof(relaunchPath), "%s%s", g_job.install_dir, g_job.relaunch_exe);
    ShellExecuteA(NULL, "open", relaunchPath, NULL, g_job.install_dir, SW_SHOWNORMAL);

    PostMessageA(g_hwnd, WM_APP_DONE, 0, 0);
    return 0;
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
        case WM_APP_STATUS: {
            char* text = (char*)lParam;
            SetWindowTextA(g_hStatus, text);
            free(text);
            return 0;
        }
        case WM_APP_PROGRESS: {
            ULONGLONG done = (ULONGLONG)wParam, total = (ULONGLONG)lParam;
            if (total > 0) {
                SendMessageA(g_hProgress, PBM_SETPOS, (WPARAM)((done * 100ULL) / total), 0);
            }
            return 0;
        }
        case WM_APP_DONE:
            DestroyWindow(hwnd);
            return 0;
        case WM_APP_FAILED: {
            char* text = (char*)lParam;
            MessageBoxA(hwnd, text, "Update Failed", MB_OK | MB_ICONERROR);
            free(text);
            DestroyWindow(hwnd);
            return 0;
        }
        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
    }
    return DefWindowProcA(hwnd, msg, wParam, lParam);
}

int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrev, LPSTR cmdLine, int nShow) {
    (void)hPrev; (void)cmdLine; (void)nShow;

    GetSelfDir(g_selfDir, sizeof(g_selfDir));
    if (!LoadFirstAvailableJob()) {
        MessageBoxA(NULL, "update_job.txt is missing or malformed - nothing to update.\n\nLooked next to updater.exe and in %APPDATA%\\" GAME_APPDATA_FOLDER_NAME ".", "Updater", MB_OK | MB_ICONWARNING);
        return 1;
    }

    INITCOMMONCONTROLSEX icc = { sizeof(icc), ICC_PROGRESS_CLASS };
    InitCommonControlsEx(&icc);

    WNDCLASSA wc = { 0 };
    wc.lpfnWndProc = WndProc;
    wc.hInstance = hInstance;
    wc.lpszClassName = "AntileakUpdaterWnd";
    wc.hCursor = LoadCursorA(NULL, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
    RegisterClassA(&wc);

    g_hwnd = CreateWindowExA(WS_EX_APPWINDOW, "AntileakUpdaterWnd", "Updating...",
        WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
        CW_USEDEFAULT, CW_USEDEFAULT, 420, 130,
        NULL, NULL, hInstance, NULL);

    g_hStatus = CreateWindowExA(0, "STATIC", "Starting...",
        WS_CHILD | WS_VISIBLE, 20, 15, 380, 20, g_hwnd, NULL, hInstance, NULL);
    g_hProgress = CreateWindowExA(0, PROGRESS_CLASSA, NULL,
        WS_CHILD | WS_VISIBLE, 20, 45, 380, 24, g_hwnd, NULL, hInstance, NULL);
    SendMessageA(g_hProgress, PBM_SETRANGE, 0, MAKELPARAM(0, 100));

    ShowWindow(g_hwnd, SW_SHOW);
    UpdateWindow(g_hwnd);

    HANDLE hThread = CreateThread(NULL, 0, WorkerThread, NULL, 0, NULL);
    CloseHandle(hThread);

    MSG msg;
    while (GetMessageA(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessageA(&msg);
    }
    return 0;
}
