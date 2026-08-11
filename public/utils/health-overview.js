/**
 * Modul: Übersichts-Aggregation (Health)
 * Zweck: Reine, DOM-freie Kernfunktionen für den Übersicht-Tab (`/health`), die
 *        die bestehenden Detail-Tab-Daten konsumieren, aber nicht neu berechnen:
 *        die nächsten heute noch offenen Med-Zeitfenster (upcomingDoses) und die
 *        Einnahme-Streak (computeAdherenceStreak). Beide bauen auf computeDueDoses
 *        aus health-meds.js auf — keine neue Fälligkeitslogik.
 * Abhängigkeiten: /utils/health-meds.js, /utils/date.js (beide DOM-frei) — bewusst
 *        KEINE i18n/DOM, damit die Funktionen in Node ohne Browser testbar sind.
 */

import { computeDueDoses } from '/utils/health-meds.js';
import { addLocalDays } from '/utils/date.js';

/** Datums-Anteil (YYYY-MM-DD) eines Zeitstempels ohne UTC-Shift. */
function dayKeyOf(value) {
  return String(value || '').slice(0, 10);
}

/**
 * Findet den zugehörigen Dosis-Log-Eintrag einer geplanten Dosis (gleiche
 * schedule_id + scheduled_at) — spiegelt findLogForDose im Meds-Tab.
 */
function logForDose(dose, logs) {
  return (Array.isArray(logs) ? logs : []).find(
    (l) => l && l.schedule_id === dose.scheduleId && l.scheduled_at === dose.scheduledAt,
  ) || null;
}

/**
 * Die heute noch offenen, in der Zukunft liegenden Med-Zeitfenster.
 *
 * @param {Array<Object>} schedules - Einnahmeplan-Zeilen (wie computeDueDoses).
 * @param {Array<Object>} logs      - Dosis-Log-Zeilen (status + scheduled_at).
 * @param {Object} opts
 * @param {string} opts.today       - heutiges Datum (YYYY-MM-DD).
 * @param {string} [opts.nowTime]   - aktuelle Uhrzeit 'HH:MM' (Default '00:00').
 * @param {number} [opts.limit]     - maximale Anzahl (Default alle).
 * @returns {Array<{ scheduleId, medicationId, time, scheduledAt, dose_qty }>}
 *          chronologisch aufsteigend; bereits genommene/übersprungene Dosen
 *          sowie Zeitfenster vor `nowTime` werden ausgelassen.
 */
export function upcomingDoses(schedules, logs, opts = {}) {
  const { today, nowTime = '00:00', limit } = opts;
  if (!today) return [];
  const due = computeDueDoses(schedules, { from: today, to: today });
  const open = due.filter((dose) => {
    if (dose.time < nowTime) return false;
    const log = logForDose(dose, logs);
    return !log || log.status === 'pending';
  });
  return typeof limit === 'number' ? open.slice(0, limit) : open;
}

/**
 * Einnahme-Streak: Anzahl aufeinanderfolgender Tage (rückwärts ab heute), an
 * denen alle geplanten Dosen genommen wurden. Tage ohne geplante Dosen brechen
 * die Serie nicht (werden übersprungen). Der heutige Tag bricht die Serie nicht,
 * wenn er noch nicht vollständig erledigt ist (Dosen können noch offen sein) —
 * er zählt nur, wenn bereits alle genommen wurden.
 *
 * @param {Array<Object>} schedules - Einnahmeplan-Zeilen (wie computeDueDoses).
 * @param {Array<Object>} logs      - Dosis-Log-Zeilen (status + scheduled_at).
 * @param {Object} opts
 * @param {string} opts.today       - heutiges Datum (YYYY-MM-DD).
 * @param {number} [opts.maxDays=60]- maximale Rückschau (Sicherheitsgrenze).
 * @returns {number} Länge der Serie (Anzahl vollständig eingehaltener Tage).
 */
export function computeAdherenceStreak(schedules, logs, opts = {}) {
  const { today, maxDays = 60 } = opts;
  if (!today) return 0;

  const takenByDay = new Map();
  for (const l of (Array.isArray(logs) ? logs : [])) {
    if (l && l.status === 'taken') {
      const key = dayKeyOf(l.scheduled_at || l.taken_at || l.created_at);
      takenByDay.set(key, (takenByDay.get(key) || 0) + 1);
    }
  }

  let streak = 0;
  let day = today;
  for (let i = 0; i < maxDays; i++) {
    const planned = computeDueDoses(schedules, { from: day, to: day }).length;
    if (planned > 0) {
      const taken = takenByDay.get(day) || 0;
      if (taken >= planned) {
        streak += 1;
      } else if (day !== today) {
        break; // ein vergangener Tag mit offenen Dosen beendet die Serie
      }
      // heute + unvollständig: weder zählen noch abbrechen (Tag läuft noch)
    }
    day = addLocalDays(day, -1);
  }
  return streak;
}
