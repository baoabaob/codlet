using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Microsoft.Win32;

namespace Codlet.Setup {
    static class SetupProgram {
        [STAThread] public static int Main(string[] args) {
            try {
                bool preview = args.Contains("--preview") || args.Contains("--self-test");
#if SETUP_FIXTURE
                if (!preview) return 87;
#endif
                var app = new Application();
                if (args.Contains("--chinese")) System.Threading.Thread.CurrentThread.CurrentUICulture = CultureInfo.GetCultureInfo("zh-CN");
                var setup = new SetupWindow(preview, args.Contains("--english"));
                if (args.Contains("--self-test")) {
                    int index = Array.IndexOf(args, "--self-test");
                    if (index + 1 >= args.Length) return 87;
                    setup.Verify(Path.GetFullPath(args[index + 1])); return 0;
                }
                return app.Run(setup.Window);
            } catch (Exception error) {
                int check = Array.IndexOf(args, "--self-test");
                if (check >= 0 && check + 1 < args.Length) { Directory.CreateDirectory(args[check + 1]); File.WriteAllText(Path.Combine(args[check + 1], "failure.txt"), error.ToString()); return 1; }
                MessageBox.Show(error.Message, "Codlet", MessageBoxButton.OK, MessageBoxImage.Error); return 1;
            }
        }
    }

