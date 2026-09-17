using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace VerstakComputerUseCanary
{
    internal static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [STAThread]
        private static void Main(string[] args)
        {
            if (args.Length != 2 || String.IsNullOrWhiteSpace(args[0]) || String.IsNullOrWhiteSpace(args[1]))
                Environment.Exit(2);

            string title = args[0];
            string statePath = Path.GetFullPath(args[1]);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            using (Form form = new Form())
            using (TextBox input = new TextBox())
            {
                form.Text = title;
                form.Name = "VerstakComputerUseNativeCanary";
                form.StartPosition = FormStartPosition.CenterScreen;
                form.Width = 640;
                form.Height = 260;
                form.TopMost = true;

                input.Name = "VerstakCanaryInput";
                input.AccessibleName = "Verstak canary input";
                // A single-line WinForms edit exposes writable UIA
                // ValuePattern. Multiline edits expose TextPattern instead and
                // are deliberately outside the bounded R2 type surface.
                input.Multiline = false;
                input.Left = 24;
                input.Top = 24;
                input.Width = 570;
                input.Height = 32;
                form.Controls.Add(input);

                Action<bool> writeState = closed => WriteState(statePath, form, input.Text, closed);
                input.TextChanged += delegate { writeState(false); };
                form.Shown += delegate
                {
                    input.Focus();
                    SetForegroundWindow(form.Handle);
                    writeState(false);
                };
                form.FormClosed += delegate { writeState(true); };
                Application.Run(form);
            }
        }

        private static void WriteState(string path, Form form, string value, bool closed)
        {
            string directory = Path.GetDirectoryName(path);
            if (!String.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            string tempPath = path + ".tmp";
            string json = "{" +
                "\"pid\":" + Process.GetCurrentProcess().Id + "," +
                "\"processStartTime100ns\":\"" + Process.GetCurrentProcess().StartTime.ToFileTimeUtc() + "\"," +
                "\"hwnd\":\"" + form.Handle.ToInt64() + "\"," +
                "\"value\":\"" + JsonEscape(value) + "\"," +
                "\"valueSha256\":\"" + Sha256(value) + "\"," +
                "\"scalarLength\":" + new StringInfo(value).LengthInTextElements + "," +
                "\"closed\":" + (closed ? "true" : "false") +
                "}";
            File.WriteAllText(tempPath, json, new UTF8Encoding(false));
            if (File.Exists(path)) File.Replace(tempPath, path, null);
            else File.Move(tempPath, path);
        }

        private static string Sha256(string value)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] digest = sha.ComputeHash(Encoding.UTF8.GetBytes(value));
                StringBuilder result = new StringBuilder(digest.Length * 2);
                foreach (byte item in digest) result.Append(item.ToString("x2"));
                return result.ToString();
            }
        }

        private static string JsonEscape(string value)
        {
            StringBuilder result = new StringBuilder(value.Length + 16);
            foreach (char item in value)
            {
                switch (item)
                {
                    case '\\': result.Append("\\\\"); break;
                    case '"': result.Append("\\\""); break;
                    case '\r': result.Append("\\r"); break;
                    case '\n': result.Append("\\n"); break;
                    case '\t': result.Append("\\t"); break;
                    default:
                        if (item < 0x20) result.Append("\\u" + ((int)item).ToString("x4"));
                        else result.Append(item);
                        break;
                }
            }
            return result.ToString();
        }
    }
}
