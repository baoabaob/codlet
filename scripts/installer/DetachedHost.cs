using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

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
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(ProcessHandle handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(ProcessHandle handle, out int code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(ProcessHandle handle, out long created, out long exited, out long kernel, out long user);

        sealed class ProcessHandle : SafeHandleZeroOrMinusOneIsInvalid {
            public ProcessHandle(IntPtr value) : base(true) { SetHandle(value); }
            protected override bool ReleaseHandle() { return CloseHandle(handle); }
        }

        // Keep CreateProcess's handle, including after exit. Reopening by PID
        // loses both the exit status and identity if Core exits before polling.
        public sealed class OwnedProcess : IDisposable {
            readonly ProcessHandle handle;
            public int Id { get; private set; }
            public DateTime StartTime { get; private set; }
            internal OwnedProcess(IntPtr nativeHandle, int pid) {
                handle = new ProcessHandle(nativeHandle); Id = pid;
                try {
                    long created, exited, kernel, user;
                    if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw new Win32Exception();
                    StartTime = DateTime.FromFileTimeUtc(created);
                } catch { handle.Dispose(); throw; }
            }
            public bool HasExited {
                get {
                    uint result = WaitForSingleObject(handle, 0);
                    if (result == 0) return true;
                    if (result == 258) return false;
                    throw new Win32Exception();
                }
            }
            public int ExitCode {
                get {
                    if (!HasExited) throw new InvalidOperationException("Core is still running.");
                    int code;
                    if (!GetExitCodeProcess(handle, out code)) throw new Win32Exception();
                    return code;
                }
            }
            // Disposing observation must never terminate the long-lived Core.
            public void Dispose() { handle.Dispose(); }
        }

        public static OwnedProcess Start(string root, string data, string log, bool safeMode = false) {
            // Give Core real file handles; no launcher-owned pipe pump whose exit
            // would break the long-lived host's stdout/stderr.
            using (var output = new FileStream(log + ".core.log", FileMode.CreateNew, FileAccess.Write, FileShare.ReadWrite)) {
                var handle = output.SafeFileHandle.DangerousGetHandle();
                if (!SetHandleInformation(handle, 1, 1)) throw new System.ComponentModel.Win32Exception();
                var startup = new StartupInfoEx { startup = new StartupInfo { size = Marshal.SizeOf(typeof(StartupInfoEx)), flags = 0x100, output = handle, error = handle, input = IntPtr.Zero } };
                IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
                startup.attributes = Marshal.AllocHGlobal(size); var handles = Marshal.AllocHGlobal(IntPtr.Size);
                bool initialized = false;
                string executable = Path.Combine(root, "codlet.exe"); ProcessInfo info;
                string previous = Environment.GetEnvironmentVariable("CODLET_HOME");
                try {
                    if (!InitializeProcThreadAttributeList(startup.attributes, 1, 0, ref size)) throw new Win32Exception();
                    initialized = true;
                    Marshal.WriteIntPtr(handles, handle);
                    if (!UpdateProcThreadAttribute(startup.attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception();
                    Environment.SetEnvironmentVariable("CODLET_HOME", data);
                    if (!CreateProcess(executable, new StringBuilder("\"" + executable + "\" launch" + (safeMode ? " --safe-mode" : "")), IntPtr.Zero, IntPtr.Zero, true, 0x08080000, IntPtr.Zero, root, ref startup, out info)) throw new Win32Exception();
                } finally { Environment.SetEnvironmentVariable("CODLET_HOME", previous); if (initialized) DeleteProcThreadAttributeList(startup.attributes); Marshal.FreeHGlobal(startup.attributes); Marshal.FreeHGlobal(handles); }
                try { return new OwnedProcess(info.process, info.pid); }
                finally { CloseHandle(info.thread); }
            }
        }
    }
}
