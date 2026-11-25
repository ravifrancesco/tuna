import Foundation

/// The app's own words (alerts, error messages): Italian when it's your first language,
/// English otherwise. Everything else on screen is the Tuna web interface, which translates
/// itself. Keys are the exact English text; `{name}` placeholders are filled from `values`,
/// after translating, so the Italian can put them where Italian needs them.
func L(_ english: String, _ values: [String: String] = [:]) -> String {
    let italian = Locale.preferredLanguages.first?.lowercased().hasPrefix("it") == true
    let text = italian ? (Strings.italian[english] ?? english) : english
    return Strings.fill(text, values)
}

enum Strings {
    /// Informal "tu", as in the rest of Tuna.
    static let italian: [String: String] = [
        // Alerts from the pages
        "OK": "OK",
        "Cancel": "Annulla",

        // Server address
        "Enter the address of your Tuna server": "Inserisci l'indirizzo del tuo server Tuna",
        "That doesn't look like an address": "Questo non sembra un indirizzo",
        "Can't reach {address} ({error})": "Impossibile raggiungere {address} ({error})",
        "{address} doesn't look like a Tuna server": "{address} non sembra un server Tuna",

        // Requests from the pages
        "Bad request": "Richiesta non valida",
        "Not allowed here": "Non consentito qui",
        "Unknown request": "Richiesta sconosciuta",
        "Not found": "Non trovato",

        // The player
        "This song couldn't play": "Impossibile riprodurre questo brano",
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
