using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Codlet.Setup {
    static class Launcher {
        static string root = AppDomain.CurrentDomain.BaseDirectory;
        static string logFile;
        static string coreLogFile;
        static readonly object logLock = new object();
        static void Log(string message) { lock (logLock) File.AppendAllText(logFile, DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine, new UTF8Encoding(false)); }
        [STAThread]
        static int Main(string[] args) {
            bool quiet = args.Contains("--quiet"), configure = args.Contains("--configure"), check = args.Contains("--check"), safeMode = args.Contains("--safe-mode");
            if (args.Any(a => a != "--quiet" && a != "--configure" && a != "--check" && a != "--safe-mode") || (safeMode && configure)) return 87;
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            string data = File.Exists(Path.Combine(root, "portable.mode")) ? Path.Combine(root, "data") : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Codlet");
            try {
                string logs = Path.Combine(data, "launcher-logs"); Directory.CreateDirectory(logs);
                logFile = Path.Combine(logs, DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff") + ".log");
                Log("Codlet launcher: " + root);
                if (quiet && (configure || (!check && !safeMode && File.Exists(Path.Combine(root, "portable.mode")) && !File.Exists(Path.Combine(data, "plugin-setup.json"))))) { Log("Interactive plugin selection is required; run without --quiet first."); return 87; }
                int gate = ProcessGate.Check(root, !quiet, !configure, Log);
                if (gate != 0 || check) return gate;
                // Successful launches have no launcher window. Keep readiness
                // monitoring and surface actionable failures after they occur.
                int result = Start(data, configure, !quiet, safeMode);
                if (result != 0 && result != 1223 && !quiet) {
                    string error = "启动未完成（代码 " + result + "）。请查看日志；不要重复启动多个实例。";
                    MessageBox.Show(error + "\n\n诊断日志：\n" + logFile + "\n" + coreLogFile, "Codlet", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
                return result;
            } catch (Exception error) {
                try { if (logFile != null) Log(error.ToString()); } catch { }
                if (!quiet) MessageBox.Show(error.Message + (logFile == null ? "" : "\n\n诊断日志：\n" + logFile + "\n" + coreLogFile), "Codlet", MessageBoxButtons.OK, MessageBoxIcon.Error);
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
                if (!process.WaitForExit(selection ? Int32.MaxValue : 300000)) { Log("Initialization timed out after 5 minutes; PID " + process.Id + " retained."); return 1460; }
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
        static int Start(string data, bool configure, bool interactive, bool safeMode) {
            // Recovery deliberately skips initialization, downloads and reading
            // plugin configuration; a broken plugin must not block this path.
            if (safeMode) return Launch(data, true).Code;
            int initialized;
            do {
                initialized = Initialize(data, configure);
                if (initialized == 0 || initialized == 1223 || initialized == 1460 || !interactive) break;
                var answer = MessageBox.Show("所选插件尚未完成安装。请检查网络或代理后重试；已安装插件保持不变。\n\n日志：" + logFile,
                    "Codlet · 插件下载未完成", MessageBoxButtons.RetryCancel, MessageBoxIcon.Warning);
                if (answer != DialogResult.Retry) return 1223;
            } while (true);
            if (initialized != 0 || configure) return initialized;
            var result = Launch(data, false);
            if (result.Code == 0 && result.RendererUnavailable && interactive) {
                MessageBox.Show("官方客户端已启动，但 Codlet 暂时无法连接界面，界面插件未加载。现有插件配置保持不变。\n\n请检查 Codlet 和插件更新。诊断日志：\n" + logFile + "\n" + coreLogFile,
                    "Codlet · 插件未加载", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            if (!result.Exited || !interactive) return result.Code;
            var recover = MessageBox.Show("Codlet 在客户端启动就绪前退出（Core 退出码 " + result.CoreExitCode + "）。\n\n官方更新后，插件或客户端接入可能暂时不兼容。是否以安全模式重新启动？\n\n安全模式跳过全部插件，包括流量拦截；现有配置和启用状态保持不变。\n\n诊断日志：\n" + logFile + "\n" + logFile + ".core.log",
                "Codlet · 启动恢复", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
            if (recover != DialogResult.Yes) return 1223;
            // An early Core exit may have left its desktop alive. Recheck the
            // ordinary process gate before trying another launch; never kill it.
            int gate = ProcessGate.Check(root, true, true, Log);
            return gate == 0 ? Launch(data, true).Code : gate;
        }

        sealed class LaunchResult {
            public int Code, CoreExitCode;
            public bool Exited, RendererUnavailable;
        }
        static bool RendererUnavailable(Dictionary<string, object> snapshot) {
            object raw, events;
            if (!snapshot.TryGetValue("renderer", out raw)) return false;
            var renderer = raw as Dictionary<string, object>;
            if (renderer == null || !renderer.TryGetValue("recent_events", out events)) return false;
            var rows = events as System.Collections.IEnumerable;
            if (rows == null) return false;
            foreach (var row in rows) {
                var item = row as Dictionary<string, object>; object code;
                if (item != null && item.TryGetValue("code", out code) && (string)code == "renderer_executor_unavailable") return true;
            }
            return false;
        }
        static LaunchResult Launch(string data, bool safeMode) {
            // Core is a long-lived host. Its exit is not launch readiness.
            string coreLog = logFile + (safeMode ? ".safe" : "");
            coreLogFile = coreLog + ".core.log";
            Log("Core mode: " + (safeMode ? "safe" : "normal") + "; stdout/stderr: " + coreLog + ".core.log");
            using (var process = DetachedHost.Start(root, data, coreLog, safeMode)) {
            int pid = process.Id; long created = process.StartTime.ToUniversalTime().Ticks;
            DateTime deadline = DateTime.UtcNow.AddMinutes(5);
            while (DateTime.UtcNow < deadline) {
                if (process.HasExited) {
                    int code = process.ExitCode;
                    Log("Core exited before readiness: " + code + " (0x" + code.ToString("X8") + ")");
                    return new LaunchResult { Code = 42, CoreExitCode = code, Exited = true };
                }
                var value = Status(data); object status, raw;
                if (value != null && value.TryGetValue("status", out status) && (string)status == "running" && value.TryGetValue("snapshot", out raw)) {
                    var snapshot = raw as Dictionary<string, object>; object hostPid, state;
                    if (snapshot != null && snapshot.TryGetValue("host_pid", out hostPid) && Convert.ToInt32(hostPid) == pid && snapshot.TryGetValue("state", out state) && (string)state == "ready" && !process.HasExited && process.StartTime.ToUniversalTime().Ticks == created) {
                        bool unavailable = RendererUnavailable(snapshot);
                        Log("Core ready, PID " + pid + "; mode: " + (safeMode ? "safe" : "normal") + "; renderer unavailable: " + unavailable);
                        return new LaunchResult { RendererUnavailable = unavailable };
                    }
                }
                Thread.Sleep(400);
            }
            Log("Readiness timed out after 5 minutes. Core PID " + pid + " retained; do not start another instance before inspecting this log.");
            return new LaunchResult { Code = 42 };
            }
        }
    }

}