    sealed class SetupWindow {
        public readonly Window Window;
        readonly bool preview, chinese;
        readonly Dictionary<string, string> folders = new Dictionary<string, string>();
        readonly Dictionary<string, string> existing = new Dictionary<string, string>();
        readonly Dictionary<string, string[]> words = new Dictionary<string, string[]> {
            {"title", new[]{"Codlet 安装器", "Codlet Installer"}},
            {"close", new[]{"关闭安装器", "Close installer"}}, {"version", new[]{"版本", "Version"}},
            {"expandPlugins", new[]{"展开官方插件选项", "Expand official plugin options"}},
            {"collapsePlugins", new[]{"收起官方插件选项", "Collapse official plugin options"}},
            {"scope", new[]{"安装范围", "Install for"}}, {"admin", new[]{"需要管理员权限", "Administrator permission required"}},
            {"user", new[]{"仅当前用户", "Just me"}}, {"machine", new[]{"所有用户（全局）", "Everyone on this computer"}},
            {"location", new[]{"安装位置", "Installation folder"}}, {"browse", new[]{"浏览…", "Browse…"}},
            {"menu", new[]{"添加到开始菜单", "Add to Start menu"}}, {"desktop", new[]{"创建桌面快捷方式", "Create a desktop shortcut"}},
            {"path", new[]{"将 codlet 加入 PATH", "Add codlet to PATH"}}, {"plugins", new[]{"官方插件", "Official plugins"}},
            {"gui", new[]{"Codlet 管理界面", "Codlet GUI"}}, {"ui", new[]{"Codex 界面适配器", "Codex UI Adapter"}},
            {"adapter", new[]{"Codex 桌面适配器", "Codex Desktop Adapter"}}, {"download", new[]{"首次启动时下载所选插件", "Download selected plugins on first launch"}},
            {"cancel", new[]{"取消", "Cancel"}}, {"install", new[]{"安装", "Install"}}, {"logs", new[]{"查看安装日志 ↗", "View installation log ↗"}},
            {"launch", new[]{"启动 Codlet", "Launch Codlet"}}, {"back", new[]{"返回", "Back"}}, {"done", new[]{"完成", "Done"}},
            {"selected", new[]{"已选择 {0} 项", "{0} selected"}}, {"none", new[]{"暂不安装", "None selected"}},
            {"invalid", new[]{"请选择一个完整的应用文件夹路径。", "Choose a full application folder path."}},
            {"switch", new[]{"已存在另一安装范围的 Codlet。切换范围前，请先卸载旧版本；插件和配置会保留。", "Codlet is installed in the other scope. Uninstall it before switching scope; plugins and settings are retained."}},
            {"running", new[]{"请先关闭 Codex", "Close Codex to continue"}},
            {"save", new[]{"保存当前任务后，请关闭下列应用以继续安装。", "Save your work, then close these applications to continue."}},
            {"closeContinue", new[]{"关闭并继续", "Close and continue"}}, {"recheck", new[]{"重新检查", "Check again"}},
            {"waiting", new[]{"正在等待应用正常退出…", "Waiting for applications to close…"}},
            {"manual", new[]{"应用仍在运行。请手动退出后重新检查。", "Some applications are still running. Close them manually and check again."}},
            {"installing", new[]{"正在安装 Codlet", "Installing Codlet"}}, {"prepare", new[]{"正在准备安装", "Preparing installation"}},
            {"files", new[]{"正在写入程序文件", "Installing application files"}}, {"shortcuts", new[]{"正在设置快捷方式", "Creating shortcuts"}},
            {"environment", new[]{"正在更新环境变量", "Updating PATH"}}, {"register", new[]{"正在完成安装", "Completing installation"}},
            {"cancelling", new[]{"正在取消并回滚，请稍候…", "Cancelling and rolling back. Please wait…"}},
            {"ready", new[]{"准备好了", "You're all set"}}, {"installed", new[]{"Codlet 已安装。新打开的终端可使用 codlet 命令。", "Codlet is installed. Open a new terminal to use the codlet command."}},
            {"installedNoPath", new[]{"Codlet 已安装。", "Codlet is installed."}},
            {"restart", new[]{"安装已完成。请重启 Windows 以完成更新。", "Installation completed. Restart Windows to finish the update."}},
            {"cancelled", new[]{"安装已取消", "Installation cancelled"}}, {"failed", new[]{"安装未完成", "Installation did not complete"}},
            {"failedDetail", new[]{"错误代码 {0}。请查看安装日志后重试。", "Error {0}. Check the installation log before retrying."}},
            {"preview", new[]{"这是界面预览，没有执行安装。", "This is a preview; no installation was performed."}}
        };
        string scope = "user", phase = "setup", logPath;
        bool syncing, closed, gateBusy, cancelPending; MsiSession session;
        List<RunningApplication> running = new List<RunningApplication>();
        public SetupWindow(bool isPreview, bool english) {
            preview = isPreview; chinese = !english && UsesChinese(CultureInfo.CurrentUICulture);
            using (var source = Assembly.GetExecutingAssembly().GetManifestResourceStream("Codlet.Setup.xaml")) Window = (Window)XamlReader.Load(source);
            Window.MaxHeight = Math.Max(540, SystemParameters.WorkArea.Height - 40);
            ApplyTheme(IsDark()); Translate(Window);
            Window.Title = T("title");
            Control<TextBlock>("VersionLabel").Text = SetupBuild.Version;
            System.Windows.Automation.AutomationProperties.SetName(Control<Button>("CloseButton"), T("close"));
            System.Windows.Automation.AutomationProperties.SetName(Control<TextBox>("InstallPath"), T("location"));
            System.Windows.Automation.AutomationProperties.SetName(Control<TextBlock>("VersionLabel"), T("version") + " " + SetupBuild.Version);
            System.Windows.Automation.AutomationProperties.SetHelpText(Control<Button>("PluginsButton"), T("expandPlugins"));
            folders["user"] = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Codlet Preview");
            folders["machine"] = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Codlet Preview");
            if (!preview) {
                ReadExisting("user", RegistryHive.CurrentUser); ReadExisting("machine", RegistryHive.LocalMachine);
                if (!existing.ContainsKey("user") && existing.ContainsKey("machine")) scope = "machine";
            }
            syncing = true; Control<RadioButton>(scope == "user" ? "UserScope" : "MachineScope").IsChecked = true; syncing = false;
            Control<TextBox>("InstallPath").Text = folders[scope];
            if (!preview) ReadChoices();
            Control<Button>("CloseButton").Click += delegate { CloseOrCancel(); };
            Control<Button>("SecondaryButton").Click += delegate { Secondary(); };
            Control<Button>("PrimaryButton").Click += async delegate { await Primary(); };
            Control<RadioButton>("UserScope").Checked += delegate { ChangeScope("user"); };
            Control<RadioButton>("MachineScope").Checked += delegate { ChangeScope("machine"); };
            Control<TextBox>("InstallPath").TextChanged += delegate { if (!syncing) Validate(); };
            Control<TextBox>("InstallPath").LostKeyboardFocus += delegate { NormalizeDisplayedPath(); };
            Control<Button>("BrowseButton").Click += delegate {
                try {
                    string selected = FolderPicker.Select(new WindowInteropHelper(Window).Handle, Control<TextBox>("InstallPath").Text, T("location"));
                    if (selected != null) Control<TextBox>("InstallPath").Text = selected;
                } catch (Exception error) { Notice(error.Message); }
            };
            Control<Button>("PluginsButton").Click += delegate {
                SetPluginsExpanded(Control<StackPanel>("PluginChoices").Visibility != Visibility.Visible);
            };
            foreach (string name in new[]{"GuiChoice", "UiChoice", "DesktopAdapterChoice"}) {
                var box = Control<CheckBox>(name);
                box.Checked += delegate { SyncPlugins(box); }; box.Unchecked += delegate { SyncPlugins(box); };
            }
            Control<Button>("LogButton").Click += delegate { if (File.Exists(logPath)) Process.Start(new ProcessStartInfo(logPath) { UseShellExecute = true }); };
            Window.Closing += delegate(object sender, System.ComponentModel.CancelEventArgs args) {
                if (phase == "installing") { args.Cancel = true; CloseOrCancel(); } else closed = true;
            };
            SyncPlugins(null); Validate();
        }
        TControl Control<TControl>(string name) where TControl : FrameworkElement { return (TControl)Window.FindName(name); }
        internal static bool UsesChinese(CultureInfo culture) { return String.Equals(culture.TwoLetterISOLanguageName, "zh", StringComparison.OrdinalIgnoreCase); }
        string T(string key) { return words[key][chinese ? 0 : 1]; }
        void SetPluginsExpanded(bool expanded) {
            Control<StackPanel>("PluginChoices").Visibility = expanded ? Visibility.Visible : Visibility.Collapsed;
            ((RotateTransform)Control<System.Windows.Shapes.Path>("PluginChevron").RenderTransform).Angle = expanded ? 180 : 0;
            System.Windows.Automation.AutomationProperties.SetHelpText(Control<Button>("PluginsButton"), T(expanded ? "collapsePlugins" : "expandPlugins"));
            Window.Height = Math.Min(Window.MaxHeight, expanded ? 722 : 620);
        }
        void Translate(DependencyObject root) {
            var element = root as FrameworkElement;
            string tag = element == null ? null : element.Tag as string;
            if (tag != null && tag.StartsWith("t:", StringComparison.Ordinal)) {
                string value = T(tag.Substring(2)); var text = element as TextBlock; var content = element as ContentControl;
                if (text != null) text.Text = value; else if (content != null) content.Content = value;
            }
            foreach (object child in LogicalTreeHelper.GetChildren(root)) { var visual = child as DependencyObject; if (visual != null) Translate(visual); }
        }
        static bool IsDark() {
            using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")) return key != null && Convert.ToInt32(key.GetValue("AppsUseLightTheme", 1)) == 0;
        }
        void ApplyTheme(bool dark) {
            string[] names = {"Paper", "Ink", "Muted", "Line", "Soft", "Contrast"};
            string[] colors = dark ? new[]{"#242424", "#F2F2F2", "#B2B2B2", "#3B3B3B", "#303030", "#202020"} : new[]{"#FFFFFF", "#202020", "#707070", "#E6E6E6", "#F5F5F5", "#FFFFFF"};
            for (int i = 0; i < names.Length; i++) Window.Resources[names[i]] = new SolidColorBrush((Color)ColorConverter.ConvertFromString(colors[i]));
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(dark ? "Codlet.Logo.White" : "Codlet.Logo.Black")) {
                var bitmap = new BitmapImage(); bitmap.BeginInit(); bitmap.CacheOption = BitmapCacheOption.OnLoad; bitmap.StreamSource = stream; bitmap.EndInit(); bitmap.Freeze();
                Control<Image>("BrandIcon").Source = bitmap;
            }
        }
        void ReadExisting(string context, RegistryHive hive) {
            using (var root = RegistryKey.OpenBaseKey(hive, RegistryView.Registry64))
            using (var key = root.OpenSubKey(@"Software\Codlet\Preview\Installer")) {
                string folder = key == null ? null : key.GetValue("InstallFolder") as string;
                if (!String.IsNullOrEmpty(folder) && File.Exists(Path.Combine(folder, "codlet.exe"))) { folders[context] = folder; existing[context] = folder; }
            }
        }
        void ReadChoices() {
            if (!existing.ContainsKey(scope)) return;
            using (var root = RegistryKey.OpenBaseKey(scope == "user" ? RegistryHive.CurrentUser : RegistryHive.LocalMachine, RegistryView.Registry64))
            using (var key = root.OpenSubKey(@"Software\Codlet\Preview\Installer"))
            using (var plugins = key == null ? null : key.OpenSubKey("Plugins")) {
                if (key == null) return;
                Control<CheckBox>("StartMenuChoice").IsChecked = key.GetValue("Shortcuts") != null;
                Control<CheckBox>("DesktopChoice").IsChecked = key.GetValue("DesktopShortcut") != null;
                foreach (var pair in new[]{new[]{"GuiChoice", "codlet-gui"}, new[]{"UiChoice", "codex.ui.adapter"}, new[]{"DesktopAdapterChoice", "codex.desktop.adapter"}})
                    Control<CheckBox>(pair[0]).IsChecked = plugins != null && Convert.ToInt32(plugins.GetValue(pair[1], 0)) == 1;
            }
        }
        void ChangeScope(string next) {
            if (syncing || scope == next) return;
            folders[scope] = Control<TextBox>("InstallPath").Text;
            scope = next; Control<TextBox>("InstallPath").Text = folders[scope]; Validate();
        }
        void NormalizeDisplayedPath() {
            try { Control<TextBox>("InstallPath").Text = NormalizePath(Control<TextBox>("InstallPath").Text); } catch { }
        }
        internal static string NormalizePath(string value) {
            value = Environment.ExpandEnvironmentVariables(value.Trim());
            if (value.Length < 4 || value.IndexOfAny(new[]{'"', '\r', '\n', '\0', '%', '[', ']'}) >= 0 || !Path.IsPathRooted(value) || (value.Length > 1 && value[1] == ':' && (value.Length < 3 || value[2] != '\\'))) throw new ArgumentException("Invalid installation directory");
            string result = Path.GetFullPath(value).TrimEnd('\\');
            if (result.Length <= Path.GetPathRoot(result).TrimEnd('\\').Length) throw new ArgumentException("A drive root is not an application directory");
            foreach (var folder in new[]{Environment.SpecialFolder.Windows, Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.UserProfile, Environment.SpecialFolder.LocalApplicationData})
                if (String.Equals(result, Environment.GetFolderPath(folder).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Select an application subdirectory");
            return result;
        }
        void Notice(string value) { var label = Control<TextBlock>("ValidationNote"); label.Text = value; label.Visibility = String.IsNullOrEmpty(value) ? Visibility.Collapsed : Visibility.Visible; }
        bool Validate() {
            bool valid = true; string message = "";
            try { NormalizePath(Control<TextBox>("InstallPath").Text); } catch { valid = false; message = T("invalid"); }
            if (existing.ContainsKey(scope == "user" ? "machine" : "user")) { valid = false; message = T("switch"); }
            Notice(message); Control<TextBlock>("AdminNote").Visibility = scope == "machine" ? Visibility.Visible : Visibility.Collapsed;
            if (phase == "setup") Control<Button>("PrimaryButton").IsEnabled = valid;
            return valid;
        }
        bool Checked(string name) { return Control<CheckBox>(name).IsChecked == true; }
        void SyncPlugins(CheckBox changed) {
            if (syncing) return; syncing = true;
            if (changed == Control<CheckBox>("UiChoice") && !Checked("UiChoice")) Control<CheckBox>("GuiChoice").IsChecked = false;
            if (Checked("GuiChoice")) Control<CheckBox>("UiChoice").IsChecked = true;
            int count = new[]{"GuiChoice", "UiChoice", "DesktopAdapterChoice"}.Count(Checked);
            Control<TextBlock>("PluginCount").Text = count == 0 ? T("none") : String.Format(T("selected"), count);
            syncing = false;
        }
        internal static string Properties(string scope, string folder, IEnumerable<string> selected) {
            string[] allowed = {"Core", "StartMenu", "DesktopShortcut", "CliPath", "GUI", "UiAdapter", "DesktopAdapter"};
            var choices = new HashSet<string>(selected);
            if ((scope != "user" && scope != "machine") || !choices.Contains("Core") || choices.Any(x => !allowed.Contains(x)) || (choices.Contains("GUI") && !choices.Contains("UiAdapter"))) throw new ArgumentException("Invalid install selection");
            folder = NormalizePath(folder);
            string remove = String.Join(",", allowed.Where(x => !choices.Contains(x)));
            return "ALLUSERS=2 MSIINSTALLPERUSER=" + (scope == "user" ? "1" : "\"\"") + " REBOOT=ReallySuppress INSTALLFOLDER=\"" + folder + "\" ADDLOCAL=" + String.Join(",", allowed.Where(choices.Contains)) + (remove.Length == 0 ? "" : " REMOVE=" + remove);
        }
        string SelectedProperties() {
            var features = new List<string> {"Core"};
            foreach (var pair in new[]{new[]{"StartMenuChoice", "StartMenu"}, new[]{"DesktopChoice", "DesktopShortcut"}, new[]{"PathChoice", "CliPath"}, new[]{"GuiChoice", "GUI"}, new[]{"UiChoice", "UiAdapter"}, new[]{"DesktopAdapterChoice", "DesktopAdapter"}}) if (Checked(pair[0])) features.Add(pair[1]);
            return Properties(scope, folders[scope], features);
        }
        void Status(string name, string heading, string message, string primary) {
            phase = name; Control<StackPanel>("SetupView").Visibility = Visibility.Collapsed; Control<StackPanel>("StatusView").Visibility = Visibility.Visible;
            Control<TextBlock>("StatusHeading").Text = heading; Control<TextBlock>("StatusText").Text = message;
            Control<Button>("PrimaryButton").Content = primary; Control<Button>("PrimaryButton").IsEnabled = true;
            foreach (string control in new[]{"ProcessList", "Progress", "LogButton", "LaunchChoice"}) Window.FindName(control).As<FrameworkElement>().Visibility = Visibility.Collapsed;
            Control<TextBlock>("ProgressText").Text = "";
        }
        void RestoreSetup() {
            phase = "setup"; Control<StackPanel>("SetupView").Visibility = Visibility.Visible; Control<StackPanel>("StatusView").Visibility = Visibility.Collapsed;
            Control<Button>("PrimaryButton").Content = T("install"); Control<Button>("SecondaryButton").Content = T("cancel");
            Control<Button>("PrimaryButton").Visibility = Visibility.Visible; Control<Button>("SecondaryButton").Visibility = Visibility.Visible; Validate();
        }
        async Task Primary() {
            if (phase == "done") {
                if (Checked("LaunchChoice") && !preview) {
                    try { StartInstalledClient(); } catch (Exception error) { Control<TextBlock>("StatusText").Text = error.Message; return; }
                }
                Window.Close(); return;
            }
            if (phase == "failed" || phase == "cancelled") { RestoreSetup(); return; }
            if (phase == "gate") { await CloseApplications(); return; }
            if (phase != "setup" || !Validate()) return;
            NormalizeDisplayedPath(); folders[scope] = Control<TextBox>("InstallPath").Text;
            if (!preview && !await CheckApplications()) return;
            await Install();
        }
        async Task<bool> CheckApplications() {
            running = await Task.Run(() => ProcessGate.Find(folders[scope], true));
            if (closed) return false;
            if (running.Count == 0) return true;
            Status("gate", T("running"), T("save"), T("closeContinue"));
            Control<TextBox>("ProcessList").Text = String.Join(Environment.NewLine, running.Select(x => x.Name + "  ·  PID " + x.Id));
            Control<TextBox>("ProcessList").Visibility = Visibility.Visible;
            Control<Button>("SecondaryButton").Content = T("recheck"); return false;
        }
        async Task CloseApplications() {
            if (gateBusy) return; gateBusy = true; Control<Button>("PrimaryButton").IsEnabled = false;
            foreach (var process in running) ProcessGate.RequestClose(process);
            Control<TextBlock>("StatusText").Text = T("waiting");
            for (int attempt = 0; attempt < 24 && !closed; attempt++) {
                await Task.Delay(500); running = await Task.Run(() => ProcessGate.Find(folders[scope], true));
                if (!closed && running.Count == 0) { gateBusy = false; await Install(); return; }
            }
            gateBusy = false; if (!closed) { Control<Button>("PrimaryButton").IsEnabled = true; Control<TextBlock>("StatusText").Text = T("manual"); }
        }
        async void Secondary() {
            if (phase == "gate") { if (gateBusy) return; if (await CheckApplications()) await Install(); }
            else CloseOrCancel();
        }
        void CloseOrCancel() {
            if (phase == "installing") {
                cancelPending = true;
                if (session != null) session.CancelRequested = true;
                Control<TextBlock>("StatusText").Text = T("cancelling"); Control<Button>("SecondaryButton").IsEnabled = false;
            } else Window.Close();
        }
        void StartInstalledClient() {
            string executable = Path.Combine(folders[scope], "Codlet-Launcher.exe");
            var info = new ProcessStartInfo(executable) { UseShellExecute = false, WorkingDirectory = folders[scope] };
            // The MSI transaction may have changed PATH since this process started.
            info.EnvironmentVariables["PATH"] = Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.Machine) + ";" + Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.User);
            // Never carry the developer's package identity or runtime selectors
            // into the newly installed launcher's first launch.
            foreach (string key in info.EnvironmentVariables.Keys.Cast<string>().Where(key => key.StartsWith("CODLET_", StringComparison.OrdinalIgnoreCase)).ToArray()) info.EnvironmentVariables.Remove(key);
            foreach (string key in new[]{"ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"}) info.EnvironmentVariables.Remove(key);
            Process.Start(info);
        }
        static string ExtractPayload(string directory) {
            string file = Path.Combine(directory, "Codlet.msi");
            using (var input = Assembly.GetExecutingAssembly().GetManifestResourceStream("Codlet.Payload.msi"))
            using (var output = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None)) input.CopyTo(output);
            using (var sha = SHA256.Create()) using (var input = File.OpenRead(file)) {
                string actual = BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
                if (actual != SetupBuild.PayloadHash) throw new InvalidDataException("Installer payload checksum mismatch");
            }
            return file;
        }
        async Task Install() {
            cancelPending = false;
            string properties = SelectedProperties();
            Status("installing", T("installing"), T("prepare"), T("install"));
            Control<ProgressBar>("Progress").Visibility = Visibility.Visible; Control<ProgressBar>("Progress").IsIndeterminate = true;
            Control<Button>("PrimaryButton").Visibility = Visibility.Collapsed; Control<Button>("SecondaryButton").Content = T("cancel");
            if (preview) { await Task.Delay(500); Complete(0, null); return; }
            string directory = null; uint result = 1603; string failure = null;
            try {
                directory = Path.Combine(Path.GetTempPath(), "Codlet-Setup-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory);
                string payload = await Task.Run(() => ExtractPayload(directory));
                string logs = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Codlet", "installer-logs"); Directory.CreateDirectory(logs);
                logPath = Path.Combine(logs, DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff") + ".log");
                DateTime last = DateTime.MinValue;
                session = new MsiSession((value, action) => {
                    if (DateTime.UtcNow - last < TimeSpan.FromMilliseconds(80)) return; last = DateTime.UtcNow;
                    Window.Dispatcher.BeginInvoke(new Action(() => {
                        if (phase != "installing") return;
                        var progress = Control<ProgressBar>("Progress"); progress.IsIndeterminate = value < 0; if (value >= 0) progress.Value = value;
                        string key = action == "InstallFiles" ? "files" : action == "CreateShortcuts" ? "shortcuts" : action == "WriteEnvironmentStrings" ? "environment" : action == "InstallFinalize" ? "register" : "prepare";
                        Control<TextBlock>("ProgressText").Text = T(key);
                    }));
                });
                session.CancelRequested = cancelPending;
                IntPtr owner = new WindowInteropHelper(Window).Handle;
                result = await Task.Run(() => session.Run(payload, properties, logPath, owner)); failure = session.LastError;
            } catch (Exception error) { failure = error.Message; }
            finally {
                // Delete only our two known files and empty, uniquely owned folder.
                if (directory != null) try { File.Delete(Path.Combine(directory, "Codlet.msi")); Directory.Delete(directory, false); } catch (IOException) { } catch (UnauthorizedAccessException) { }
                session = null;
            }
            Complete(result, failure);
        }
        void Complete(uint result, string detail) {
            Control<Button>("PrimaryButton").Visibility = Visibility.Visible; Control<Button>("SecondaryButton").IsEnabled = true;
            if (result == 0 || result == 3010) {
                Status("done", T("ready"), preview ? T("preview") : result == 3010 ? T("restart") : Checked("PathChoice") ? T("installed") : T("installedNoPath"), T("done"));
                Control<CheckBox>("LaunchChoice").Visibility = Visibility.Visible; Control<CheckBox>("LaunchChoice").IsChecked = result != 3010;
                Control<Button>("SecondaryButton").Visibility = Visibility.Collapsed;
            } else {
                Status(result == 1602 ? "cancelled" : "failed", T(result == 1602 ? "cancelled" : "failed"), String.Format(T("failedDetail"), result) + (String.IsNullOrEmpty(detail) ? "" : Environment.NewLine + detail), T("back"));
                Control<Button>("LogButton").Visibility = File.Exists(logPath) ? Visibility.Visible : Visibility.Collapsed;
            }
        }
        void Capture(string path) {
            var view = (FrameworkElement)Window.Content;
            // Render the actual view detached from an unshown HWND: Window's
            // zero-sized presentation source would otherwise clip the bitmap.
            var resources = view.Resources; Window.Content = null; view.Resources = Window.Resources;
            try {
                System.Windows.Documents.TextElement.SetFontFamily(view, Window.FontFamily);
                System.Windows.Documents.TextElement.SetFontSize(view, Window.FontSize);
                System.Windows.Documents.TextElement.SetForeground(view, Window.Foreground);
                view.Width = Window.Width; view.Height = Window.Height;
                view.Measure(new Size(Window.Width, Window.Height)); view.Arrange(new Rect(0, 0, Window.Width, Window.Height)); view.UpdateLayout();
                var image = new RenderTargetBitmap((int)Window.Width, (int)Window.Height, 96, 96, PixelFormats.Pbgra32); image.Render(view);
                var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(image)); using (var file = File.Create(path)) encoder.Save(file);
            } finally { view.Resources = resources; Window.Content = view; }
        }
        public void Verify(string output) {
            if (!preview) throw new InvalidOperationException("Verification cannot install software");
            Directory.CreateDirectory(output); MsiSession.CheckProgressContract();
            string plan = Properties("machine", Path.Combine(Path.GetTempPath(), "Codlet Fixture"), new[]{"Core", "CliPath", "GUI", "UiAdapter"});
            if (!plan.Contains("ALLUSERS=2 MSIINSTALLPERUSER=\"\"") || !plan.Contains(" REMOVE=StartMenu,DesktopShortcut,DesktopAdapter")) throw new Exception("Scope/feature selection failed");
            if (!Properties("user", folders["user"], new[]{"Core"}).Contains("MSIINSTALLPERUSER=1")) throw new Exception("Per-user scope failed");
            bool rejected = false; try { NormalizePath("C:\\"); } catch (ArgumentException) { rejected = true; }
            if (!rejected) throw new Exception("Drive root accepted");
            string normalized = NormalizePath(@"%LOCALAPPDATA%\Programs\Codlet Preview");
            if (normalized.Contains("%")) throw new Exception("Environment variable not expanded");
            ApplyTheme(false); Capture(Path.Combine(output, "installer-light.png"));
            Control<RadioButton>("MachineScope").IsChecked = true;
            if (Control<TextBox>("InstallPath").Text != folders["machine"]) throw new Exception("Scope did not change path");
            Capture(Path.Combine(output, "installer-machine.png"));
            ApplyTheme(true); SetPluginsExpanded(true);
            Capture(Path.Combine(output, "installer-dark.png"));
            var payload = ExtractPayload(output); File.Delete(payload);
            File.WriteAllText(Path.Combine(output, "report.json"), "{\"passed\":true,\"installationPerformed\":false,\"nativeUi\":true,\"payloadHashVerified\":true,\"scopeAndFeatures\":true,\"msiProgressAndCancellation\":true,\"version\":\"" + SetupBuild.Version + "\"}", new UTF8Encoding(false));
            Window.Close();
        }
    }
    static class SetupExtensions { public static T As<T>(this object value) { return (T)value; } }
}
