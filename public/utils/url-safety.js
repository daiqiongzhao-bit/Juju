/**
 * Modul: URL-Sicherheit
 * Zweck: Eine einzige Stelle, die entscheidet, ob ein gespeicherter Wert als
 *        klickbarer Link gerendert werden darf — und wie.
 *
 * Warum das nötig ist: `esc()` schützt gegen Attribut-Ausbruch, aber nicht
 * gegen das Schema. `href="javascript:alert(1)"` ist HTML-sauber und trotzdem
 * ausführbarer Code. Betroffen sind Werte, die nicht aus dem eigenen Formular
 * stammen, sondern aus fremden Quellen:
 *
 *   - `recipes.recipe_url` / `meals.recipe_url` — Freitext, zusätzlich über
 *     den CSV-Import (Spalten url/link/website/source) massenhaft befüllbar.
 *   - `contacts.website` — kommt aus dem vCard-URL-Feld eines fremden
 *     CardDAV-Servers.
 *
 * Regeln:
 *   - http/https werden übernommen (Groß-/Kleinschreibung egal).
 *   - Eine nackte Domain ("www.example.com") bekommt https:// vorangestellt,
 *     damit die Verschärfung keine bestehenden Nutzereingaben unklickbar macht.
 *   - Alles andere (javascript:, data:, vbscript:, file:, leer) → null. Der
 *     Aufrufer rendert dann Text statt Link.
 *
 * Bewusst ohne Abhängigkeiten, damit Server- und Clientcode dieselbe Funktion
 * importieren können (Präzedenzfall: utils/recipe-meal-types.js).
 */

// Nackte Domain: mindestens ein Punkt, kein Leerzeichen, kein Schema davor.
// Bewusst konservativ — lieber ein Link zu wenig als ein geratenes Ziel.
const BARE_HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?(?:[/?#].*)?$/i;

/**
 * @param {any} raw Gespeicherter Wert (URL, Freitext oder null)
 * @returns {string|null} Sichere http(s)-URL oder null
 */
export function safeHttpUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  // Ein anderes Schema (javascript:, data:, mailto:, ftp:, //host …) wird
  // nicht "repariert": was kein http(s) ist, wird nicht verlinkt.
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;
  if (BARE_HOST_RE.test(s)) return `https://${s}`;
  return null;
}

/**
 * Bereitet eine Nutzereingabe für die serverseitige Prüfung auf.
 *
 * Anders als `safeHttpUrl()` wird hier NICHT gefiltert: Nur eine nackte Domain
 * bekommt `https://` vorangestellt, alles andere geht unverändert zurück. Das
 * ist der wichtige Unterschied — `validate.url()` soll ein `javascript:`-Wert
 * als Fehler melden (400, "muss eine http(s)-URL sein") statt ihn still zu
 * verwerfen. Mit `safeHttpUrl()` würde aus dem Angriff ein `null`, das als
 * "Feld nicht ausgefüllt" durchgeht — der Wert verschwindet unbemerkt, und der
 * Nutzer erfährt nie, dass seine Eingabe nicht gespeichert wurde.
 *
 * @param {any} raw Rohe Eingabe aus dem Request-Body
 * @returns {string|null} Eingabe mit ggf. ergänztem Schema
 */
export function normalizeUrlInput(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s; // hat ein Schema → Prüfung übernehmen lassen
  if (BARE_HOST_RE.test(s)) return `https://${s}`;
  return s;
}

/**
 * Bequemer Wrapper für Templates: gibt den Wert zurück, wenn er verlinkbar ist,
 * sonst einen leeren String (damit `${safeHref(x) ? ... : ...}` lesbar bleibt).
 */
export function safeHrefOrEmpty(raw) {
  return safeHttpUrl(raw) ?? '';
}
