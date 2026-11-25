import Foundation

/// The app's own words (menus, alerts, error messages): Italian when it's your
/// first language, English otherwise. Everything else on screen is the Tuna
/// web interface, which translates itself. Keys are the exact English text;
/// `{name}` placeholders are filled from `values`, after translating, so the
/// Italian can put them where Italian needs them.
func L(_ english: String, _ values: [String: String] = [:]) -> String {
    let italian = Locale.preferredLanguages.first?.lowercased().hasPrefix("it") == true
    let text = italian ? (Strings.italian[english] ?? english) : english
    return Strings.fill(text, values)
}

enum Strings {
    /// Informal "tu", as everywhere in Tuna.
    static let italian: [String: String] = [
        // Updating the app
        "Couldn't check for updates": "Non riesco a controllare gli aggiornamenti",
        "This version can only be downloaded from its page.": "Questa versione si può scaricare solo dalla sua pagina.",
        "Tuna can't update itself here.": "Tuna non può aggiornarsi da qui.",
        "Move Tuna to your Applications folder, open it from there, then update.": "Sposta Tuna nella cartella Applicazioni, aprilo da lì e poi aggiorna.",
        "Tuna can't replace itself in that folder. Download the new version from its page instead.": "Tuna non può sostituirsi in quella cartella. Scarica la nuova versione dalla sua pagina.",
        "The download doesn't look like Tuna {version}.": "Il file scaricato non sembra Tuna {version}.",
        "The update couldn't be checked or unpacked.": "Non sono riuscito a verificare o aprire l’aggiornamento.",
        "Couldn't download the update": "Non riesco a scaricare l’aggiornamento",
        "Couldn't update Tuna": "Non riesco ad aggiornare Tuna",
        "Tuna is up to date": "Tuna è aggiornato",

        // Mac menus (standard macOS wording)
        "About Tuna": "Informazioni su Tuna",
        "Change Server…": "Cambia server…",
        "Hide Tuna": "Nascondi Tuna",
        "Hide Others": "Nascondi altre",
        "Show All": "Mostra tutte",
        "Quit Tuna": "Esci da Tuna",
        "Edit": "Modifica",
        "Undo": "Annulla",
        "Redo": "Ripeti",
        "Cut": "Taglia",
        "Copy": "Copia",
        "Paste": "Incolla",
        "Select All": "Seleziona tutto",
        "View": "Vista",
        "Reload": "Ricarica",
        // macOS renames this one itself (Attiva/Disattiva modalità a tutto schermo) once the menu opens.
        "Toggle Full Screen": "Attiva modalità a tutto schermo",
        "Go": "Vai",
        "Home": "Home",
        "Back": "Indietro",
        "Window": "Finestra",
        "Minimize": "Contrai",
        "Zoom": "Ridimensiona",
        "Controls": "Controlli",
        "Play": "Riproduci",
        "Pause": "Pausa",
        "Next": "Successivo",
        "Previous": "Precedente",

        // Alerts from the pages
        "OK": "OK",
        "Cancel": "Annulla",

        // Server address
        "Enter the address of your Tuna server": "Inserisci l'indirizzo del tuo server Tuna",
        "That doesn't look like an address": "Questo non sembra un indirizzo",
        "Can't reach {address} ({error})": "Impossibile raggiungere {address} ({error})",
        "Can't reach {address}": "Impossibile raggiungere {address}",
        "{address} doesn't look like a Tuna server": "{address} non sembra un server Tuna",

        // Requests from the pages
        "Bad request": "Richiesta non valida",
        "Not allowed here": "Non consentito qui",
        "Unknown request": "Richiesta sconosciuta",
        "Not found": "Non trovato",

        // The player
        "This song couldn't be played": "Impossibile riprodurre questo brano",

        // Away from home
        "the tunnel didn't start": "il tunnel non è partito",
        "the tunnel didn't answer": "il tunnel non ha risposto",
    ]

    /// Puts `values` into the `{name}` slots in one pass (a value containing braces stays as it is).
    static func fill(_ template: String, _ values: [String: String]) -> String {
        guard !values.isEmpty else { return template }
        var result = ""
        var rest = Substring(template)
        while let open = rest.firstIndex(of: "{"), let close = rest[open...].firstIndex(of: "}") {
            result += rest[..<open]
            let name = String(rest[rest.index(after: open)..<close])
            result += values[name] ?? String(rest[open...close])
            rest = rest[rest.index(after: close)...]
        }
        return result + rest
    }
}
