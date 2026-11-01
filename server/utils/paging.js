/**
 * Modul: Paging (Server)
 * Zweck: Einheitliche Auswertung von ?limit= / ?offset= für Listen-Endpunkte.
 *        Verhindert, dass eine Liste irgendwann komplett in den Speicher
 *        serialisiert wird, ohne die bestehenden Clients zu brechen.
 * Abhängigkeiten: keine
 */

/**
 * Obergrenze, ab der eine Liste als "zu groß" gilt. Die Werte sind bewusst
 * großzügig: Ein Haushalt hat realistisch ein paar Dutzend Notizen oder
 * Aufgaben, nicht Tausende. Die Grenze greift also nicht im Alltag, sondern
 * nur dann, wenn etwas schiefgelaufen ist (Import-Schleife, Sync-Duplikate) —
 * genau der Fall, in dem ein ungebremster Response den Server umbringt.
 */
export const PAGE_DEFAULTS = {
  notes:     { defaultLimit: 1000, maxLimit: 5000 },
  tasks:     { defaultLimit: 2000, maxLimit: 5000 },
  documents: { defaultLimit: 1000, maxLimit: 5000 },
};

/**
 * Liest limit/offset aus der Query.
 *
 * - Ohne Parameter bleibt das bisherige Verhalten erhalten (die Vorgabe liegt
 *   so hoch, dass sie im Alltag nie greift).
 * - `limit` wird auf [1, maxLimit] geklemmt, `offset` auf >= 0.
 *
 * @param {object} query  req.query
 * @param {{ defaultLimit: number, maxLimit: number }} cfg
 * @returns {{ limit: number, offset: number, explicit: boolean }}
 *          explicit = der Client hat selbst gepaart, dann liefert die Route
 *          auch Paging-Metadaten zurück.
 */
export function parsePaging(query, cfg) {
  const { defaultLimit, maxLimit } = cfg;
  const rawLimit  = parseInt(query?.limit, 10);
  const rawOffset = parseInt(query?.offset, 10);

  const explicit = Number.isFinite(rawLimit) || Number.isFinite(rawOffset);

  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), maxLimit)
    : defaultLimit;
  const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;

  return { limit, offset, explicit };
}

/**
 * Baut die Paging-Metadaten für die Antwort.
 *
 * `has_more` leitet die Route aus dem einen Satz zu viel ab, den sie mitliest
 * (limit + 1) — ein zusätzliches COUNT(*) über dieselbe Abfrage wäre bei
 * Aufgaben mit ihren Unterabfragen teurer als der Nutzen.
 *
 * @param {{ limit: number, offset: number }} paging
 * @param {boolean} hasMore
 * @returns {{ limit: number, offset: number, has_more: boolean }}
 */
export function pagingMeta(paging, hasMore) {
  return {
    limit: paging.limit,
    offset: paging.offset,
    has_more: Boolean(hasMore),
  };
}
