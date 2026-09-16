using System;
using System.Runtime.InteropServices;

public static class ProbeId
{
    [DllImport("kernel32", CharSet = CharSet.Ansi, SetLastError = true)]
    private static extern IntPtr LoadLibrary(string path);

    [DllImport("kernel32", CharSet = CharSet.Ansi, SetLastError = true)]
    private static extern IntPtr GetProcAddress(IntPtr module, string name);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate IntPtr GetString();

    private static string Call(string dllPath, string export)
    {
        IntPtr module = LoadLibrary(dllPath);
        if (module == IntPtr.Zero)
        {
            throw new Exception("LoadLibrary failed for " + dllPath + ": " + Marshal.GetLastWin32Error());
        }

        IntPtr proc = GetProcAddress(module, export);
        if (proc == IntPtr.Zero)
        {
            throw new Exception("export " + export + " not found in " + dllPath);
        }

        GetString fn = (GetString)Marshal.GetDelegateForFunctionPointer(proc, typeof(GetString));
        return Marshal.PtrToStringAnsi(fn()) ?? "";
    }

    public static string Read(string dllPath)
    {
        return Call(dllPath, "antileak_get_build_id");
    }

    public static string ReadSig(string dllPath)
    {
        return Call(dllPath, "antileak_get_build_sig");
    }
}
