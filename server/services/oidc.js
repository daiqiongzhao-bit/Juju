/**
 * Modul: OIDC-Client
 * Zweck: OpenID-Connect-Konfiguration (openid-client v6), via Umgebungsvariablen.
 *        getConfig() führt Discovery durch und cached die Configuration für die Laufzeit.
 *        resetClient() wird in Tests verwendet um den Cache zu leeren.
 */
import * as client from 'openid-client';

let _config = null;

/**
 * Gibt true zurück wenn alle vier OIDC-Umgebungsvariablen gesetzt sind.
 * @returns {boolean}
 */
export function isOidcEnabled() {
  return !!(
    process.env.OIDC_ISSUER &&
    process.env.OIDC_CLIENT_ID &&
    process.env.OIDC_CLIENT_SECRET &&
    process.env.OIDC_REDIRECT_URI
  );
}

/**
 * Gibt die initialisierte OIDC-Configuration zurück (Discovery bei erstem Aufruf).
 * Gibt null zurück wenn OIDC nicht konfiguriert ist.
 * @returns {Promise<import('openid-client').Configuration|null>}
 */
export async function getConfig() {
  if (!isOidcEnabled()) return null;
  if (_config) return _config;

  // client_secret_basic explizit erzwingen — der v6-Default wäre client_secret_post,
  // was eine stille Verhaltensänderung gegenüber v5 gewesen wäre.
  _config = await client.discovery(
    new URL(process.env.OIDC_ISSUER),
    process.env.OIDC_CLIENT_ID,
    process.env.OIDC_CLIENT_SECRET,
    client.ClientSecretBasic(process.env.OIDC_CLIENT_SECRET),
  );

  return _config;
}

/**
 * Leert den Configuration-Cache. Nur für Tests.
 */
export function resetClient() {
  _config = null;
}
