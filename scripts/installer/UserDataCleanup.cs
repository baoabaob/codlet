using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Codlet.Setup {
    // No environment-selected home, registry-selected path or arbitrary CLI path.
    // The installer calls this only after a successful, explicit full uninstall.
    sealed class UserDataCleanup {
        internal static readonly string[] Names = {
            "config.json", "config.json.lock", "config.json.preferences.json", "config.json.preferences.json.lock",
            "config.json.client-plugins.json", "config.json.compatibility-cache.json", "config.json.plugin-services",
            "packages", "js-runtimes", "runtime-skills", "logs", "launcher-logs", "installer-logs",
            "plugin-setup.json", "plugin-setup.lock", "plugin-bundle-reviewed.txt", ".official-seed-transactions"
        };
        internal readonly string Root;
        internal UserDataCleanup(string localAppData) { Root = Path.Combine(Path.GetFullPath(localAppData), "Codlet"); }
        internal static UserDataCleanup CurrentUser() {
            if (System.Security.Principal.WindowsIdentity.GetCurrent().IsSystem) throw new InvalidOperationException("User data cleanup cannot run as SYSTEM.");
            return new UserDataCleanup(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
        }
        internal string[] Paths { get { return Names.Concat(new[]{"runtime-skills.lock"}).Select(name => Path.Combine(Root, name)).ToArray(); } }
        internal List<string> Clean() {
            var retained = new List<string>();
            if (!Directory.Exists(Root)) return retained;
            // Hold directory handles without FILE_SHARE_DELETE. Neither an ancestor
            // nor an opened child can be replaced by a junction while we traverse it.
            using (var guard = new DirectoryGuard(Root)) {
                string skillLock = Path.Combine(Root, "runtime-skills.lock");
                if (File.Exists(skillLock) && IsLink(skillLock)) throw new IOException("Linked runtime lock: " + skillLock);
                // Core retains this file while providing its skill. Refuse an active
                // scope before deleting any credentials or files.
                using (var active = AcquireLock(skillLock)) {
                    string config = Path.Combine(Root, "config.json");
                    if (File.Exists(config)) {
                        if (IsLink(config)) throw new IOException("Linked configuration: " + config);
                        using (var file = DirectoryGuard.Open(config, false)) {
                            string prefix = CredentialScope.Prefix(file);
                            CredentialScope.Delete(prefix);
                        }
                    }
                    foreach (string name in Names) Remove(Path.Combine(Root, name), retained);
                }
                File.Delete(skillLock);
            }
            // Unknown entries and links remain visible for manual review.
            retained.AddRange(Directory.GetFileSystemEntries(Root));
            if (retained.Count == 0) Directory.Delete(Root, false);
            return retained.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        }
        internal static bool IsLink(string path) { return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0; }
        static FileStream AcquireLock(string path) {
            if (!File.Exists(path)) return new FileStream(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
            using (var pin = DirectoryGuard.Open(path, false))
                return new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        }
        static void Remove(string path, List<string> retained) {
            try {
                FileAttributes attributes;
                try { attributes = File.GetAttributes(path); } catch (FileNotFoundException) { return; } catch (DirectoryNotFoundException) { return; }
                if ((attributes & FileAttributes.ReparsePoint) != 0) { retained.Add(path); return; }
                if ((attributes & FileAttributes.Directory) == 0) { File.Delete(path); return; }
                using (var guard = new DirectoryGuard(path, false))
                    foreach (string child in Directory.GetFileSystemEntries(path)) Remove(child, retained);
                if (Directory.GetFileSystemEntries(path).Length == 0) Directory.Delete(path, false);
            } catch (IOException) { retained.Add(path); } catch (UnauthorizedAccessException) { retained.Add(path); }
        }
    }

    sealed class DirectoryGuard : IDisposable {
        readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool GetFileInformationByHandle(SafeFileHandle file, [Out] byte[] info);
        internal static SafeFileHandle Open(string path, bool directory) {
            var handle = CreateFile(path, 0, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            try {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot lock cleanup path: " + path);
                var info = new byte[52];
                if (!GetFileInformationByHandle(handle, info)) throw new Win32Exception(Marshal.GetLastWin32Error());
                uint attributes = BitConverter.ToUInt32(info, 0);
                if ((attributes & 0x400) != 0 || ((attributes & 0x10) != 0) != directory) throw new IOException("Linked or invalid cleanup path: " + path);
                return handle;
            } catch { handle.Dispose(); throw; }
        }
        internal DirectoryGuard(string path, bool ancestors = true) {
            try {
                var directories = new List<string>();
                for (var current = new DirectoryInfo(path); current != null; current = ancestors ? current.Parent : null) directories.Add(current.FullName);
                directories.Reverse();
                foreach (string directory in directories) {
                    handles.Add(Open(directory, true));
                }
            } catch { Dispose(); throw; }
        }
        public void Dispose() { for (int i = handles.Count - 1; i >= 0; i--) handles[i].Dispose(); handles.Clear(); }
    }

    static class CredentialScope {
        [StructLayout(LayoutKind.Sequential)] struct CredentialHeader { public uint Flags, Type; public IntPtr TargetName; }
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint size, uint flags);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredEnumerate(string filter, uint flags, out uint count, out IntPtr credentials);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredDelete(string target, uint type, uint flags);
        [DllImport("advapi32.dll")] static extern void CredFree(IntPtr credentials);
        internal static string Prefix(SafeFileHandle config) {
            var path = new StringBuilder(32768);
            uint size = GetFinalPathNameByHandle(config, path, (uint)path.Capacity, 0);
            if (size == 0 || size >= path.Capacity) throw new IOException("Cannot identify the Codlet credential scope.");
            // Matches plugin_services::path_identity_bytes: canonical Windows path,
            // UTF-16LE, SHA-256, first 32 hex digits. No credential values are read.
            using (var sha = SHA256.Create()) return "Codlet/" + BitConverter.ToString(sha.ComputeHash(Encoding.Unicode.GetBytes(path.ToString()))).Replace("-", "").ToLowerInvariant().Substring(0, 32) + "/";
        }
        internal static void Delete(string prefix) {
            uint count; IntPtr credentials;
            if (!CredEnumerate(prefix + "*", 0, out count, out credentials)) {
                int error = Marshal.GetLastWin32Error();
                if (error == 1168) return;
                throw new Win32Exception(error, "Cannot enumerate this Codlet scope's credentials; data was retained.");
            }
            try {
                for (int i = 0; i < count; i++) {
                    var item = (CredentialHeader)Marshal.PtrToStructure(Marshal.ReadIntPtr(credentials, i * IntPtr.Size), typeof(CredentialHeader));
                    string target = Marshal.PtrToStringUni(item.TargetName);
                    if (item.Type == 1 && target.StartsWith(prefix, StringComparison.Ordinal) && !CredDelete(target, 1, 0))
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "Some Codlet credentials could not be removed; files were retained.");
                }
            } finally { CredFree(credentials); }
        }
    }
}
