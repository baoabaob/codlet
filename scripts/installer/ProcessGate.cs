using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Globalization;
using System.Windows.Forms;

namespace Codlet.Setup {
    public sealed class RunningApplication {
        public int Id; public string Name; public string Path;
        public override string ToString() { return Name + "  ·  PID " + Id + Environment.NewLine + Path; }
    }

    public static class ProcessGate {
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
                            Id = process.Id,
                            Name = process.ProcessName, Path = path
                        });
                    } catch (InvalidOperationException) { } catch (System.ComponentModel.Win32Exception) { }
                }
            }
            return result.OrderBy(p => p.Name).ThenBy(p => p.Id).ToList();
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
        readonly Button retry = new Button();
        List<RunningApplication> found;
        public ApplicationsDialog(string root, bool includeOfficial, List<RunningApplication> initial) {
            directory = root; official = includeOfficial; found = initial;
            bool chinese = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "zh";
            Text = chinese ? "Codlet · 应用正在运行" : "Codlet · Applications are running"; Font = SystemFonts.MessageBoxFont;
            BackColor = Color.White;
            try { Icon = new Icon(System.IO.Path.Combine(root, "codlet.ico")); } catch (IOException) { } catch (ArgumentException) { }
            AutoScaleMode = AutoScaleMode.Dpi; ClientSize = new Size(650, 430);
            StartPosition = FormStartPosition.CenterScreen; FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false; MinimizeBox = false;
            var heading = new Label { Text = chinese ? "请先保存任务，再自行关闭这些应用" : "Save your work, then close these applications", Font = new Font(Font.FontFamily, 15, FontStyle.Bold), AutoSize = false };
            heading.SetBounds(24, 22, 600, 34); Controls.Add(heading);
            var explanation = new Label { Text = chinese ? "请在应用中完成保存并退出，然后点击“重新检查”继续。" : "Quit these applications yourself, then select Check again to continue." };
            explanation.SetBounds(24, 65, 600, 48); Controls.Add(explanation);
            applications.Multiline = true; applications.ReadOnly = true; applications.ScrollBars = ScrollBars.Vertical;
            applications.SetBounds(24, 122, 600, 186); Controls.Add(applications);
            status.SetBounds(24, 322, 600, 43); Controls.Add(status);
            retry.Text = chinese ? "重新检查" : "Check again"; retry.SetBounds(395, 378, 110, 32); Controls.Add(retry);
            var cancel = new Button { Text = chinese ? "取消" : "Cancel", DialogResult = DialogResult.Cancel }; cancel.SetBounds(515, 378, 110, 32); Controls.Add(cancel); CancelButton = cancel;
            retry.Click += delegate {
                if (!RefreshApplications()) status.Text = chinese ? "仍有应用在运行，请自行退出后重试。" : "Applications are still running. Quit them and check again.";
            };
            ShowApplications(); ActiveControl = retry;
        }
        void ShowApplications() { applications.Text = String.Join(Environment.NewLine + Environment.NewLine, found.Select(p => p.ToString())); applications.SelectionStart = 0; applications.SelectionLength = 0; }
        bool RefreshApplications() {
            found = ProcessGate.Find(directory, official); ShowApplications();
            if (found.Count != 0) return false;
            DialogResult = DialogResult.OK; Close(); return true;
        }
    }
}
