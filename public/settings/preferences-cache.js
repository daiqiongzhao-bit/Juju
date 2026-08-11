import { api } from '/api.js';

/**
 * Geteilter Preferences-Zugriff für die Settings-Blätter.
 *
 * Neun Blätter holten `GET /preferences` jeweils selbst; fünf Blattwechsel
 * kosteten fünf identische Requests (Critique 2026-07-27). Der Cache hält den
 * laufenden Request, nicht dessen Ergebnis - parallele Aufrufer teilen sich
 * damit dieselbe Antwort, und ein Fehler verwirft ihn wieder, statt eine
 * kaputte Antwort festzuhalten.
 *
 * Gültigkeitsbereich ist ein Settings-Besuch: `resetPreferencesCache()` läuft
 * beim Mounten einer frischen Shell. Schreibende Stellen ausserhalb der
 * Settings (z. B. die Widget-Konfiguration im Dashboard) sind damit abgedeckt,
 * weil der Weg dorthin und zurück die Shell neu montiert.
 */
let pending = null;

export function resetPreferencesCache() {
  pending = null;
}

export function getPreferences() {
  if (!pending) {
    pending = api.get('/preferences')
      .then((response) => response?.data ?? {})
      .catch((error) => {
        pending = null;
        throw error;
      });
  }
  return pending;
}

/**
 * Schreibt Preferences und verwirft den Cache. Bewusst kein Zusammenführen der
 * Antwort: `PUT /preferences` liefert einen anderen, kleineren Ausschnitt als
 * `GET` - ihn als Cache zu setzen würde Felder verschwinden lassen.
 */
export async function savePreferences(patch) {
  try {
    return await api.put('/preferences', patch);
  } finally {
    pending = null;
  }
}
