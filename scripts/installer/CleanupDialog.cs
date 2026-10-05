using System;
using System.Globalization;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Codlet.Setup {
    sealed class CleanupDialog : Form {
        readonly CheckBox consent = new CheckBox();
        readonly Button remove = new Button();
        bool cleaning;
        internal CleanupDialog(UserDataCleanup cleanup, bool chinese) {
            Text = chinese ? "Codlet · 卸载完成" : "Codlet · Uninstalled";
            Font = SystemFonts.MessageBoxFont; AutoScaleMode = AutoScaleMode.Dpi;
            ClientSize = new Size(700, 580); MinimumSize = Size;
            StartPosition = FormStartPosition.CenterScreen; MaximizeBox = false;
            var heading = new Label { Text = chinese ? "保留数据，或清理当前用户的 Codlet 数据" : "Keep or remove this user's Codlet data", Font = new Font(Font.FontFamily, 14, FontStyle.Bold) };
            heading.SetBounds(24, 22, 652, 38); Controls.Add(heading);
            var explanation = new Label { Text = chinese
                ? "可删除下列位置中的配置、插件及其存储、运行时缓存和日志，以及可识别的该目录 Windows 凭据。\n保留官方 Codex 的账号、聊天和设置；保留其他用户、自定义 CODLET_HOME、外部插件源码、未知文件和目录链接。"
                : "Remove configuration, plugins and their storage, runtime caches, logs, and identifiable Windows credentials for this data folder.\nKeep official Codex accounts, chats and settings, other users, custom CODLET_HOME folders, external source projects, unknown files and directory links." };
            explanation.SetBounds(24, 66, 652, 90); Controls.Add(explanation);
            var paths = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, WordWrap = false, Text = String.Join(Environment.NewLine, cleanup.Paths) };
            paths.SetBounds(24, 170, 652, 268); paths.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom; Controls.Add(paths);
            consent.Text = chinese ? "我确认删除所列 Codlet 数据（不可恢复）" : "I confirm deletion of the listed Codlet data (cannot be undone)";
            consent.SetBounds(24, 452, 652, 36); consent.Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom; Controls.Add(consent);
            remove.Text = chinese ? "删除所列数据" : "Remove listed data"; remove.Enabled = false;
            remove.SetBounds(306, 516, 170, 36); remove.Anchor = AnchorStyles.Right | AnchorStyles.Bottom; Controls.Add(remove);
            var keep = new Button { Text = chinese ? "保留数据并完成" : "Keep data and finish", DialogResult = DialogResult.Cancel };
            keep.SetBounds(486, 516, 190, 36); keep.Anchor = AnchorStyles.Right | AnchorStyles.Bottom; Controls.Add(keep);
            CancelButton = keep; AcceptButton = keep; ActiveControl = keep;
            consent.CheckedChanged += delegate { remove.Enabled = consent.Checked; };
            FormClosing += delegate(object sender, FormClosingEventArgs args) { if (cleaning) args.Cancel = true; };
            remove.Click += async delegate {
                cleaning = true; remove.Enabled = false; consent.Enabled = false; keep.Enabled = false; UseWaitCursor = true;
                try {
                    var retained = await Task.Run(() => cleanup.Clean());
                    cleaning = false; UseWaitCursor = false;
                    MessageBox.Show(this, retained.Count == 0
                        ? (chinese ? "所列 Codlet 数据已清理。" : "The listed Codlet data was removed.")
                        : (chinese ? "清理完成，以下未知、链接或占用中的项目已保留：\n" : "Cleanup finished. Unknown, linked or busy entries were retained:\n") + String.Join(Environment.NewLine, retained), "Codlet", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    DialogResult = DialogResult.OK; Close();
                } catch (Exception error) {
                    cleaning = false; UseWaitCursor = false; keep.Enabled = true;
                    MessageBox.Show(this, (chinese ? "清理未完成，未删除的项目已保留：\n" : "Cleanup did not complete; remaining data was retained:\n") + error.Message, "Codlet", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    consent.Enabled = true; remove.Enabled = consent.Checked;
                }
            };
        }
        internal static void Offer() {
            if (!Environment.UserInteractive || System.Security.Principal.WindowsIdentity.GetCurrent().IsSystem) return;
            var cleanup = UserDataCleanup.CurrentUser();
            if (!Directory.Exists(cleanup.Root)) return;
            using (var dialog = new CleanupDialog(cleanup, CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "zh")) dialog.ShowDialog();
        }
    }
}
