/**
 * Modul: 401-Klassifikation
 * Zweck: Einordnung von 401-Antworten in drei fachlich verschiedene Varianten
 *        (TWO_FACTOR / BUSINESS / SESSION) - reine Funktionen, null Abhängigkeiten.
 * Abhängigkeiten: keine (kein DOM, kein fetch - direkt per `node:test` importierbar)
 *
 * Hintergrund (R2b, v0.0.34): Der Server antwortet auf geschuetzte Endpunkte mit
 * drei fachlich verschiedenen 401-Varianten, die der Client NICHT gleich
 * behandeln darf:
 *
 *   TWO_FACTOR - Passwort ok, aber der zweite Faktor fehlt. Der Server markiert
 *                das mit `two_factor_required` im Body. Kein Sitzungsablauf,
 *                sondern ein fehlender Schritt: die UI muss zur 2FA-Eingabe.
 *   BUSINESS   - fachliche Absage mit maschinenlesbarem `reason` (z. B.
 *                `invalid_password` beim 2FA-Passwort-Dialog). Kein Session-Ende:
 *                der Aufrufer soll den ApiError mit `err.data.reason` sehen
 *                (public/settings/twofactor.js message() mappt das auf den
 *                passenden UI-Text). Daher KEIN auth:expired-Event.
 *   SESSION    - generischer Sitzungsablauf ohne Zusatzinformation.
 *
 * Erkennungsreihenfolge: `two_factor_required` vor `reason` - ein Body kann
 * beides enthalten; der 2FA-Schritt hat Vorrang.
 *
 * Verwendung (public/api.js): Body mit `response.clone()` lesen (der
 * Ursprungs-Stream bleibt für den generischen !response.ok-Handler bzw. den
 * Aufrufer unverbraucht), dann nach Kind verzweigen.
 */

/** Maschinenlesbare 401-Arten (Contract mit public/api.js und test/auth-401.test.js). */
export const AUTH_401_KIND = {
  /** Passwort ok, zweiter Faktor fehlt (`two_factor_required` im Body). */
  TWO_FACTOR: 'two_factor',
  /** Fachliche Absage mit maschinenlesbarem `reason` (z. B. `invalid_password`). */
  BUSINESS: 'business',
  /** Generischer Sitzungsablauf ohne Zusatzinformation. */
  SESSION: 'session',
};

/**
 * Ermittelt die Art einer 401-Antwort.
 *
 * Reihenfolge der Pruefungen:
 *   1. Status !== 401            → null (nicht zustaendig)
 *   2. body.two_factor_required  → TWO_FACTOR (hat Vorrang vor reason)
 *   3. body.reason nicht leerer
 *      String                    → BUSINESS
 *   4. sonst                     → SESSION
 *
 * @param {number} status HTTP-Statuscode der Antwort.
 * @param {?Object} body Bereits geparster Response-Body; null/undefined/Non-Object sind erlaubt.
 * @returns {?string} Eine `AUTH_401_KIND`-Konstante, oder `null` wenn `status` nicht 401 ist.
 */
export function classify401(status, body) {
  if (status !== 401) return null;
  if (body && body.two_factor_required) return AUTH_401_KIND.TWO_FACTOR;
  if (body && typeof body.reason === 'string' && body.reason) return AUTH_401_KIND.BUSINESS;
  return AUTH_401_KIND.SESSION;
}
