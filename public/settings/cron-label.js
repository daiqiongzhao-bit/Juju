/**
 * Modul: Einstellungen (Settings) — Cron-Ausdruck in Klartext
 * Zweck: `BACKUP_SCHEDULE` ist eine freie Cron-Zeile aus der Umgebung. Sie roh
 *        anzuzeigen ("0 2 * * *") verlangt vom Betreiber, Cron zu lesen; die
 *        Administrationsseite nennt daher zuerst den Zeitpunkt und führt den
 *        Ausdruck nur als Beleg mit.
 * Abhängigkeiten: /i18n.js
 */

import { t, formatTime, getLocale } from '/i18n.js';

const NUMBER = /^\d+$/;
const STEP = /^\*\/(\d+)$/;

// Cron zählt Wochentage ab Sonntag und lässt 7 als zweiten Sonntag zu.
const WEEKDAY_NAMES = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function parseWeekday(field) {
  if (NUMBER.test(field)) {
    const value = Number(field);
    return value >= 0 && value <= 7 ? value % 7 : null;
  }
  const named = WEEKDAY_NAMES[field.slice(0, 3).toLowerCase()];
  return named ?? null;
}

function timeLabel(hour, minute) {
  const date = new Date(2000, 0, 1, hour, minute, 0, 0);
  return formatTime(date);
}

function weekdayLabel(dow) {
  // 2000-01-02 war ein Sonntag: +dow trifft jeden Wochentag ohne Zeitzonenrechnung.
  const date = new Date(2000, 0, 2 + dow);
  return new Intl.DateTimeFormat(getLocale(), { weekday: 'long' }).format(date);
}

/**
 * Übersetzt die geläufigen Backup-Rhythmen in einen Satz. Alles darüber hinaus
 * (Listen, Bereiche, Monatsfelder) liefert null - dort bleibt der Ausdruck
 * selbst die ehrlichste Auskunft.
 */
export function formatCronSchedule(expression) {
  const fields = String(expression ?? '').trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minute, hour, dom, month, dow] = fields;
  if (month !== '*') return null;

  const stepHour = hour.match(STEP);
  if (stepHour && NUMBER.test(minute) && dom === '*' && dow === '*') {
    const count = Number(stepHour[1]);
    if (count < 1 || count > 23) return null;
    return t('settings.backupSchedulerCronHourly', { count, minute: String(Number(minute)).padStart(2, '0') });
  }

  if (!NUMBER.test(minute) || !NUMBER.test(hour)) return null;
  const time = timeLabel(Number(hour), Number(minute));

  if (dom === '*' && dow === '*') {
    return t('settings.backupSchedulerCronDaily', { time });
  }
  if (dom === '*' && dow !== '*') {
    const weekday = parseWeekday(dow);
    if (weekday == null) return null;
    return t('settings.backupSchedulerCronWeekly', { weekday: weekdayLabel(weekday), time });
  }
  if (dow === '*' && NUMBER.test(dom)) {
    const day = Number(dom);
    if (day < 1 || day > 31) return null;
    return t('settings.backupSchedulerCronMonthly', { day, time });
  }
  return null;
}
