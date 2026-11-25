global using static Tuna.Strings;
using System.Globalization;
using System.Text.RegularExpressions;

namespace Tuna;

/// <summary>
/// The app's own words (message boxes, and the errors the setup page shows) in Windows'
/// display language: Italian, else English. The web interface translates itself.
/// </summary>
static class Strings
{
    /// <summary>
    /// Windows' display language, like "it-IT" (also handed to the web view). The app runs with
    /// invariant globalization, where CultureInfo always says invariant, so Windows is asked directly.
    /// </summary>
    public static readonly string Language = DisplayLanguage();

    static readonly bool InItalian = Language.Split('-')[0].Equals("it", StringComparison.OrdinalIgnoreCase);

    /// <summary>The text in the app's language. <c>{name}</c> placeholders are filled from <paramref name="values"/>.</summary>
    public static string L(string english, params (string Name, object? Value)[] values)
    {
        var text = InItalian && Italian.TryGetValue(english, out var italian) ? italian : english;
        if (values.Length == 0) return text;
        return Regex.Replace(text, @"\{(\w+)\}", m =>
        {
            foreach (var (name, value) in values)
                if (name == m.Groups[1].Value) return Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
            return m.Value;
        });
    }

    static string DisplayLanguage()
    {
        if (CultureInfo.CurrentUICulture.Name is { Length: > 0 } name) return name;
        try
        {
            var buffer = new char[85]; // LOCALE_NAME_MAX_LENGTH
            var length = Native.LCIDToLocaleName(Native.GetUserDefaultUILanguage(), buffer, buffer.Length, 0);
            if (length > 1) return new string(buffer, 0, length - 1);
        }
        catch { /* not on Windows */ }
        return "en-US";
    }

    static readonly Dictionary<string, string> Italian = new()
    {
        // Updating
        ["Couldn't check for updates"] = "Non riesco a controllare gli aggiornamenti",
        ["This version can only be downloaded from its page."] = "Questa versione si può scaricare solo dalla sua pagina.",
        ["Couldn't download the update"] = "Non riesco a scaricare l'aggiornamento",
        ["The download doesn't look like Tuna {version}."] = "Il file scaricato non sembra Tuna {version}.",

        // Starting up
        ["Tuna needs Microsoft Edge WebView2, which isn't on this PC yet. Open the download page?"] =
            "Tuna ha bisogno di Microsoft Edge WebView2, che non è ancora installato su questo PC. Vuoi aprire la pagina per scaricarlo?",
        ["Tuna couldn't start: {error}"] = "Impossibile avviare Tuna: {error}",
        ["Tuna's window stopped working ({error}). Please open Tuna again."] = "La finestra di Tuna ha smesso di funzionare ({error}). Riapri Tuna.",

        // The server
        ["Enter the address of your Tuna server"] = "Inserisci l'indirizzo del tuo server Tuna",
        ["That doesn't look like an address"] = "Non sembra un indirizzo",
        ["Can't reach {server} ({why})"] = "Impossibile raggiungere {server} ({why})",
        ["Can't reach {server}"] = "Impossibile raggiungere {server}",
        ["no answer"] = "nessuna risposta",
        ["{server} doesn't look like a Tuna server"] = "{server} non sembra un server Tuna",
        ["Not allowed here"] = "Non consentito qui",

        // Away from home
        ["The tunnel didn't answer"] = "Il tunnel non ha risposto",

        // Playing
        ["Couldn't play this song"] = "Impossibile riprodurre questo brano",
    };
}
