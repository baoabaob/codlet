using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Codlet.Setup {
    static class UserDataCleanupTests {
        [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Credential {
            public uint Flags, Type; public string TargetName, Comment; public long LastWritten;
            public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist, AttributeCount;
            public IntPtr Attributes; public string TargetAlias, UserName;
        }
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredWrite(ref Credential credential, uint flags);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredRead(string target, uint type, uint flags, out IntPtr value);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern bool CredDelete(string target, uint type, uint flags);
        [DllImport("advapi32.dll")] static extern void CredFree(IntPtr value);
        static void Assert(bool value, string message) { if (!value) throw new Exception(message); Console.WriteLine("PASS " + message); }
        static void PutCredential(string target) {
            var credential = new Credential { Type = 1, TargetName = target, UserName = "Codlet cleanup test", Persist = 2 };
            if (!CredWrite(ref credential, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        static bool HasCredential(string target) {
            IntPtr value; if (!CredRead(target, 1, 0, out value)) return false;
            CredFree(value); return true;
        }
        [STAThread] static int Main(string[] args) {
            string output = args[0]; Application.EnableVisualStyles();
            var cleanup = new UserDataCleanup(Path.Combine(output, "profile"));
            string own = null, other = "Codlet/cleanup-fixture-" + Guid.NewGuid().ToString("N") + "/keep";
            try {
                Directory.CreateDirectory(cleanup.Root);
                foreach (string name in UserDataCleanup.Names.Where(x => x != "packages")) File.WriteAllText(Path.Combine(cleanup.Root, name), "fixture");
                string config = Path.Combine(cleanup.Root, "config.json");
                using (var file = File.OpenRead(config)) own = CredentialScope.Prefix(file.SafeFileHandle) + "test.plugin/" + new string('a',64) + "/fixture";
                PutCredential(own); PutCredential(other);
                File.WriteAllText(Path.Combine(cleanup.Root, "my-notes.txt"), "preserve unknown data");
                File.WriteAllText(Path.Combine(output, "outside", "source.js"), "external plugin source");
                using (var lockFile = new FileStream(Path.Combine(cleanup.Root, "runtime-skills.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.ReadWrite)) {
                    bool refused = false; try { cleanup.Clean(); } catch (IOException) { refused = true; }
                    Assert(refused && File.Exists(config) && HasCredential(own), "active scope refused before any file or credential deletion");
                }
                foreach (bool chinese in new[]{true, false}) using (var dialog = new CleanupDialog(cleanup, chinese)) {
                    dialog.ShowInTaskbar = false; dialog.Opacity = 0; dialog.Show(); Application.DoEvents();
                    Assert(!dialog.Controls.OfType<CheckBox>().Single().Checked, "cleanup defaults to no consent");
                    Assert(dialog.Controls.OfType<Button>().Any(x => !x.Enabled), "destructive action disabled until consent");
                    using (var bitmap = new Bitmap(dialog.Width, dialog.Height)) { dialog.DrawToBitmap(bitmap, new Rectangle(0,0,bitmap.Width,bitmap.Height)); bitmap.Save(Path.Combine(output, chinese ? "cleanup-zh.png" : "cleanup-en.png")); }
                    ((Button)dialog.CancelButton).PerformClick(); Application.DoEvents();
                    Assert(File.Exists(config) && HasCredential(own), "keep/close does not change data");
                }
                var retained = cleanup.Clean();
                Assert(!File.Exists(config) && UserDataCleanup.Names.Where(x => x != "packages").All(x => !File.Exists(Path.Combine(cleanup.Root, x))), "known Codlet files removed");
                Assert(!HasCredential(own) && HasCredential(other), "only the exact Codlet credential scope removed");
                Assert(File.ReadAllText(Path.Combine(output, "outside", "source.js")) == "external plugin source", "linked external source preserved");
                Assert(File.Exists(Path.Combine(cleanup.Root, "my-notes.txt")) && retained.Any(x => x.EndsWith("my-notes.txt")), "unknown data retained and reported");
                Assert(Directory.Exists(Path.Combine(cleanup.Root, "packages", "linked")) && retained.Any(x => x.EndsWith("linked")), "junction retained without traversal");
                Assert(!File.Exists(Path.Combine(cleanup.Root, "packages", "managed", "entry.js")), "ordinary managed package content removed");
                bool rejected = false; try { new UserDataCleanup(Path.Combine(output, "linked-profile")).Clean(); } catch (IOException) { rejected = true; }
                Assert(rejected && File.Exists(Path.Combine(output,"other-profile","Codlet","config.json")), "linked ancestor rejected before cleanup");
                File.WriteAllText(Path.Combine(output, "report.json"), "{\"passed\":true,\"scope\":\"isolated-fixture-files-and-credentials\",\"userDataTouched\":false}");
                return 0;
            } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
            finally { if (own != null) CredDelete(own,1,0); CredDelete(other,1,0); }
        }
    }
}
