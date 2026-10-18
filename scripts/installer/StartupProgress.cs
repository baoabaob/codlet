using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Collections.Generic;

namespace Codlet.Setup {
    sealed class StartupProgressSnapshot {
        public string Phase, Version, Source;
        public long Received;
        public long? Total;
        public static StartupProgressSnapshot Parse(string line, int processId) {
            const string prefix = "codlet-startup: ";
            if (line == null || line.Length > 8192 || !line.StartsWith(prefix, StringComparison.Ordinal)) return null;
            try {
                var value = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line.Substring(prefix.Length));
                object raw;
                if (!value.TryGetValue("schema", out raw) || Convert.ToInt32(raw) != 1 ||
                    !value.TryGetValue("processId", out raw) || Convert.ToInt32(raw) != processId ||
                    !value.TryGetValue("phase", out raw)) return null;
                var phase = raw as string;
                switch (phase) {
                    case "plugins.checking": case "runtime.checking": case "runtime.native":
                    case "runtime.copying": case "runtime.connecting": case "runtime.downloading":
                    case "runtime.retrying": case "runtime.verifying": case "runtime.extracting":
                    case "runtime.ready": case "client.starting": break;
                    default: return null;
                }
                var result = new StartupProgressSnapshot { Phase = phase };
                if (value.TryGetValue("version", out raw)) {
                    var version = raw as string;
                    if (version != null && version.Length <= 64 && System.Text.RegularExpressions.Regex.IsMatch(version, @"^\d+\.\d+\.\d+$")) result.Version = version;
                }
                if (value.TryGetValue("source", out raw) && (string)raw != null) {
                    var source = raw as string;
                    if (source == "native" || source == "GitHub" || source == "nodejs.org") result.Source = source;
                }
                if (value.TryGetValue("receivedBytes", out raw)) result.Received = Math.Max(0, Convert.ToInt64(raw));
                if (value.TryGetValue("totalBytes", out raw) && raw != null) {
                    long total = Convert.ToInt64(raw);
                    if (total > 0 && total <= 200L * 1024 * 1024) result.Total = total;
                }
                if (result.Received > 200L * 1024 * 1024) return null;
                return result;
            } catch { return null; }
        }
    }

    // Tail the exact log created for this launch, including split UTF-8 lines.
    sealed class StartupProgressLog : IDisposable {
        readonly string path;
        readonly int processId;
        readonly Decoder decoder = Encoding.UTF8.GetDecoder();
        readonly StringBuilder pending = new StringBuilder();
        FileStream stream;
        public StartupProgressLog(string path, int processId) { this.path = path; this.processId = processId; }
        public StartupProgressSnapshot ReadLatest() {
            StartupProgressSnapshot latest = null;
            try {
                if (stream == null) stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                byte[] bytes = new byte[4096]; char[] chars = new char[4096];
                int budget = 128 * 1024, count;
                while (budget > 0 && (count = stream.Read(bytes, 0, Math.Min(bytes.Length, budget))) > 0) {
                    budget -= count;
                    int length = decoder.GetChars(bytes, 0, count, chars, 0, false);
                    for (int i = 0; i < length; i++) {
                        if (chars[i] == '\n') {
                            var parsed = StartupProgressSnapshot.Parse(pending.ToString().TrimEnd('\r'), processId);
                            if (parsed != null) latest = parsed;
                            pending.Length = 0;
                        } else if (pending.Length < 8193) pending.Append(chars[i]);
                    }
                }
            } catch (IOException) { } catch (UnauthorizedAccessException) { }
            return latest;
        }
        public void Dispose() { if (stream != null) stream.Dispose(); }
    }

    sealed class StartupProgressWindow : Form {
        protected override bool ShowWithoutActivation { get { return true; } }
        readonly Label heading, description, amount;
        readonly ProgressBar progress;
        readonly bool chinese;
        public bool Dismissed { get; private set; }
        public string StageText { get { return description.Text; } }
        public string AmountText { get { return amount.Text; } }
        public int Percentage { get { return progress.Value; } }
        public bool Indeterminate { get { return progress.Style == ProgressBarStyle.Marquee; } }
        public StartupProgressWindow(string logPath, bool chinese, bool dark) {
            this.chinese = chinese;
            Text = "Codlet"; FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi; ClientSize = new Size(480, 220);
            Font = new Font("Segoe UI", 10); ShowInTaskbar = true;
            BackColor = dark ? Color.FromArgb(31, 31, 31) : Color.White;
            ForeColor = dark ? Color.FromArgb(240, 240, 240) : Color.FromArgb(30, 30, 30);
            heading = new Label { Text = chinese ? "正在启动 Codlet" : "Starting Codlet", Font = new Font("Segoe UI", 17, FontStyle.Bold), AutoSize = false, Location = new Point(24, 22), Size = new Size(432, 36) };
            description = new Label { AutoSize = false, Location = new Point(24, 72), Size = new Size(432, 28) };
            progress = new ProgressBar { Location = new Point(24, 110), Size = new Size(432, 12), Minimum = 0, Maximum = 100, Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 25 };
            amount = new Label { AutoSize = false, Location = new Point(24, 132), Size = new Size(432, 26), ForeColor = dark ? Color.FromArgb(185, 185, 185) : Color.FromArgb(95, 95, 95) };
            var logs = new LinkLabel { Text = chinese ? "查看日志" : "View log", AutoSize = true, Location = new Point(24, 183), LinkColor = dark ? Color.FromArgb(160, 200, 245) : Color.FromArgb(35, 90, 155) };
            logs.LinkClicked += (sender, args) => {
                try { Process.Start(new ProcessStartInfo("explorer.exe", "/select,\"" + logPath + "\"") { UseShellExecute = true }); } catch { }
            };
            var background = new Button { Text = chinese ? "后台继续" : "Continue in background", Location = new Point(268, 173), Size = new Size(188, 32), FlatStyle = FlatStyle.Flat };
            background.Click += (sender, args) => Dismiss();
            Controls.AddRange(new Control[] { heading, description, progress, amount, logs, background });
            FormClosing += (sender, args) => { args.Cancel = true; Dismiss(); };
        }
        void Dismiss() { Dismissed = true; Hide(); }
        string Choose(string zh, string en) { return chinese ? zh : en; }
        public void Render(StartupProgressSnapshot value) {
            switch (value.Phase) {
                case "plugins.checking": description.Text = Choose("正在检查插件更新…", "Checking plugin updates…"); break;
                case "runtime.native": description.Text = Choose("正在检查客户端的 Node.js…", "Checking the client's Node.js…"); break;
                case "runtime.copying": description.Text = Choose("正在复用客户端的 Node.js…", "Reusing the client's Node.js…"); break;
                case "runtime.connecting": description.Text = Choose("正在连接下载源…", "Connecting to the download source…"); break;
                case "runtime.downloading": description.Text = Choose("正在下载运行环境…", "Downloading the runtime…"); break;
                case "runtime.retrying": description.Text = Choose("下载中断，正在重试…", "Download interrupted. Retrying…"); break;
                case "runtime.verifying": description.Text = Choose("正在校验下载文件…", "Verifying the download…"); break;
                case "runtime.extracting": description.Text = Choose("正在安装运行环境…", "Installing the runtime…"); break;
                case "runtime.ready": description.Text = Choose("运行环境已就绪", "Runtime ready"); break;
                case "client.starting": description.Text = Choose("正在打开客户端…", "Opening the client…"); break;
                default: description.Text = Choose("正在准备运行环境…", "Preparing the runtime…"); break;
            }
            string identity = value.Version == null ? "" : "Node.js " + value.Version;
            if (value.Source != null && value.Source != "native") identity += (identity.Length == 0 ? "" : " · ") + value.Source;
            bool downloading = value.Phase == "runtime.downloading";
            if (downloading && value.Total.HasValue) {
                int percent = (int)Math.Min(100, value.Received * 100 / value.Total.Value);
                progress.Style = ProgressBarStyle.Continuous; progress.Value = percent;
                amount.Text = String.Format(CultureInfo.InvariantCulture, "{0}  {1:0.0} / {2:0.0} MB  ({3}%)", identity, value.Received / 1048576.0, value.Total.Value / 1048576.0, percent).Trim();
            } else {
                progress.Style = ProgressBarStyle.Marquee;
                amount.Text = downloading
                    ? String.Format(CultureInfo.InvariantCulture, "{0}  {1:0.0} MB", identity, value.Received / 1048576.0).Trim()
                    : identity;
            }
        }
    }

    sealed class StartupProgress : IDisposable {
        readonly StartupProgressLog log;
        readonly string path;
        readonly bool interactive;
        readonly Stopwatch started = Stopwatch.StartNew();
        StartupProgressWindow window;
        StartupProgressSnapshot current;
        bool complete;
        public StartupProgress(string path, int processId, bool interactive) {
            this.path = path; this.interactive = interactive;
            log = new StartupProgressLog(path, processId);
        }
        public void Pump() {
            if (!interactive) return;
            var update = log.ReadLatest();
            if (update != null) {
                if (current != null) {
                    if (update.Version == null) update.Version = current.Version;
                    if (update.Source == null && update.Phase != "plugins.checking") update.Source = current.Source;
                }
                current = update;
            }
            if (current != null && !complete) {
                if (current.Phase == "client.starting") {
                    complete = true;
                    if (window != null) { window.Dispose(); window = null; }
                } else {
                    bool preparing = current.Phase == "runtime.connecting" || current.Phase == "runtime.downloading" ||
                        current.Phase == "runtime.copying" || current.Phase == "runtime.retrying" ||
                        current.Phase == "runtime.verifying" || current.Phase == "runtime.extracting";
                    if (window == null && (preparing || started.ElapsedMilliseconds >= 1500 && current.Phase != "runtime.ready")) {
                        bool dark = false;
                        try { dark = Convert.ToInt32(Microsoft.Win32.Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1)) == 0; } catch { }
                        window = new StartupProgressWindow(path, CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "zh", dark);
                        window.Render(current); window.Show();
                    }
                    if (window != null) window.Render(current);
                }
            }
            Application.DoEvents();
        }
        public void Dispose() {
            log.Dispose();
            if (window != null) window.Dispose();
        }
    }
}
