using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading;
using System.Windows.Forms;

namespace Codlet.Setup {
    static class ProcessGateTests {
        static void Assert(bool value, string message) { if (!value) throw new Exception(message); Console.WriteLine("PASS " + message); }
        static Process Start(string path, string mode) { return Process.Start(new ProcessStartInfo(path, mode) { UseShellExecute = false, CreateNoWindow = true }); }
        [STAThread] static int Main(string[] args) {
            string root = args[0], outside = args[1]; Application.EnableVisualStyles();
            Process cooperative = null, stubborn = null, other = null;
            try {
                Assert(!ProcessGate.IsWithin(Path.Combine(root + "-other", "codlet.exe"), root), "path boundary excludes adjacent directories");
                cooperative = Start(Path.Combine(root, "codlet.exe"), "cooperative");
                stubborn = Start(Path.Combine(root, "codlet.exe"), "stubborn");
                other = Start(Path.Combine(outside, "codlet.exe"), "cooperative");
                cooperative.WaitForInputIdle(5000); stubborn.WaitForInputIdle(5000); other.WaitForInputIdle(5000);
                Thread.Sleep(250);
                var found = ProcessGate.Find(root, false);
                Assert(found.Count == 2 && !found.Any(p => p.Id == other.Id), "enumeration selects only owned test directory");
                var watch = Stopwatch.StartNew();
                Assert(ProcessGate.Check(root, false, false, Console.WriteLine) == 1618 && watch.ElapsedMilliseconds < 3000, "quiet preflight fails promptly without interaction");
                var app = found.Single(p => p.Id == cooperative.Id);
                var stale = new RunningApplication { Id = app.Id, Created = app.Created - 1, Path = app.Path };
                Assert(!ProcessGate.RequestClose(stale) && !cooperative.HasExited, "stale PID identity cannot close a process");
                using (var dialog = new ApplicationsDialog(root, false, found)) {
                    dialog.ShowInTaskbar = false; dialog.Opacity = 0; dialog.Show(); Application.DoEvents();
                    using (var bitmap = new Bitmap(dialog.Width, dialog.Height)) { dialog.DrawToBitmap(bitmap, new Rectangle(0, 0, bitmap.Width, bitmap.Height)); bitmap.Save(Path.Combine(root, "process-dialog.png")); }
                }
                Assert(ProcessGate.RequestClose(app) && cooperative.WaitForExit(5000), "normal window close exits cooperative test application");
                Assert(ProcessGate.RequestClose(found.Single(p => p.Id == stubborn.Id)), "normal close request is sent to stubborn test application");
                Assert(!stubborn.WaitForExit(500), "refused close never becomes forced termination");
                Assert(!other.HasExited, "unrelated same-name application remains running");
                // This child owns only test fixture files and exits on its own.
                var detached = DetachedHost.Start(root, root, Path.Combine(root, "detached"));
                File.WriteAllText(Path.Combine(root, "detached.pid"), detached.Id.ToString()); detached.Dispose();
                Console.WriteLine("PASS detached host started with durable log handles");
                return 0;
            } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
            finally {
                // Cleanup is restricted to Process handles created by this test.
                foreach (var owned in new[] { cooperative, stubborn, other }) if (owned != null) { if (!owned.HasExited) owned.Kill(); owned.WaitForExit(3000); owned.Dispose(); }
            }
        }
    }
}
