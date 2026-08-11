/**
 * Modul: Vorrats-Status (Pantry status)
 * Zweck: Ablauf- und Bestandsstatus eines Vorratsartikels ableiten und filtern.
 * Abhängigkeiten: public/utils/date.js
 *
 * Bewusst im Client statt im Router: "abgelaufen" hängt am lokalen Kalendertag
 * des Nutzers. Der Server rechnet in UTC und läge westlich von UTC bis zu einen
 * Tag daneben - genau die Klasse Fehler, gegen die toLocalDateKey() existiert.
 */

import { addLocalDays, parseLocalDateKey, toLocalDateKey } from '/utils/date.js';

/** Vorlauf in Tagen, ab dem ein Artikel als "läuft bald ab" gilt. */
export const EXPIRY_SOON_DAYS = 7;

/** Die drei Zustände, die eine eigene Filter-Chip bekommen. */
export const PANTRY_FILTERS = Object.freeze(['expired', 'soon', 'low']);

/**
 * @param {object} item - Vorratsartikel aus der API
 * @param {string} [todayKey] - lokaler Tagesschlüssel (YYYY-MM-DD)
 * @returns {{ out: boolean, low: boolean, expiry: 'expired'|'soon'|null }}
 */
export function pantryItemStatus(item, todayKey = toLocalDateKey()) {
  const quantity = Number(item?.quantity ?? 0);
  const min = item?.min_quantity == null ? null : Number(item.min_quantity);

  const out = quantity <= 0;
  // "Fast leer" schließt "leer" aus: ein leerer Artikel ist kein Grenzfall mehr,
  // er hat eine eigene, deutlichere Darstellung.
  const low = !out && min !== null && Number.isFinite(min) && quantity <= min;

  let expiry = null;
  const expiresOn = item?.expires_on || null;
  if (expiresOn) {
    // Reiner Stringvergleich: YYYY-MM-DD ist lexikografisch = chronologisch.
    if (expiresOn < todayKey) expiry = 'expired';
    else if (expiresOn <= addLocalDays(todayKey, EXPIRY_SOON_DAYS)) expiry = 'soon';
  }

  return { out, low, expiry };
}

/** Ganze Kalendertage von todayKey bis dateKey (negativ = liegt zurück). */
export function daysUntil(dateKey, todayKey = toLocalDateKey()) {
  const from = parseLocalDateKey(todayKey);
  const to = parseLocalDateKey(dateKey);
  // Über Zeitumstellungen hinweg ist ein Tag nicht exakt 86400s lang; das Runden
  // fängt die ±1h ab, statt einen Tag zu verschlucken.
  return Math.round((to - from) / 86_400_000);
}

/**
 * Trifft der Artikel den aktiven Filter? `null`/'all' lässt alles durch.
 * "Fast leer" umfasst bewusst auch leere Artikel: wer die Liste nach Nachschub
 * durchsieht, will beides sehen.
 */
export function matchesPantryFilter(item, filter, todayKey = toLocalDateKey()) {
  if (!filter || filter === 'all') return true;
  const status = pantryItemStatus(item, todayKey);
  if (filter === 'expired') return status.expiry === 'expired';
  if (filter === 'soon') return status.expiry === 'soon';
  if (filter === 'low') return status.low || status.out;
  return true;
}

/** Zählt je Filter, wie viele Artikel ihn treffen. */
export function pantryFilterCounts(items, todayKey = toLocalDateKey()) {
  const counts = { expired: 0, soon: 0, low: 0 };
  for (const item of items) {
    const status = pantryItemStatus(item, todayKey);
    if (status.expiry === 'expired') counts.expired += 1;
    if (status.expiry === 'soon') counts.soon += 1;
    if (status.low || status.out) counts.low += 1;
  }
  return counts;
}
