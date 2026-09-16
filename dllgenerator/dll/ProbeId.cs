using System;
using System.Runtime.InteropServices;

public static class ProbeId
{
    [DllImport("kernel32", CharSet = CharSet.Ansi, SetLastError = true)]
    private static extern IntPtr LoadLibrary(string path);

    [DllImport("kernel32", CharSet = CharSet.Ansi, SetLastError = true)]
    private static extern IntPtr GetProcAddress(IntPtr module, string name);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate IntPtr GetBuildId();

    public static string Read(string dllPath)
    {
        IntPtr module = LoadLibrary(dllPath);
        if (module == IntPtr.Zero)
        {
            throw new Exception("LoadLibrary failed for " + dllPath + ": " + Marshal.GetLastWin32Error());
        }

        IntPtr proc = GetProcAddress(module, "antileak_get_build_id");
        if (proc == IntPtr.Zero)
        {
            throw new Exception("export antileak_get_build_id not found in " + dllPath);
        }

        GetBuildId fn = (GetBuildId)Marshal.GetDelegateForFunctionPointer(proc, typeof(GetBuildId));
        return Marshal.PtrToStringAnsi(fn()) ?? "";
    }
}
