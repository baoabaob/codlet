using System;
using System.Runtime.InteropServices;
using System.Text;

namespace Codlet.Setup {
    // The UI remains unelevated. Windows Installer owns elevation, rollback,
    // registration, environment updates and uninstall in the selected context.
    sealed class MsiSession {
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int Handler(IntPtr context, uint type, uint record);
        [DllImport("msi.dll")] static extern uint MsiSetInternalUI(uint level, ref IntPtr owner);
        [DllImport("msi.dll")] static extern uint MsiSetExternalUIRecord(Handler handler, uint filter, IntPtr context, out IntPtr previous);
        [DllImport("msi.dll", CharSet=CharSet.Unicode)] static extern uint MsiInstallProduct(string package, string properties);
        [DllImport("msi.dll", CharSet=CharSet.Unicode)] static extern uint MsiEnableLog(uint mode, string path, uint attributes);
        [DllImport("msi.dll")] static extern int MsiRecordGetInteger(uint record, uint field);
        [DllImport("msi.dll", CharSet=CharSet.Unicode)] static extern uint MsiRecordGetString(uint record, uint field, StringBuilder value, ref uint length);
        [DllImport("msi.dll", CharSet=CharSet.Unicode)] static extern uint MsiFormatRecord(uint install, uint record, StringBuilder value, ref uint length);
        [DllImport("msi.dll")] static extern uint MsiCreateRecord(uint fields);
        [DllImport("msi.dll")] static extern uint MsiRecordSetInteger(uint record, uint field, int value);
        [DllImport("msi.dll")] static extern uint MsiCloseHandle(uint handle);
        public volatile bool CancelRequested;
        public string LastError;
        readonly Action<double, string> report;
        long total, ticks, actionTicks; bool backwards, actionProgress;
        string action = "prepare";
        Handler handler;
        public MsiSession(Action<double, string> progress) { report = progress; }
        static string Field(uint record, uint index) {
            uint size = 4096; var text = new StringBuilder((int)size + 1);
            uint result = MsiRecordGetString(record, index, text, ref size);
            if (result == 234 && size < 65536) { text = new StringBuilder((int)size + 1); size++; result = MsiRecordGetString(record, index, text, ref size); }
            return result == 0 ? text.ToString() : "";
        }
        static string Message(uint record) {
            uint size = 8192; var text = new StringBuilder((int)size + 1);
            return MsiFormatRecord(0, record, text, ref size) == 0 ? text.ToString() : Field(record, 0);
        }
        int Receive(IntPtr context, uint flags, uint record) {
            try {
                uint type = flags & 0xff000000;
                if (type == 0x01000000 || type == 0x00000000) LastError = Message(record);
                if (type == 0x05000000 || type == 0x19000000) { LastError = "FilesInUse"; return 2; }
                if (type == 0x08000000) {
                    action = Field(record, 1);
                    report(total > 0 ? Percent() : -1, action);
                }
                if (type == 0x0a000000) {
                    int operation = MsiRecordGetInteger(record, 1), count = MsiRecordGetInteger(record, 2);
                    if (operation == 0) { total = Math.Max(0, count); backwards = MsiRecordGetInteger(record, 3) != 0; ticks = backwards ? total : 0; actionProgress = false; }
                    else if (operation == 1) { actionTicks = Math.Max(0, count); actionProgress = MsiRecordGetInteger(record, 3) != 0; }
                    else if (operation == 2) ticks += backwards ? -count : count;
                    else if (operation == 3) total += Math.Max(0, count);
                    report(total > 0 ? Percent() : -1, action);
                } else if (type == 0x09000000 && actionProgress) {
                    ticks += backwards ? -actionTicks : actionTicks;
                    report(total > 0 ? Percent() : -1, action);
                }
                // IDCANCEL asks MSI to cancel and roll back; never kill msiexec.
                if (CancelRequested && (type == 0x0a000000 || type == 0x09000000)) return 2;
                return 1;
            } catch (Exception error) { LastError = error.Message; return 2; }
        }
        double Percent() { return Math.Max(0, Math.Min(100, (backwards ? total - ticks : ticks) * 100.0 / total)); }
        public uint Run(string package, string properties, string log, IntPtr owner) {
            IntPtr previous; handler = Receive;
            // NONE | UACONLY: suppress the legacy wizard, retain OS elevation.
            uint oldLevel = MsiSetInternalUI(2 | 0x200, ref owner);
            uint enabled = MsiEnableLog(0x3fff, log, 2);
            if (enabled != 0) { MsiSetInternalUI(oldLevel, ref owner); return enabled; }
            uint installed = MsiSetExternalUIRecord(handler, 0x3fff | (1u << 25), IntPtr.Zero, out previous);
            if (installed != 0) { MsiEnableLog(0, null, 0); MsiSetInternalUI(oldLevel, ref owner); return installed; }
            try { return MsiInstallProduct(package, properties); }
            finally {
                MsiSetExternalUIRecord(null, 0, IntPtr.Zero, out previous);
                MsiEnableLog(0, null, 0); MsiSetInternalUI(oldLevel, ref owner);
                GC.KeepAlive(handler);
            }
        }
        public static void CheckProgressContract() {
            double progress = -1; var session = new MsiSession((value, name) => progress = value);
            uint record = MsiCreateRecord(4);
            try {
                MsiRecordSetInteger(record, 1, 0); MsiRecordSetInteger(record, 2, 200); MsiRecordSetInteger(record, 3, 0);
                session.Receive(IntPtr.Zero, 0x0a000000, record);
                MsiRecordSetInteger(record, 1, 2); MsiRecordSetInteger(record, 2, 100);
                session.Receive(IntPtr.Zero, 0x0a000000, record);
                if (progress != 50) throw new Exception("Incorrect MSI progress");
                session.CancelRequested = true;
                if (session.Receive(IntPtr.Zero, 0x0a000000, record) != 2) throw new Exception("MSI cancellation must request rollback");
            } finally { MsiCloseHandle(record); }
        }
    }
}
