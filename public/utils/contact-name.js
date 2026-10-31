/**
 * Modul: Kontakt-Namensteile (public/utils/contact-name.js)
 * Zweck: Strukturierte vCard-N-Komponenten (Vorname/Nachname/…) in einen
 *        einheitlichen Anzeigenamen überführen (#535).
 * Abhängigkeiten: keine (isomorph: Frontend und Server teilen dieses Modul,
 *        siehe Allowlist in test/test-layer-boundary.js)
 *
 * Hintergrund: CardDAV-Quellen formatieren `FN` beliebig — mal `Given Family`,
 * mal `Family, Given`, mal mit Titel oder Spitzname. `N` trägt die Struktur
 * (Family;Given;Additional;Prefix;Suffix). Juju speichert die Komponenten und
 * leitet die Anzeige daraus ab, damit Liste und Sortierung konsistent bleiben.
 */

/** Leerer/whitespace-only Wert → null, sonst getrimmter String. */
function clean(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

/**
 * Normalisiert die fünf N-Komponenten auf `null`-oder-getrimmt.
 * @param {Object} parts
 * @returns {{firstName: string|null, lastName: string|null, middleName: string|null, namePrefix: string|null, nameSuffix: string|null}}
 */
export function normalizeNameParts(parts = {}) {
  return {
    firstName:  clean(parts.firstName),
    lastName:   clean(parts.lastName),
    middleName: clean(parts.middleName),
    namePrefix: clean(parts.namePrefix),
    nameSuffix: clean(parts.nameSuffix),
  };
}

// Han-Schrift (inkl. Erweiterungen und Kompatibilitätsbereich). Namensbestandteile
// mit diesen Zeichen folgen der ostasiatischen Reihenfolge 姓+名 ohne Leerzeichen.
const CJK_NAME = /[\u3400-\u9FFF\uF900-\uFAFF]/;

/**
 * Baut den Anzeigenamen aus den Komponenten.
 *
 * Westliche Namen: `Vorname [Zweitname] Nachname`.
 * Chinesische/japanische/koreanische Namen: `姓 名` ohne Leerzeichen — die
 * westliche Reihenfolge ergab „定丽 朱" statt „朱定丽" (Feedback 2026-10-25).
 * Erkannt wird am Vorhandensein von Han-Zeichen, damit auch ein Haushalt mit
 * gemischten Namen pro Kontakt korrekt bleibt.
 * Titel (Prefix) und Suffix bleiben gespeichert, aber aus der Anzeige heraus.
 * @param {Object} parts - Rohe oder normalisierte Komponenten
 * @returns {string|null} Anzeigename oder null, wenn keine Komponente gesetzt ist
 */
export function composeDisplayName(parts = {}) {
  const n = normalizeNameParts(parts);
  const ordered = [n.lastName, n.firstName, n.middleName].filter(Boolean);
  // Nur rein ostasiatische Namen umstellen: enthält ein Teil lateinische
  // Buchstaben (z. B. „Anna 朱"), bleibt die westliche Reihenfolge sinnvoller.
  const hasCjk = ordered.some((part) => CJK_NAME.test(part));
  const hasLatin = ordered.some((part) => /[A-Za-z]/.test(part));
  if (hasCjk && !hasLatin) return ordered.join('');
  const joined = [n.firstName, n.middleName, n.lastName].filter(Boolean).join(' ');
  return joined || null;
}

/**
 * Zerlegt einen vorhandenen Anzeigenamen heuristisch in Vor-/Nachname. Nur für
 * die Vorbelegung des Formulars bei Kontakten ohne gespeicherte Struktur
 * (Altbestand): letzter Namensteil = Nachname, alles davor = Vorname. Ein
 * einzelnes Wort bleibt Vorname, damit composeDisplayName es unverändert
 * zurückgibt.
 * @param {string|null} name
 * @returns {{firstName: string|null, lastName: string|null}}
 */
export function splitDisplayName(name) {
  const value = clean(name);
  if (!value) return { firstName: null, lastName: null };

  const parts = value.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: null };

  return {
    firstName: parts.slice(0, -1).join(' '),
    lastName: parts[parts.length - 1],
  };
}

/**
 * Sortierschlüssel eines Kontakts: Nachname, sonst der Anzeigename.
 * @param {{last_name?: string|null, name?: string|null}} contact
 * @returns {string}
 */
export function contactSortKey(contact = {}) {
  return clean(contact.last_name) || clean(contact.name) || '';
}
