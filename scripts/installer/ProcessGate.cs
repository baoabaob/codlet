using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Codlet.Setup {
    public sealed class RunningApplication {
        public int Id; public long Created; public string Name; public string Path;
        public override string ToString() { return Name + "  ·  PID " + Id + Environment.NewLine + Path; }
    }

    public static class ProcessGate {
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
        delegate bool WindowVisitor(IntPtr window, IntPtr state);
        [DllImport("user32.dll")] static extern bool EnumWindows(WindowVisitor visitor, IntPtr state);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);

        public static bool IsWithin(string file, string directory) {
            if (String.IsNullOrEmpty(file) || String.IsNullOrEmpty(directory)) return false;
            return System.IO.Path.GetFullPath(file).StartsWith(System.IO.Path.GetFullPath(directory).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
        }

        // Names narrow enumeration only. An official desktop executable must also
        // identify its publisher/product; owned binaries must be inside this install.
        public static bool IsRelevant(string name, string path, string directory, bool official) {
            if (IsWithin(path, directory)) return true;
            if (!official || (name != "codex" && name != "chatgpt") || String.IsNullOrEmpty(path)) return false;
            try {
                var version = FileVersionInfo.GetVersionInfo(path);
                return (version.CompanyName ?? "").IndexOf("OpenAI", StringComparison.OrdinalIgnoreCase) >= 0
                    && (version.ProductName ?? "").IndexOf("Codex", StringComparison.OrdinalIgnoreCase) >= 0;
            } catch { return false; }
        }

        public static List<RunningApplication> Find(string directory, bool official) {
            var result = new List<RunningApplication>();
            using (var self = Process.GetCurrentProcess()) {
                foreach (var process in Process.GetProcesses()) using (process) {
                    try {
                        if (process.Id == self.Id || process.SessionId != self.SessionId) continue;
                        string name = process.ProcessName.ToLowerInvariant();
                        // Avoid unrelated system/other-user process metadata requests.
                        if (name != "codex" && name != "chatgpt" && name != "codlet" && name != "node" && name != "codlet-launcher") continue;
                        string path = process.MainModule.FileName;
                        if (IsRelevant(name, path, directory, official)) result.Add(new RunningApplication {
                            Id = process.Id, Created = process.StartTime.ToUniversalTime().Ticks,
                            Name = process.ProcessName, Path = path
                        });
                    } catch (InvalidOperationException) { } catch (System.ComponentModel.Win32Exception) { }
                }
            }
            return result.OrderBy(p => p.Name).ThenBy(p => p.Id).ToList();
        }

        public static bool RequestClose(RunningApplication app) {
            // Revalidate PID + creation time + image before sending WM_CLOSE.
            // No TerminateProcess, taskkill, restart-manager shutdown or broad name kill.
            try { using (var process = Process.GetProcessById(app.Id)) {
                if (process.StartTime.ToUniversalTime().Ticks != app.Created || !String.Equals(process.MainModule.FileName, app.Path, StringComparison.OrdinalIgnoreCase)) return false;
                bool sent = false;
                EnumWindows(delegate(IntPtr window, IntPtr state) {
                    uint pid; GetWindowThreadProcessId(window, out pid);
                    if (pid == app.Id && IsWindowVisible(window) && !process.HasExited)
                        sent |= PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
                    return true;
                }, IntPtr.Zero);
                return sent;
            } } catch { return false; }
        }

        public static int Check(string directory, bool interactive, bool official, Action<string> log) {
            var found = Find(directory, official);
            if (found.Count == 0) return 0;
            log("Running applications block this operation:\n" + String.Join("\n", found.Select(p => p.ToString())));
            if (!interactive) return 1618;
            using (var dialog = new ApplicationsDialog(directory, official, found)) {
                return dialog.ShowDialog() == DialogResult.OK ? 0 : 1602;
            }
        }
    }

    sealed class ApplicationsDialog : Form {
        readonly string directory; readonly bool official;
        readonly TextBox applications = new TextBox(); readonly Label status = new Label();
        readonly Button close = new Button(); readonly Button retry = new Button();
        readonly Timer timer = new Timer(); List<RunningApplication> found; DateTime deadline;
        public ApplicationsDialog(string root, bool includeOfficial, List<RunningApplication> initial) {
            directory = root; official = includeOfficial; found = initial;
            Text = "Codlet · 应用正在运行"; Font = SystemFonts.MessageBoxFont;
            BackColor = Color.White;
            try { Icon = new Icon(System.IO.Path.Combine(root, "codlet.ico")); } catch (IOException) { } catch (ArgumentException) { }
            AutoScaleMode = AutoScaleMode.Dpi; ClientSize = new Size(650, 430);
            StartPosition = FormStartPosition.CenterScreen; FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false; MinimizeBox = false;
            var heading = new Label { Text = "请先保存任务，再关闭这些应用", Font = new Font(Font.FontFamily, 15, FontStyle.Bold), AutoSize = false };
            heading.SetBounds(24, 22, 600, 34); Controls.Add(heading);
            var explanation = new Label { Text = "安装或启动需要释放正在使用的客户端与程序文件。\n“请求正常关闭”只向下列应用发送关闭窗口请求，不会强制结束任务。" };
            explanation.SetBounds(24, 65, 600, 48); Controls.Add(explanation);
            applications.Multiline = true; applications.ReadOnly = true; applications.ScrollBars = ScrollBars.Vertical;
            applications.SetBounds(24, 122, 600, 186); Controls.Add(applications);
            status.SetBounds(24, 322, 600, 43); Controls.Add(status);
            close.Text = "请求正常关闭"; close.SetBounds(250, 378, 135, 32); Controls.Add(close);
            retry.Text = "重新检查"; retry.SetBounds(395, 378, 110, 32); Controls.Add(retry);
            var cancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel }; cancel.SetBounds(515, 378, 110, 32); Controls.Add(cancel); CancelButton = cancel;
            close.Click += delegate {
                foreach (var app in found) ProcessGate.RequestClose(app);
                deadline = DateTime.UtcNow.AddSeconds(12); close.Enabled = false; retry.Enabled = false;
                status.Text = "正在等待正常退出（最多 12 秒）… 可随时取消。"; timer.Start();
            };
            retry.Click += delegate { RefreshApplications(); };
            timer.Interval = 500; timer.Tick += delegate {
                if (RefreshApplications()) return;
                if (DateTime.UtcNow >= deadline) { timer.Stop(); close.Enabled = true; retry.Enabled = true; status.Text = "仍有应用未退出。请手动保存并退出后重新检查；后台进程不会被强制结束。"; }
            };
            FormClosed += delegate { timer.Stop(); timer.Dispose(); };
            ShowApplications(); ActiveControl = retry;
        }
        void ShowApplications() { applications.Text = String.Join(Environment.NewLine + Environment.NewLine, found.Select(p => p.ToString())); applications.SelectionStart = 0; applications.SelectionLength = 0; }
        bool RefreshApplications() {
            found = ProcessGate.Find(directory, official); ShowApplications();
            if (found.Count != 0) return false;
            timer.Stop(); DialogResult = DialogResult.OK; Close(); return true;
        }
    }
}
