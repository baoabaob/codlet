using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Codlet.Setup {
    static class Launcher {
        static string root = AppDomain.CurrentDomain.BaseDirectory;
        static string logFile;
        static readonly object logLock = new object();
        static void Log(string message) { lock (logLock) File.AppendAllText(logFile, DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine, new UTF8Encoding(false)); }
        [STAThread]
        static int Main(string[] args) {
            bool quiet = args.Contains("--quiet"), configure = args.Contains("--configure"), check = args.Contains("--check");
            if (args.Any(a => a != "--quiet" && a != "--configure" && a != "--check")) return 87;
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            string data = File.Exists(Path.Combine(root, "portable.mode")) ? Path.Combine(root, "data") : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Codlet");
            try {
                string logs = Path.Combine(data, "launcher-logs"); Directory.CreateDirectory(logs);
                logFile = Path.Combine(logs, DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff") + ".log");
                Log("Codlet launcher: " + root);
                if (!configure && !check && File.Exists(Path.Combine(data, "plugin-setup.json"))) {
                    string catalog = Path.Combine(root, "optional-plugins", "catalog.json"), marker = Path.Combine(data, "plugin-bundle-reviewed.txt");
                    string fingerprint;
                    using (var sha = SHA256.Create()) fingerprint = BitConverter.ToString(sha.ComputeHash(File.ReadAllBytes(catalog))).Replace("-", "");
                    if (!File.Exists(marker) || File.ReadAllText(marker) != fingerprint) {
                        const string notice = "此安装包可能包含新的官方插件。更新 Core 不会覆盖已有插件目录。\n\n选择“确定”检查所选插件；版本不符时会提示手动迁移。选择“取消”继续使用当前插件。";
                        if (quiet) Log("Official plugin bundle changed. Existing plugins retained; run Codlet-Launcher.exe --configure to check versions.");
                        else {
                            configure = MessageBox.Show(notice, "Codlet · 检查官方插件版本", MessageBoxButtons.OKCancel, MessageBoxIcon.Information) == DialogResult.OK;
                            File.WriteAllText(marker, fingerprint, new UTF8Encoding(false));
                        }
                    }
                }
                if (quiet && (configure || (!check && File.Exists(Path.Combine(root, "portable.mode")) && !File.Exists(Path.Combine(data, "plugin-setup.json"))))) { Log("Interactive plugin selection is required; run without --quiet first."); return 87; }
                int gate = ProcessGate.Check(root, !quiet, !configure, Log);
                if (gate != 0 || check) return gate;
                if (quiet) return Start(data, configure, null);
                using (var form = new ProgressDialog()) {
                    int result = 1;
                    form.Shown += async delegate {
                        try { result = await Task.Run(() => Start(data, configure, message => form.BeginInvoke((Action)(() => form.Status.Text = message)))); }
                        catch (Exception error) { Log(error.ToString()); form.Error = "启动失败：" + error.Message; }
                        if (result == 20 && form.Error == null) form.Error = "官方插件未更新：已有注册或文件与安装包不同。本预览版保留现有目录、授权和禁用状态，请通过插件管理检查来源与权限差额后手动迁移。重新打开 Codlet 可以继续使用当前配置。";
                        if (result != 0 && form.Error == null) form.Error = "操作未完成（代码 " + result + "）。已启动的进程不会被强制关闭。";
                        form.Finish();
                    };
                    form.ShowDialog();
                    if (form.Error != null) MessageBox.Show(form.Error + "\n\n诊断日志：\n" + logFile, "Codlet", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return result;
                }
            } catch (Exception error) {
                if (!quiet) MessageBox.Show(error.Message, "Codlet", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        static ProcessStartInfo Info(string executable, string arguments, string data) {
            var info = new ProcessStartInfo(executable, arguments) { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
            info.EnvironmentVariables["CODLET_HOME"] = data;
            return info;
        }
        static int Initialize(string data, bool configure) {
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
            string command = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + Path.Combine(root, "Initialize-Codlet.ps1") + "\" -NoLaunch" + (configure ? " -Configure" : "");
            // The plugin selection form requires STA; -NonInteractive only prevents
            // terminal prompts. Its explicit user interaction has no expiry.
            using (var process = Process.Start(Info(powershell, "-STA " + command, data))) {
                var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
                bool selection = configure || (File.Exists(Path.Combine(root, "portable.mode")) && !File.Exists(Path.Combine(data, "plugin-setup.json")));
                if (!process.WaitForExit(selection ? Int32.MaxValue : 60000)) { Log("Initialization timed out after 60 seconds; PID " + process.Id + " retained."); return 1460; }
                Log(stdout.Result); Log(stderr.Result); return process.ExitCode;
            }
        }
        static Dictionary<string, object> Status(string data) {
            using (var process = Process.Start(Info(Path.Combine(root, "codlet.exe"), "status --json", data))) {
                var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit(3000)) { try { process.Kill(); } catch { } return null; }
                if (process.ExitCode != 0) return null;
                try { return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(stdout.Result); } catch { return null; }
            }
        }
        static int Start(string data, bool configure, Action<string> progress) {
            if (progress != null) progress("正在准备所选插件…");
            int initialized = Initialize(data, configure); if (initialized != 0 || configure) return initialized;
            if (progress != null) progress("正在启动 Codex 并等待就绪（最多 90 秒）…");
            // Core is a long-lived host. Its exit is not launch readiness.
            Log("Core stdout/stderr: " + logFile + ".core.log");
            var process = DetachedHost.Start(root, data, logFile);
            int pid = process.Id; long created = process.StartTime.ToUniversalTime().Ticks;
            DateTime deadline = DateTime.UtcNow.AddSeconds(90);
            while (DateTime.UtcNow < deadline) {
                if (process.HasExited) { Log("Core exited before readiness: " + process.ExitCode); process.Dispose(); return 42; }
                var value = Status(data); object status, raw;
                if (value != null && value.TryGetValue("status", out status) && (string)status == "running" && value.TryGetValue("snapshot", out raw)) {
                    var snapshot = raw as Dictionary<string, object>; object hostPid, state;
                    if (snapshot != null && snapshot.TryGetValue("host_pid", out hostPid) && Convert.ToInt32(hostPid) == pid && snapshot.TryGetValue("state", out state) && (string)state == "ready" && !process.HasExited && process.StartTime.ToUniversalTime().Ticks == created) {
                        Log("Core ready, PID " + pid); return 0;
                    }
                }
                Thread.Sleep(400);
            }
            Log("Readiness timed out after 90 seconds. Core PID " + pid + " retained; do not start another instance before inspecting this log.");
            return 42;
        }
    }

    sealed class ProgressDialog : Form {
        public Label Status = new Label(); public string Error; bool finished;
        public ProgressDialog() {
            Text = "Codlet"; Font = SystemFonts.MessageBoxFont; AutoScaleMode = AutoScaleMode.Dpi;
            ClientSize = new Size(520, 150); StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false;
            Status.SetBounds(24, 26, 472, 54); Controls.Add(Status);
            var bar = new ProgressBar { Style = ProgressBarStyle.Marquee }; bar.SetBounds(24, 96, 472, 18); Controls.Add(bar);
            FormClosing += delegate(object sender, FormClosingEventArgs e) { if (!finished) e.Cancel = true; };
        }
        public void Finish() { finished = true; Close(); }
    }
}
