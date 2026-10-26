using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;

namespace Codlet.Setup {
    static class ManagedUpgrade {
        public static int Run(string[] args) {
            if (args.Length != 6 || (args[0] != "--validate-upgrade" && args[0] != "--upgrade-existing") || args[2] != "--version" || args[4] != "--receipt") return 87;
            string receipt = Path.GetFullPath(PlainPath(args[5])), directory = null;
            try {
                if (!Path.IsPathRooted(args[1]) || !Path.IsPathRooted(args[5]) || args[3] != SetupBuild.Version || File.Exists(receipt)) throw new InvalidDataException("The managed update identity changed.");
                string root = SetupWindow.NormalizePath(PlainPath(args[1]));
                var matches = InstalledProducts.Read().Where(candidate => String.Equals(candidate.Folder.TrimEnd('\\'), root.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)).ToArray();
                if (matches.Length != 1 || matches[0].RelationTo(SetupBuild.MsiVersion) == InstallRelation.Downgrade) throw new InvalidDataException("The existing MSI installation is missing, ambiguous or newer than this installer.");
                var product = matches[0];
                string[] features = InstalledProducts.FeatureNames.Where(name => name == "Core" || product.Features.ContainsKey(name) && product.Features[name]).ToArray();
                string properties = SetupWindow.Properties(product.Scope, product.Folder, features, product.RelationTo(SetupBuild.MsiVersion) == InstallRelation.Maintenance && product.ProductCode == SetupBuild.ProductCode);
                if (args[0] == "--validate-upgrade") {
                    Save(receipt, new { phase = "ready", version = SetupBuild.Version, installRoot = product.Folder, scope = product.Scope, productCode = product.ProductCode });
                    return 0;
                }
                if (ProcessGate.Find(product.Folder, true).Count != 0) throw new InvalidOperationException("Applications are still using this installation.");
                directory = Path.Combine(Path.GetTempPath(), "Codlet-Setup-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory);
                string payload = SetupWindow.ExtractPayload(directory);
                var session = new MsiSession((progress, action) => {});
                uint result = session.Run(payload, properties, Path.ChangeExtension(receipt, ".msi.log"), IntPtr.Zero);
                if (result != 0 && result != 3010) throw new InvalidOperationException("Windows Installer returned " + result + ": " + session.LastError);
                var installed = InstalledProducts.Read().Where(value => String.Equals(value.Folder.TrimEnd('\\'), root.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase) && value.ProductCode == SetupBuild.ProductCode).ToArray();
                if (installed.Length != 1 || installed[0].MsiVersion != SetupBuild.MsiVersion || installed[0].Scope != product.Scope) throw new InvalidDataException("Windows Installer did not confirm the requested update.");
                Save(receipt, new { phase = result == 3010 ? "restartRequired" : "installed", version = SetupBuild.Version, installRoot = installed[0].Folder, scope = installed[0].Scope, productCode = installed[0].ProductCode });
                return checked((int)result);
            } catch (Exception error) {
                try { if (!File.Exists(receipt)) Save(receipt, new { phase = "failed", version = SetupBuild.Version, error = error.Message }); } catch { }
                return 1;
            } finally {
                if (directory != null) try { File.Delete(Path.Combine(directory, "Codlet.msi")); Directory.Delete(directory, false); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
        static void Save(string path, object value) {
            using (var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
                byte[] bytes = new UTF8Encoding(false).GetBytes(new JavaScriptSerializer().Serialize(value)); file.Write(bytes, 0, bytes.Length); file.Flush(true);
            }
        }
        static string PlainPath(string value) { return value.StartsWith(@"\\?\", StringComparison.Ordinal) ? value.Substring(4) : value; }
    }
}
