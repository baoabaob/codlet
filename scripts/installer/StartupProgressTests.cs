using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Codlet.Setup {
    static class StartupProgressTests {
        static void Require(bool value, string message) { if (!value) throw new Exception(message); }
        static string Event(string fields) { return "codlet-startup: {\"schema\":1,\"processId\":1234," + fields + "}\n"; }
        static void Append(string path, byte[] bytes, int start, int count) {
            using (var file = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite)) file.Write(bytes, start, count);
        }
        [STAThread] static int Main(string[] args) {
            try {
                string output = Path.GetFullPath(args[0]); Directory.CreateDirectory(output);
                Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
                string input = Event("\"phase\":\"runtime.downloading\",\"version\":\"24.21.0\",\"source\":\"GitHub\",\"receivedBytes\":20971520,\"totalBytes\":41943040");
                var download = StartupProgressSnapshot.Parse(input.TrimEnd(), 1234);
                Require(download != null && download.Received == 20971520 && download.Total == 41943040, "Download facts changed");
                Require(StartupProgressSnapshot.Parse(input.TrimEnd(), 1235) == null, "Foreign Core progress accepted");
                Require(StartupProgressSnapshot.Parse(Event("\"phase\":\"untrusted\"").TrimEnd(), 1234) == null, "Unknown phase accepted");
                Require(StartupProgressSnapshot.Parse("codlet-startup: {invalid}", 1234) == null, "Incomplete JSON accepted");
                string logPath = Path.Combine(output, "fixture.core.log");
                byte[] bytes = Encoding.UTF8.GetBytes("准备消息\n" + input);
                File.WriteAllBytes(logPath, new byte[0]);
                using (var log = new StartupProgressLog(logPath, 1234)) {
                    Append(logPath, bytes, 0, 2);
                    Require(log.ReadLatest() == null, "Split UTF-8 became a progress record");
                    Append(logPath, bytes, 2, bytes.Length - 3);
                    Require(log.ReadLatest() == null, "Unterminated event was consumed");
                    Append(logPath, bytes, bytes.Length - 1, 1);
                    var observed = log.ReadLatest();
                    Require(observed != null && observed.Received == download.Received, "Partial log record was lost");
                    Require(log.ReadLatest() == null, "Log event replayed");
                }
                foreach (bool chinese in new[] { true, false }) foreach (bool dark in new[] { true, false }) {
                    using (var window = new StartupProgressWindow(logPath, chinese, dark)) {
                        window.Render(download);
                        Require(window.Percentage == 50 && !window.Indeterminate, "Known size must show actual percentage");
                        Require(window.AmountText.Contains("20.0 / 40.0 MB") && window.AmountText.Contains("50%"), "Visible byte count is wrong");
                        window.StartPosition = FormStartPosition.Manual;
                        window.Location = new Point(-20000, -20000);
                        window.ShowInTaskbar = false;
                        window.Show();
                        Application.DoEvents();
                        System.Threading.Thread.Sleep(500);
                        Application.DoEvents();
                        window.PerformLayout();
                        foreach (Control control in window.Controls) {
                            control.CreateControl();
                            Require(control.Right <= window.ClientSize.Width && control.Bottom <= window.ClientSize.Height, "Progress layout clips controls");
                        }
                        using (var bitmap = new Bitmap(window.Width, window.Height)) {
                            window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
                            bitmap.Save(Path.Combine(output, (chinese ? "chinese" : "english") + (dark ? "-dark.png" : "-light.png")), ImageFormat.Png);
                        }
                        var unknown = StartupProgressSnapshot.Parse(Event("\"phase\":\"runtime.downloading\",\"source\":\"nodejs.org\",\"receivedBytes\":1048576").TrimEnd(), 1234);
                        window.Render(unknown);
                        Require(window.Indeterminate && window.AmountText.Contains("1.0 MB") && !window.AmountText.Contains("%"), "Unknown size must not invent a percentage");
                        var retry = StartupProgressSnapshot.Parse(Event("\"phase\":\"runtime.retrying\",\"source\":\"GitHub\"").TrimEnd(), 1234);
                        window.Render(retry);
                        Require(window.Indeterminate && !window.AmountText.Contains("1.0 MB"), "Retry retained the old download count");
                        var verify = StartupProgressSnapshot.Parse(Event("\"phase\":\"runtime.verifying\"").TrimEnd(), 1234);
                        window.Render(verify);
                        Require(window.Indeterminate && window.StageText.Length > 0, "Verification stage missing");
                    }
                }
                var report = new { passed = true, progressUsesActualBytes = true, unknownSizeIsIndeterminate = true, partialLogLinesPreserved = true,
                    foreignProcessRejected = true, languages = new[] { "chinese", "english" }, themes = new[] { "dark", "light" }, clientStarted = false };
                File.WriteAllText(Path.Combine(output, "report.json"), new JavaScriptSerializer().Serialize(report), new UTF8Encoding(false));
                return 0;
            } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        }
    }
}
