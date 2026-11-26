import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The language each request wants (the interface sends `x-tuna-lang`; apps'
 * own requests fall back to Accept-Language). Everything a request produces
 * for people (errors, row titles, track names…) goes through t(), which
 * reads the request's language, so services don't pass it around.
 * English is written where it's used; IT below maps that exact text.
 */

export type Language = 'en' | 'it';

const current = new AsyncLocalStorage<Language>();

export function languageFrom(header: string | string[] | undefined): Language {
  const value = Array.isArray(header) ? header[0] : header;
  return /^\s*it\b/i.test(value ?? '') ? 'it' : 'en';
}

/** Runs the rest of a request (or any work) in a language. */
export const inLanguage = <T>(language: Language, fn: () => T): T => current.run(language, fn);

export const lang = (): Language => current.getStore() ?? 'en';

export function t(text: string, vars?: Record<string, string | number | undefined>): string {
  const translated = lang() === 'it' ? (IT[text] ?? text) : text;
  if (!vars) return translated;
  return translated.replace(/\{(\w+)\}/g, (match, name: string) => (vars[name] === undefined ? match : String(vars[name])));
}

export function tn(count: number, one: string, other: string, vars?: Record<string, string | number | undefined>): string {
  return t(count === 1 ? one : other, { n: count, ...vars });
}

const italianNames = new Intl.DisplayNames(['it'], { type: 'language' });

/** A language's name for people: "Spanish" in English, "Spagnolo" in Italian. */
export function languageName(code: string, english: string): string {
  if (lang() !== 'it') return english;
  try {
    const name = italianNames.of(code);
    return name && name.toLowerCase() !== code.toLowerCase() ? name[0].toUpperCase() + name.slice(1) : english;
  } catch {
    return english;
  }
}

const IT: Record<string, string> = {
  // Signing in and access
  'Please sign in': 'Accedi per continuare',
  'Please sign in again': 'Accedi di nuovo',
  'Admins only': 'Solo per gli amministratori',
  'Wrong username or password': 'Nome utente o password errati',
  'Username is required': 'Inserisci il nome utente',
  "That setup code isn't right": 'Il codice di configurazione non è corretto',
  'Tuna is already set up. Admins can change this in Settings.': 'Tuna è già configurato. Gli amministratori possono cambiarlo nelle Impostazioni.',
  "Couldn't reach Navidrome at that address": 'Impossibile raggiungere Navidrome a quell’indirizzo',
  "Couldn't reach Lidarr at that address": 'Impossibile raggiungere Lidarr a quell’indirizzo',
  "Lidarr didn't accept that API key": 'Lidarr non ha accettato quella chiave API',
  "Couldn't reach slskd at that address": 'Impossibile raggiungere slskd a quell’indirizzo',
  "slskd didn't accept that API key": 'slskd non ha accettato quella chiave API',
  'Something went wrong on the Tuna server': 'Qualcosa è andato storto sul server Tuna',
  'Not found': 'Non trovato',
  '{service} is not configured on this Tuna server': '{service} non è configurato su questo server Tuna',
  '{service} is unreachable ({reason})': '{service} non risponde ({reason})',
  '{service} sent something unexpected': '{service} ha risposto in modo inatteso',
  'timed out': 'tempo scaduto',
  'no answer': 'nessuna risposta',
  'The password needs at least 4 characters': 'La password deve avere almeno 4 caratteri',
  "You can't remove yourself": 'Non puoi rimuovere te stesso',
  "ListenBrainz didn't accept that token": 'ListenBrainz non ha accettato quel token',
  'That time isn’t right': 'Quell’orario non è valido',
  'To change the household, sign out and sign in again': 'Per modificare la famiglia, esci e accedi di nuovo',

  // The library
  'Unknown artist': 'Artista sconosciuto',
  'Give the playlist a name': 'Dai un nome alla playlist',
  "Couldn't play this song": 'Impossibile riprodurre questo brano',

  // Home
  'Good morning': 'Buongiorno',
  'Good afternoon': 'Buon pomeriggio',
  'Good evening': 'Buonasera',
  'That room has ended': 'Quella stanza è stata chiusa',
  'This room is full': 'Questa stanza è piena',
  'Only {name} can end this room': 'Solo {name} può chiudere questa stanza',
  'Play something first': 'Prima fai partire qualcosa',
  'Too many rooms are open right now': 'Ci sono troppe stanze aperte in questo momento',
  'Join the room first': 'Prima entra nella stanza',
  'Fresh catch': 'Pescato fresco',
  'New to you, every Monday': 'Nuovo per te, ogni lunedì',
  '{n} new song for you': '{n} brano nuovo per te',
  '{n} new songs for you': '{n} brani nuovi per te',
  'Last.fm needs a key: an admin can add it in Settings → Connections': 'Last.fm ha bisogno di una chiave: un amministratore può aggiungerla in Impostazioni → Connessioni',
  "Last.fm doesn't know that name": 'Last.fm non conosce quel nome',
  "There's nothing from Spotify in that file": 'In quel file non c\'è niente da Spotify',
  'Good morning, {name}': 'Buongiorno, {name}',
  'Good afternoon, {name}': 'Buon pomeriggio, {name}',
  'Good evening, {name}': 'Buonasera, {name}',
  'Liked songs': 'Brani che ti piacciono',
  'Recently played': 'Ascoltati di recente',
  'Liked songs mix': 'Mix dei brani che ti piacciono',
  'The songs you love, shuffled': 'I brani che ami, in ordine casuale',
  'Made for you': 'Creati per te',
  'New in the library': 'Nuovi nella libreria',
  Discover: 'Scopri',
  'On repeat': 'In loop',
  'Your playlists': 'Le tue playlist',
  'Your artists': 'I tuoi artisti',
  'Something different': 'Qualcosa di diverso',
  'Daily Mix {n}': 'Daily Mix {n}',
  '{a}, {b} and more': '{a}, {b} e altri',

  // Get
  'less than a minute': 'meno di un minuto',
  '{n} min': '{n} min',
  '{n} h': '{n} h',
  'Lidarr has no music folder yet': 'Lidarr non ha ancora una cartella per la musica',
  "Couldn't search all music right now": 'Non riesco a cercare tra tutta la musica, per ora',
  '{a} + {b}': '{a} + {b}',
  'What you both play': 'Quello che ascoltate entrambi',
  Blends: 'Blend',
  "Lidarr doesn't know this artist": 'Lidarr non conosce questo artista',
  "Lidarr doesn't know this album yet": 'Lidarr non conosce ancora questo album',
  'Getting music needs Lidarr: an admin can add it in Settings → Connections':
    'Per scaricare musica serve Lidarr: un amministratore può aggiungerlo in Impostazioni → Connessioni',
};
