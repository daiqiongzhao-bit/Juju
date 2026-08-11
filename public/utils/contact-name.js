/**
 * Modul: Kontakt-Namensteile (public/utils/contact-name.js)
 * Zweck: Strukturierte vCard-N-Komponenten (Vorname/Nachname/…) in einen
 *        einheitlichen Anzeigenamen überführen (#535).
 * Abhängigkeiten: keine (isomorph: Frontend und Server teilen dieses Modul,
 *        siehe Allowlist in test/test-layer-boundary.js)
 *
 * Hintergrund: CardDAV-Quellen formatieren `FN` beliebig — mal `Given Family`,
 * mal `Family, Given`, mal mit Titel oder Spitzname. `N` trägt die Struktur
 * (Family;Given;Additional;Prefix;Suffix). Yuvomi speichert die Komponenten und
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

/**
 * Baut den Anzeigenamen aus den Komponenten: immer `Vorname [Zweitname] Nachname`.
 * Titel (Prefix) und Suffix bleiben gespeichert, aber aus der Anzeige heraus —
 * genau das macht die Liste über verschiedene Quellen hinweg einheitlich.
 * @param {Object} parts - Rohe oder normalisierte Komponenten
 * @returns {string|null} Anzeigename oder null, wenn keine Komponente gesetzt ist
 */
export function composeDisplayName(parts = {}) {
  const n = normalizeNameParts(parts);
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
