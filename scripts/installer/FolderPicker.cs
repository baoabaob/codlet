using System;
using System.IO;
using System.Runtime.InteropServices;

namespace Codlet.Setup {
    static class FolderPicker {
        [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")] class Dialog { }
        [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface Item {
            void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
            void GetParent(out Item parent);
            void GetDisplayName(uint kind, out IntPtr name);
            void GetAttributes(uint mask, out uint attributes);
            void Compare(Item other, uint hint, out int order);
        }
        [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface FileDialog {
            [PreserveSig] int Show(IntPtr owner);
            void SetFileTypes(uint count, IntPtr types); void SetFileTypeIndex(uint index); void GetFileTypeIndex(out uint index);
            void Advise(IntPtr events, out uint cookie); void Unadvise(uint cookie);
            void SetOptions(uint options); void GetOptions(out uint options);
            void SetDefaultFolder(Item item); void SetFolder(Item item); void GetFolder(out Item item); void GetCurrentSelection(out Item item);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name); void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title); void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label); void GetResult(out Item result);
            void AddPlace(Item item, uint alignment); void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
            void Close(int result); void SetClientGuid(ref Guid guid); void ClearClientData(); void SetFilter(IntPtr filter);
        }
        [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
        static extern void SHCreateItemFromParsingName(string name, IntPtr context, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out Item result);
        public static string Select(IntPtr owner, string path, string title) {
            var dialog = (FileDialog)new Dialog();
            try {
                dialog.SetOptions(0x20 | 0x40 | 0x800); // Folders, filesystem paths, existing directory.
                dialog.SetTitle(title);
                while (!String.IsNullOrEmpty(path) && !Directory.Exists(path)) path = Path.GetDirectoryName(path);
                if (!String.IsNullOrEmpty(path)) {
                    Guid iid = typeof(Item).GUID; Item initial;
                    SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out initial);
                    try { dialog.SetFolder(initial); } finally { Marshal.ReleaseComObject(initial); }
                }
                int result = dialog.Show(owner);
                if (result == unchecked((int)0x800704c7)) return null;
                Marshal.ThrowExceptionForHR(result);
                Item selected; dialog.GetResult(out selected);
                try {
                    IntPtr value; selected.GetDisplayName(0x80058000, out value);
                    try { return Marshal.PtrToStringUni(value); } finally { Marshal.FreeCoTaskMem(value); }
                } finally { Marshal.ReleaseComObject(selected); }
            } finally { Marshal.ReleaseComObject(dialog); }
        }
    }
}
