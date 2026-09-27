using System;
using System.IO;
using System.Threading;
using System.Windows.Forms;

static class ProcessFixture {
    [STAThread] static void Main(string[] args) {
        if (args.Length >= 1 && args[0] == "launch") {
            string data = Environment.GetEnvironmentVariable("CODLET_HOME");
            string exitFile = Path.Combine(data, "fixture-exit-code");
            if (File.Exists(exitFile)) {
                Console.Error.WriteLine("fixture: Core stopped before readiness");
                Environment.Exit(Int32.Parse(File.ReadAllText(exitFile)));
            }
            for (int i = 0; i < 20; ++i) { Console.WriteLine("detached-output-" + i); Thread.Sleep(100); }
            return;
        }
        using (var form = new Form { Text = "Codlet owned installer test", ShowInTaskbar = false, Opacity = 0.01, StartPosition = FormStartPosition.Manual, Location = new System.Drawing.Point(-30000, -30000) }) {
            if (args.Length != 0 && args[0] == "stubborn") form.FormClosing += delegate(object sender, FormClosingEventArgs e) { e.Cancel = true; };
            var timer = new System.Windows.Forms.Timer { Interval = 30000 };
            timer.Tick += delegate { Environment.Exit(0); }; timer.Start();
            Application.Run(form);
        }
    }
}
