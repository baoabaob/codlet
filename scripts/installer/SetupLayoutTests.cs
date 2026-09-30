using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;
using System.Windows.Threading;

// Exercise the actual HWND layout, which bitmap-only rendering cannot cover.
// The preview window stays transparent, off-screen and never activates.
class SetupLayoutTests {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
    [STAThread] static int Main(string[] args) {
        if (args.Length != 3) return 87;
        string output = Path.GetFullPath(args[1]); Directory.CreateDirectory(output);
        var app = new Application(); Window window = null;
        var observations = new List<object>(); bool failed = false;
        Action<Exception> failure = error => {
            failed = true; File.WriteAllText(Path.Combine(output, "layout-failure.txt"), error.ToString());
            if (window != null) window.Close(); app.Shutdown(1);
        };
        app.DispatcherUnhandledException += delegate(object sender, DispatcherUnhandledExceptionEventArgs e) { e.Handled = true; failure(e.Exception); };
        try {
            Thread.CurrentThread.CurrentUICulture = CultureInfo.GetCultureInfo(args[2]);
            var assembly = Assembly.LoadFrom(Path.GetFullPath(args[0]));
            var type = assembly.GetType("Codlet.Setup.SetupWindow", true);
            var instance = Activator.CreateInstance(type, new object[] { true, false });
            window = (Window)type.GetField("Window").GetValue(instance);
            window.WindowStartupLocation = WindowStartupLocation.Manual;
            window.Left = SystemParameters.VirtualScreenLeft + SystemParameters.VirtualScreenWidth + 100;
            window.Top = SystemParameters.VirtualScreenTop + 100;
            window.ShowActivated = false; window.ShowInTaskbar = false; window.Opacity = 0;
            var viewer = (ScrollViewer)window.FindName("BodyScroll");
            var toggle = (Button)window.FindName("PluginsButton");
            Action<string, bool> record = (name, overflow) => {
                window.UpdateLayout();
                var bar = (ScrollBar)viewer.Template.FindName("PART_VerticalScrollBar", viewer);
                Assert(bar != null, "Missing overflow scrollbar");
                Assert(!viewer.Focusable && !viewer.IsTabStop, "Scroll container must not capture keyboard focus");
                Assert(toggle.Focusable && toggle.IsTabStop && toggle.FocusVisualStyle != null, "Plugin options must retain keyboard navigation and a focus indicator");
                Assert((viewer.ScrollableHeight > 0) == overflow, name + ": unexpected content overflow");
                Assert((bar.Visibility == Visibility.Visible) == overflow, name + ": scrollbar must follow real overflow");
                Assert(window.Title == (args[2].StartsWith("zh", StringComparison.OrdinalIgnoreCase) ? "Codlet 安装器" : "Codlet Installer"), "Wrong automatic UI language");
                Assert(((TextBlock)window.FindName("InstallerTitle")).Text == window.Title, "Window and visible title disagree");
                var version = (TextBlock)window.FindName("VersionLabel");
                var primary = (Button)window.FindName("PrimaryButton");
                Point versionPosition = version.TranslatePoint(new Point(), window);
                Point primaryPosition = primary.TranslatePoint(new Point(), window);
                Assert(versionPosition.Y > window.ActualHeight - 90 && versionPosition.X < primaryPosition.X, "Version must stay in the lower-left footer");
                uint foregroundProcess; GetWindowThreadProcessId(GetForegroundWindow(), out foregroundProcess);
                Assert(foregroundProcess != Process.GetCurrentProcess().Id, "Layout test must not take foreground focus");
                observations.Add(new { name, viewport = viewer.ViewportHeight, extent = viewer.ExtentHeight, scrollable = viewer.ScrollableHeight, scrollbar = bar.Visibility.ToString() });
            };
            Action<Action> later = action => window.Dispatcher.BeginInvoke(action, DispatcherPriority.ApplicationIdle);
            window.Loaded += delegate {
                later(() => {
                    record("collapsed", false);
                    toggle.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                    later(() => {
                        record("expanded", false);
                        toggle.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                        later(() => {
                            record("collapsed-again", false);
                            toggle.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); window.Height = 540;
                            later(() => {
                                record("short-window", true); viewer.ScrollToBottom();
                                later(() => {
                                    Assert(viewer.VerticalOffset > 0, "Overflow content must remain reachable");
                                    toggle.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                                    later(() => {
                                        record("restored", false);
                                        File.WriteAllText(Path.Combine(output, "layout-report.json"), new JavaScriptSerializer().Serialize(new { passed = true, locale = args[2], installationPerformed = false, observations }));
                                        window.Close();
                                    });
                                });
                            });
                        });
                    });
                });
            };
            app.Run(window); return failed ? 1 : 0;
        } catch (Exception error) { failure(error); return 1; }
    }
}
