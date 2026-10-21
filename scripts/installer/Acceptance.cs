using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Management;
using System.Text;
using System.Web.Script.Serialization;
using Codlet.Setup;

// A disposable-VM driver for the production MSI session. It has no installation
// mode on the ordinary desktop host. The inspect command is read-only.
class InstallerAcceptance {
    static void Save(string path, object value) {
        File.WriteAllText(path, new JavaScriptSerializer().Serialize(value), new UTF8Encoding(false));
    }
    static int Main(string[] args) {
        try {
            if (args.Length == 2 && args[0] == "inspect") {
                Save(Path.GetFullPath(args[1]), InstalledProducts.Read()); return 0;
            }
            if (args.Length != 2 || args[0] != "run") return 87;
            using (var query = new ManagementObjectSearcher("SELECT Model FROM Win32_ComputerSystem")) {
                if (!query.Get().Cast<ManagementObject>().Any(item => (string)item["Model"] == "CodletNativeAcceptanceVM")) throw new InvalidOperationException("Disposable VM required");
            }
            var plan = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.GetFullPath(args[1])));
            if (plan.Keys.Any(key => key != "package" && key != "properties" && key != "output" && key != "cancelAction")) throw new InvalidDataException("Unexpected acceptance plan field");
            string package = Path.GetFullPath((string)plan["package"]), properties = (string)plan["properties"], output = Path.GetFullPath((string)plan["output"]);
            if (!package.StartsWith(@"C:\CodletLab\", StringComparison.OrdinalIgnoreCase) || !output.StartsWith(@"C:\CodletLab\", StringComparison.OrdinalIgnoreCase) || Directory.Exists(output)) throw new InvalidOperationException("Fresh owned VM paths required");
            Directory.CreateDirectory(output);
            string cancelAction = plan.ContainsKey("cancelAction") ? (string)plan["cancelAction"] : null;
            uint result; bool cancelled = false;
            using (var timing = new InstallTiming(Path.Combine(output, "timing.jsonl"))) {
                MsiSession session = null;
                session = new MsiSession((progress, action) => {
                    if (!cancelled && cancelAction != null && action == cancelAction) {
                        cancelled = true; session.CancelRequested = true; timing.Write("request", "cancel", null);
                    }
                }, timing.Write);
                result = session.Run(package, properties, Path.Combine(output, "msi.log"), IntPtr.Zero);
                timing.Write("end", "setup", result);
                Save(Path.Combine(output, "result.json"), new { exitCode=result, cancelRequested=cancelled, error=session.LastError, installed=InstalledProducts.Read() });
            }
            return result == 0 || result == 3010 ? 0 : (int)result;
        } catch (Exception error) { Console.Error.WriteLine(error.ToString()); return 1; }
    }
}
