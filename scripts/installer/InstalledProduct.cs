using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

namespace Codlet.Setup {
    enum InstallRelation { Fresh, Upgrade, Maintenance, Downgrade }

    sealed class InstalledProduct {
        public string ProductCode, Version, MsiVersion, Scope, Folder;
        public readonly Dictionary<string, bool> Features = new Dictionary<string, bool>(StringComparer.Ordinal);
        public InstallRelation RelationTo(string targetMsiVersion) {
            int comparison = System.Version.Parse(MsiVersion).CompareTo(System.Version.Parse(targetMsiVersion));
            return comparison < 0 ? InstallRelation.Upgrade : comparison == 0 ? InstallRelation.Maintenance : InstallRelation.Downgrade;
        }
    }

    static class InstalledProducts {
        internal const string UpgradeCode = "{941C0F18-D41F-46E9-A3D1-A9562D75BF76}";
        internal static readonly string[] FeatureNames = { "Core", "StartMenu", "DesktopShortcut", "CliPath", "GUI" };
        [DllImport("msi.dll", CharSet=CharSet.Unicode)] static extern uint MsiEnumRelatedProducts(string upgrade, uint reserved, uint index, StringBuilder product);
        [DllImport("msi.dll", CharSet=CharSet.Unicode)] static extern uint MsiGetProductInfoEx(string product, string sid, uint context, string property, StringBuilder value, ref uint length);
        [DllImport("msi.dll", CharSet=CharSet.Unicode)] static extern uint MsiQueryFeatureStateEx(string product, string sid, uint context, string feature, out int state);

        static string Info(string product, uint context, string property) {
            uint length = 1024; var value = new StringBuilder((int)length);
            uint result = MsiGetProductInfoEx(product, null, context, property, value, ref length);
            if (result == 234 && length < 32768) {
                length++; value = new StringBuilder((int)length);
                result = MsiGetProductInfoEx(product, null, context, property, value, ref length);
            }
            if (result == 1605 || result == 1608) return null;
            if (result != 0) throw new InvalidOperationException("Windows Installer product query failed: " + result);
            return value.ToString();
        }

        static string RegisteredFolder(string scope) {
            using (var root = RegistryKey.OpenBaseKey(scope == "machine" ? RegistryHive.LocalMachine : RegistryHive.CurrentUser, RegistryView.Registry64))
            using (var key = root.OpenSubKey(@"Software\Codlet\Preview\Installer"))
                return key == null ? null : key.GetValue("InstallFolder") as string;
        }

        public static List<InstalledProduct> Read() {
            var products = new List<InstalledProduct>();
            for (uint index = 0; index < 256; index++) {
                var code = new StringBuilder(39);
                uint result = MsiEnumRelatedProducts(UpgradeCode, 0, index, code);
                if (result == 259) return products;
                if (result != 0) throw new InvalidOperationException("Windows Installer enumeration failed: " + result);
                foreach (uint context in new uint[] { 4, 2, 1 }) {
                    string state = Info(code.ToString(), context, "State");
                    if (state != "5") continue;
                    string version = Info(code.ToString(), context, "VersionString");
                    System.Version parsed;
                    if (!System.Version.TryParse(version, out parsed)) throw new InvalidDataException("Installed MSI version is invalid");
                    string name = Info(code.ToString(), context, "InstalledProductName") ?? "";
                    string scope = context == 4 ? "machine" : "user";
                    string folder = Info(code.ToString(), context, "InstallLocation");
                    if (String.IsNullOrWhiteSpace(folder)) folder = RegisteredFolder(scope);
                    // MSI registration remains authoritative even when an executable is missing.
                    if (String.IsNullOrWhiteSpace(folder) || !Path.IsPathRooted(folder)) throw new InvalidDataException("Installed Codlet directory is unavailable");
                    var product = new InstalledProduct {
                        ProductCode = code.ToString(), MsiVersion = version, Scope = scope,
                        Version = name.StartsWith("Codlet ", StringComparison.Ordinal) ? name.Substring(7) : version,
                        Folder = Path.GetFullPath(folder).TrimEnd('\\')
                    };
                    foreach (string feature in FeatureNames) {
                        int installed; uint queried = MsiQueryFeatureStateEx(product.ProductCode, null, context, feature, out installed);
                        if (queried == 1606) continue;
                        if (queried != 0) throw new InvalidOperationException("Windows Installer feature query failed: " + queried);
                        product.Features[feature] = installed == 3 || installed == 4;
                    }
                    products.Add(product);
                }
            }
            throw new InvalidDataException("Too many related Codlet products");
        }
    }
}
