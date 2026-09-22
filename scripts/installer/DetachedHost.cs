using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Codlet.Setup {
    static class DetachedHost {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct StartupInfo { public int size; public string reserved, desktop, title; public int x, y, width, height, xChars, yChars, fill, flags; public short show, reservedBytes; public IntPtr reservedData, input, output, error; }
        [StructLayout(LayoutKind.Sequential)]
        struct ProcessInfo { public IntPtr process, thread; public int pid, tid; }
        [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo startup; public IntPtr attributes; }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo info);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
        [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

        public static Process Start(string root, string data, string log) {
            // Give Core real file handles; no launcher-owned pipe pump whose exit
            // would break the long-lived host's stdout/stderr.
            using (var output = new FileStream(log + ".core.log", FileMode.CreateNew, FileAccess.Write, FileShare.ReadWrite)) {
                var handle = output.SafeFileHandle.DangerousGetHandle();
                if (!SetHandleInformation(handle, 1, 1)) throw new System.ComponentModel.Win32Exception();
                var startup = new StartupInfoEx { startup = new StartupInfo { size = Marshal.SizeOf(typeof(StartupInfoEx)), flags = 0x100, output = handle, error = handle, input = IntPtr.Zero } };
                IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
                startup.attributes = Marshal.AllocHGlobal(size); var handles = Marshal.AllocHGlobal(IntPtr.Size);
                if (!InitializeProcThreadAttributeList(startup.attributes, 1, 0, ref size)) throw new System.ComponentModel.Win32Exception();
                Marshal.WriteIntPtr(handles, handle);
                string executable = Path.Combine(root, "codlet.exe"); ProcessInfo info;
                string previous = Environment.GetEnvironmentVariable("CODLET_HOME");
                try {
                    if (!UpdateProcThreadAttribute(startup.attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception();
                    Environment.SetEnvironmentVariable("CODLET_HOME", data);
                    if (!CreateProcess(executable, new StringBuilder("\"" + executable + "\" launch"), IntPtr.Zero, IntPtr.Zero, true, 0x08080000, IntPtr.Zero, root, ref startup, out info)) throw new System.ComponentModel.Win32Exception();
                } finally { Environment.SetEnvironmentVariable("CODLET_HOME", previous); DeleteProcThreadAttributeList(startup.attributes); Marshal.FreeHGlobal(startup.attributes); Marshal.FreeHGlobal(handles); }
                try { return Process.GetProcessById(info.pid); }
                finally { CloseHandle(info.thread); CloseHandle(info.process); }
            }
        }
    }
}
