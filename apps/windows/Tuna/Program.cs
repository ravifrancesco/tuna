using System.Diagnostics;
using Microsoft.Web.WebView2.Core;

namespace Tuna;

static class Program
{
    [STAThread]
    static void Main()
    {
        // One Tuna at a time: opening it again brings the open one forward.
        using var single = new Mutex(true, @"Local\Tuna.App", out var first);
        if (!first)
        {
            BringOtherToFront();
            return;
        }

        // The window behind the page stays dark while it loads (no white flash).
        Environment.SetEnvironmentVariable("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "0");
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        // WebView2 (Edge's engine) shows the interface. It comes with Windows 11 and up-to-date Windows 10.
        try
        {
            CoreWebView2Environment.GetAvailableBrowserVersionString();
        }
        catch (WebView2RuntimeNotFoundException)
        {
            var answer = MessageBox.Show(
                L("Tuna needs Microsoft Edge WebView2, which isn't on this PC yet. Open the download page?"),
                "Tuna", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
            if (answer == DialogResult.Yes)
                Process.Start(new ProcessStartInfo("https://go.microsoft.com/fwlink/p/?LinkId=2124703") { UseShellExecute = true });
            return;
        }

        Application.Run(new MainWindow());
    }

    static void BringOtherToFront()
    {
        var me = Environment.ProcessId;
        foreach (var other in Process.GetProcessesByName("Tuna"))
        {
            if (other.Id == me || other.MainWindowHandle == IntPtr.Zero) continue;
            if (Native.IsIconic(other.MainWindowHandle)) Native.ShowWindow(other.MainWindowHandle, 9 /* SW_RESTORE */);
            Native.SetForegroundWindow(other.MainWindowHandle);
            return;
        }
    }
}
