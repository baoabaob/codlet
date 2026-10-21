using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;

namespace Codlet.Setup {
    // Adjacent action intervals are observations, not exclusive CPU time. MSI may
    // report nested uninstall actions during RemoveExistingProducts.
    sealed class InstallTiming : IDisposable {
        readonly Stopwatch clock = Stopwatch.StartNew();
        readonly StreamWriter writer;
        readonly object sync = new object();
        public InstallTiming(string path) {
            writer = new StreamWriter(new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read), new UTF8Encoding(false));
            Write("start", "setup", null);
        }
        static string Quote(string value) {
            var text = new StringBuilder("\"");
            foreach (char c in value ?? "") {
                if (c == '"' || c == '\\') text.Append('\\').Append(c);
                else if (c < 32) text.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                else text.Append(c);
            }
            return text.Append('"').ToString();
        }
        public void Write(string kind, string stage, uint? code) {
            lock (sync) {
                try {
                writer.WriteLine("{\"schema\":1,\"event\":" + Quote(kind) + ",\"stage\":" + Quote(stage) + ",\"elapsedMs\":" + clock.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture) + (code.HasValue ? ",\"code\":" + code.Value.ToString(CultureInfo.InvariantCulture) : "") + "}");
                writer.Flush();
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
        public void Dispose() { lock (sync) writer.Dispose(); }
    }
}
