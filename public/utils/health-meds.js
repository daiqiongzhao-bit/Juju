/**
 * Modul: Medikamenten-Logik (Health)
 * Zweck: Reine, DOM-freie Kernfunktionen für den Medikamente-Tab — Fälligkeit
 *        aus Einnahmeplänen (computeDueDoses), Adherence-Quote (computeAdherence)
 *        und Bestands-/Refill-Status (refillState) plus Wochentags-Masken-Helfer.
 *        Analog zu health-vitals.js bewusst OHNE i18n/DOM, damit die Funktionen in
 *        Node ohne Browser-Umgebung getestet werden können.
 * Abhängigkeiten: /utils/date.js (ebenfalls DOM-frei).
 */

import { parseLocalDateKey, addLocalDays } from '/utils/date.js';

// Wochentags-Konvention der days_mask: Bit 0 = Montag … Bit 6 = Sonntag.
// NULL/undefined = täglich (jeder Wochentag). 0 = kein Wochentag.
export const WEEKDAY_COUNT = 7;

/** Wochentag-Index eines Datums (YYYY-MM-DD) mit Montag = 0 … Sonntag = 6. */
export function weekdayIndex(dateKey) {
  const d = parseLocalDateKey(dateKey);
  return (d.getDay() + 6) % 7;
}

/** Prüft, ob eine days_mask den gegebenen Wochentag (Mo=0…So=6) enthält. */
export function daysMaskMatches(mask, weekdayIdx) {
  if (mask === null || mask === undefined || mask === '') return true; // täglich
  return (Number(mask) & (1 << weekdayIdx)) !== 0;
}

/** days_mask → Array der gesetzten Wochentag-Indizes (Mo=0…So=6). NULL → alle. */
export function daysMaskToIndices(mask) {
  const out = [];
  for (let i = 0; i < WEEKDAY_COUNT; i++) {
    if (daysMaskMatches(mask, i)) out.push(i);
  }
  return out;
}

/**
 * Array von Wochentag-Indizes → days_mask.
 * Gibt null zurück, wenn alle oder kein Tag gewählt ist (= täglich).
 */
export function indicesToDaysMask(indices) {
  const set = new Set((Array.isArray(indices) ? indices : []).map(Number));
  if (set.size === 0 || set.size >= WEEKDAY_COUNT) return null;
  let mask = 0;
  for (const i of set) {
    if (i >= 0 && i < WEEKDAY_COUNT) mask |= (1 << i);
  }
  return mask === 0 ? null : mask;
}

/**
 * Berechnet die fälligen Dosen aus aktiven Einnahmeplänen für einen Zeitraum.
 *
 * @param {Array<Object>} schedules - Einnahmeplan-Zeilen. Erwartete Felder:
 *        id, medication_id, time_of_day ('HH:MM'), days_mask (int|null),
 *        dose_qty, start_date, end_date, active.
 * @param {Object} range
 * @param {string} range.from - Start-Datum (YYYY-MM-DD, inklusiv)
 * @param {string} range.to   - End-Datum (YYYY-MM-DD, inklusiv)
 * @returns {Array<{ scheduleId:number|null, medicationId:number|null, date:string,
 *                   time:string, scheduledAt:string, dose_qty:number|null }>}
 *          scheduledAt ist ein lokaler 'YYYY-MM-DDTHH:MM'-Zeitstempel (kein UTC-Shift).
 */
export function computeDueDoses(schedules, range = {}) {
  const { from, to } = range;
  if (!from || !to || from > to) return [];
  const list = Array.isArray(schedules) ? schedules : [];
  const doses = [];

  let dateKey = from;
  let guard = 0;
  while (dateKey <= to && guard < 1000) {
    const wd = weekdayIndex(dateKey);
    for (const s of list) {
      if (!s) continue;
      if (s.active === 0 || s.active === false) continue;
      if (s.start_date && dateKey < s.start_date) continue;
      if (s.end_date && dateKey > s.end_date) continue;
      if (!daysMaskMatches(s.days_mask, wd)) continue;
      const time = s.time_of_day || '00:00';
      doses.push({
        scheduleId: s.id ?? null,
        medicationId: s.medication_id ?? null,
        date: dateKey,
        time,
        scheduledAt: `${dateKey}T${time}`,
        dose_qty: s.dose_qty ?? null,
      });
    }
    dateKey = addLocalDays(dateKey, 1);
    guard += 1;
  }

  doses.sort((a, b) => {
    if (a.scheduledAt !== b.scheduledAt) return a.scheduledAt < b.scheduledAt ? -1 : 1;
    return (a.scheduleId || 0) - (b.scheduleId || 0);
  });
  return doses;
}

/**
 * Adherence-Quote: genommene Dosen / geplante Dosen im Zeitraum.
 *
 * @param {Array<Object>} logs - Dosis-Log-Zeilen mit `status`
 *        ('taken'|'skipped'|'pending').
 * @param {number} [planned]   - Anzahl geplanter Dosen (z. B. computeDueDoses().length).
 *        Fehlt der Wert, werden getroffene Entscheidungen (taken+skipped) als Basis genutzt.
 * @returns {{ taken:number, skipped:number, pending:number, planned:number, rate:number|null }}
 *          rate ∈ [0,1] oder null, wenn keine Basis existiert.
 */
export function computeAdherence(logs, planned) {
  const list = Array.isArray(logs) ? logs : [];
  const taken = list.filter((l) => l && l.status === 'taken').length;
  const skipped = list.filter((l) => l && l.status === 'skipped').length;
  const pending = list.filter((l) => l && l.status === 'pending').length;

  const plannedCount = Number.isFinite(planned) && planned >= 0 ? planned : (taken + skipped);
  // Nenner nie kleiner als die Zahl genommener Dosen (schützt vor >100 % bei Ad-hoc-Logs).
  const denom = Math.max(plannedCount, taken);
  const rate = denom > 0 ? taken / denom : null;

  return { taken, skipped, pending, planned: plannedCount, rate };
}

/**
 * Bestands-/Refill-Status eines Medikaments.
 *
 * @param {Object} med - Medikament mit stock_qty, refill_threshold.
 * @returns {{ level:'none'|'ok'|'low'|'out', stock:number|null,
 *             threshold:number|null, below:boolean }}
 *          level 'none' = kein Bestand erfasst; 'out' = leer; 'low' = <= Schwelle.
 */
export function refillState(med) {
  const rawStock = med && med.stock_qty != null ? Number(med.stock_qty) : null;
  const threshold = med && med.refill_threshold != null && Number.isFinite(Number(med.refill_threshold))
    ? Number(med.refill_threshold)
    : null;

  if (rawStock === null || !Number.isFinite(rawStock)) {
    return { level: 'none', stock: null, threshold, below: false };
  }
  if (rawStock <= 0) {
    return { level: 'out', stock: rawStock, threshold, below: true };
  }
  if (threshold !== null && rawStock <= threshold) {
    return { level: 'low', stock: rawStock, threshold, below: true };
  }
  return { level: 'ok', stock: rawStock, threshold, below: false };
}
