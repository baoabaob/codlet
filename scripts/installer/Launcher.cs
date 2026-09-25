using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
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
            bool refreshPlugins = false;
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
                    using (var sha = SHA256.Create()) fingerprint = "completed-v2:" + BitConverter.ToString(sha.ComputeHash(File.ReadAllBytes(catalog))).Replace("-", "");
                    if (!File.Exists(marker) || File.ReadAllText(marker) != fingerprint) {
                        const string notice = "此安装包包含新的官方插件。更新会校验已有官方文件，保留禁用状态和授权范围；新增权限单独确认，修改过的作者文件不会覆盖。\n\n选择“确定”选择并更新插件；选择“取消”继续使用当前插件。";
                        if (quiet) Log("Official plugin bundle changed. Existing plugins retained; run Codlet-Launcher.exe --configure to check versions.");
                        else {
                            refreshPlugins = MessageBox.Show(notice, "Codlet · 检查官方插件版本", MessageBoxButtons.OKCancel, MessageBoxIcon.Information) == DialogResult.OK;
                        }
                    }
                }
                if (quiet && (configure || (!check && File.Exists(Path.Combine(root, "portable.mode")) && !File.Exists(Path.Combine(data, "plugin-setup.json"))))) { Log("Interactive plugin selection is required; run without --quiet first."); return 87; }
                int gate = ProcessGate.Check(root, !quiet, !configure, Log);
                if (gate != 0 || check) return gate;
                // Successful launches have no launcher window. Keep readiness
                // monitoring and surface actionable failures after they occur.
                int result = Start(data, configure, refreshPlugins);
                if (result != 0 && !quiet) {
                    string error = result == 20
                        ? "官方插件更新失败，现有文件和授权已保留。请查看日志后重试。"
                        : "启动未完成（代码 " + result + "）。请查看日志；不要重复启动多个实例。";
                    MessageBox.Show(error + "\n\n诊断日志：\n" + logFile, "Codlet", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
                return result;
            } catch (Exception error) {
                try { if (logFile != null) Log(error.ToString()); } catch { }
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
        static int Start(string data, bool configure, bool refreshPlugins) {
            int initialized = Initialize(data, configure || refreshPlugins); if (initialized != 0 || configure) return initialized;
            // Core is a long-lived host. Its exit is not launch readiness.
            Log("Core stdout/stderr: " + logFile + ".core.log");
            var process = DetachedHost.Start(root, data, logFile);
            int pid = process.Id; long created = process.StartTime.ToUniversalTime().Ticks;
            DateTime deadline = DateTime.UtcNow.AddMinutes(5);
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
            Log("Readiness timed out after 5 minutes. Core PID " + pid + " retained; do not start another instance before inspecting this log.");
            return 42;
        }
    }

}
