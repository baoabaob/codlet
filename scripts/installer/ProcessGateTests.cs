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
                using (var dialog = new ApplicationsDialog(root, false, found)) {
                    dialog.ShowInTaskbar = false; dialog.Opacity = 0; dialog.Show(); Application.DoEvents();
                    using (var bitmap = new Bitmap(dialog.Width, dialog.Height)) { dialog.DrawToBitmap(bitmap, new Rectangle(0, 0, bitmap.Width, bitmap.Height)); bitmap.Save(Path.Combine(root, "process-dialog.png")); }
                    var buttons = dialog.Controls.OfType<Button>().ToArray();
                    Assert(buttons.Length == 2, "process gate offers only retry and cancel");
                    buttons.Single(button => button.DialogResult != DialogResult.Cancel).PerformClick(); Application.DoEvents();
                    Assert(!cooperative.HasExited && !stubborn.HasExited && dialog.Visible, "rechecking never closes applications");
                    buttons.Single(button => button.DialogResult == DialogResult.Cancel).PerformClick(); Application.DoEvents();
                    Assert(!cooperative.HasExited && !stubborn.HasExited, "cancelling leaves applications running");
                }
                Assert(!other.HasExited, "unrelated same-name application remains running");
                // Simulate the user closing only the fixtures; production has no
                // close/terminate operation in its process gate.
                cooperative.Kill(); stubborn.Kill(); cooperative.WaitForExit(3000); stubborn.WaitForExit(3000);
                Assert(ProcessGate.Check(root, false, false, Console.WriteLine) == 0, "manual exit allows the next check to continue");
                string exitFile = Path.Combine(root, "fixture-exit-code");
                try {
                    foreach (int code in new[] { 23, 0, 259 }) {
                        File.WriteAllText(exitFile, code.ToString());
                        using (var early = DetachedHost.Start(root, root, Path.Combine(root, "early-" + code))) {
                            long created = early.StartTime.ToUniversalTime().Ticks;
                            var deadline = Stopwatch.StartNew();
                            while (!early.HasExited && deadline.ElapsedMilliseconds < 5000) Thread.Sleep(10);
                            Assert(early.HasExited, "early Core exit is observed");
                            Assert(early.ExitCode == code, "early Core exit code is preserved: " + code);
                            Assert(early.StartTime.ToUniversalTime().Ticks == created, "process identity survives exit");
                        }
                    }
                } finally { File.Delete(exitFile); }
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
