/**
 * Modul: 401-Klassifikation (Ursache eines 401 unterscheiden)
 * Zweck: Der Server antwortet auf drei sehr unterschiedliche Situationen mit
 *        HTTP 401. Vor dem Hotfix behandelte api.js ALLE gleich (globales
 *        „auth:expired"-Event + Redirect zum Login) — dadurch wurde ein
 *        harmloser Business-Fehler (z. B. falsches Passwort beim 2FA-Setup)
 *        zum Sitzungsablauf und der Nutzer aus dem Formular geworfen.
 *
 *        Dieses Modul hält die Unterscheidung als reine Funktion, damit sie
 *        ohne DOM (window/document) in node:test testbar ist — api.js selbst
 *        importiert sw-register/permissions und läuft nur im Browser.
 *
 * Ablauf (R2c, v0.0.33-Hotfix):
 *   1. `two_factor_required` — „pending"-2FA-Session: Passwort ok, zweiter
 *      Faktor fehlt. Globale Behandlung wie bisher (auth:expired mit Detail,
 *      Router zeigt „需要两步验证" und den OTP-Schritt).
 *   2. `reason` — Business-Fehler bei gültiger Session (invalid_password,
 *      invalid_code, rate_limited, …). KEIN auth:expired: der aufrufende
 *      Dialog bleibt stehen und zeigt den Fehler inline (die Module übersetzen
 *      `reason` selbst, z. B. settings/twofactor.js).
 *   3. ohne beides — echte Sitzung wäre abgelaufen (`{error:'Not authenticated.'}`):
 *      auth:expired wie bisher.
 *
 * Abhängigkeiten: keine (bewusst — Siehe Zweck).
 */

/**
 * Klassifikationsergebnisse eines 401.
 * @readonly
 * @enum {string}
 */
export const AUTH_401_KIND = Object.freeze({
  /** „pending"-2FA-Session: global behandeln, mit twoFactorRequired-Detail. */
  TWO_FACTOR: 'two_factor',
  /** Business-Fehler mit `reason`: lokal als ApiError melden, kein Redirect. */
  BUSINESS: 'business',
  /** Sitzung wirklich abgelaufen: globales auth:expired wie bisher. */
  SESSION: 'session',
  /** Kein 401 — für Aufrufer, die den Status nicht vorab prüfen. */
  NOT_401: 'not_401',
});

/**
 * Klassifiziert eine API-Antwort mit Status 401.
 *
 * Reihenfolge der Prüfung bewusst: `two_factor_required` zuerst (exakt das
 * v0.0.33-Verhalten für pending-2FA-Sessions), dann `reason`. Die beiden
 * Marker sind auf Serverseite disjunkt (server/auth.js:471 liefert nur
 * two_factor_required, server/routes/twofactor.js:213 nur reason), die
 * Reihenfolge defensive Vorsorge für beides-markierte Bodies.
 *
 * @param {number} status - HTTP-Status der Antwort
 * @param {any} [body=null] - Geparster JSON-Body; null wenn nicht JSON
 * @returns {string} Einer der AUTH_401_KIND-Werte
 */
export function classify401(status, body = null) {
  if (status !== 401) return AUTH_401_KIND.NOT_401;

  if (body !== null && typeof body === 'object') {
    // Truthy-Check wie im bisherigen api.js-Code: `two_factor_required: false`
    // ist kein Challenge-Hinweis.
    if (body.two_factor_required) return AUTH_401_KIND.TWO_FACTOR;
    // Nur nicht-leere Strings gelten als Business-Marker — `reason: ''` o. Ä.
    // wäre sonst ein stiller Bypass des Session-Handlings.
    if (typeof body.reason === 'string' && body.reason.length > 0) {
      return AUTH_401_KIND.BUSINESS;
    }
  }

  return AUTH_401_KIND.SESSION;
}
