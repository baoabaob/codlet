using System;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace Codlet.Setup {
    static class InstallerPreflight {
        [STAThread]
        static int Main(string[] args) {
            // MSI's Binary EXE action extracts and runs this helper before
            // InstallInitialize. No managed custom-action extraction runtime.
            if (args.Length != 3) return 87;
            try {
                string directory = Path.GetFullPath(args[0]), log = Path.GetFullPath(args[2]);
                int level; if (!Int32.TryParse(args[1], out level)) return 87;
                Action<string> write = message => File.AppendAllText(log, DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine, new UTF8Encoding(false));
                Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
                write("Codlet MSI preflight; install directory=" + directory);
                int result = ProcessGate.Check(directory, level >= 4, true, write);
                write("gate result=" + result);
                return result; // MSI translates a failed EXE custom action to 1603.
            } catch (Exception error) {
                try { File.AppendAllText(args[2], error.ToString(), new UTF8Encoding(false)); } catch { }
                return 1;
            }
        }
    }
}
