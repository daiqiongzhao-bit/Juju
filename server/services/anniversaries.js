import { formatDateKey, resolveHouseholdFormats, translate } from '../utils/i18n.js';

const ANNIVERSARY_COLOR = '#B45309';
const ANNIVERSARY_RRULE = 'FREQ=YEARLY;INTERVAL=1';

// Felder, die der Jahrestag selbst hervorbringt (Titel, Beschreibung, Start).
const AUTHORED_FIELDS = ['title', 'description', 'start_datetime'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function leapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

// anniversary_date ist MM-DD (ohne Jahr). Liefert das nächste Vorkommen als
// vollständiges ISO-Datum, inkl. Schaltjahr-Korrektur für den 29.02.
function normalizedMonthDay(monthDay, year) {
  const [, monthStr, dayStr] = String(monthDay).split('-');
  const month = parseInt(monthStr, 10);
  let day = parseInt(dayStr, 10);
  if (month === 2 && day === 29 && !leapYear(year)) day = 28;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function nextAnniversaryDate(monthDay, from = new Date()) {
  const now = from instanceof Date ? from : new Date(from);
  const thisYear = normalizedMonthDay(monthDay, now.getFullYear());
  const today = now.toISOString().slice(0, 10);
  return thisYear >= today
    ? thisYear
    : normalizedMonthDay(monthDay, now.getFullYear() + 1);
}

function yearsSince(monthDay, from = new Date()) {
  const next = nextAnniversaryDate(monthDay, from);
  const startYear = parseInt(String(monthDay).slice(0, 4), 10);
  if (Number.isNaN(startYear)) return null;
  return parseInt(next.slice(0, 4), 10) - startYear;
}

function daysUntilAnniversary(monthDay, from = new Date()) {
  const now = from instanceof Date ? from : new Date(from);
  const next = nextAnniversaryDate(monthDay, now);
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const nextUtc = Date.UTC(
    parseInt(next.slice(0, 4), 10),
    parseInt(next.slice(5, 7), 10) - 1,
    parseInt(next.slice(8, 10), 10),
  );
  return Math.round((nextUtc - todayUtc) / 86400000);
}

function getOffsetMinutes(anniversary) {
  if (anniversary.reminder_offset === 'custom') {
    const amount = parseInt(anniversary.reminder_custom_amount, 10) || 1;
    const unit = anniversary.reminder_custom_unit || 'days';
    if (unit === 'weeks') return amount * 10080;
    if (unit === 'days') return amount * 1440;
    if (unit === 'hours') return amount * 60;
    return amount;
  }
  if (anniversary.reminder_offset === '' || anniversary.reminder_offset == null) return 0;
  return parseInt(anniversary.reminder_offset, 10) || 0;
}

function anniversaryReminderAt(monthDay, offsetMin = 0, from = new Date()) {
  const next = nextAnniversaryDate(monthDay, from);
  const baseTime = new Date(`${next}T12:00:00Z`).getTime();
  return new Date(baseTime - (offsetMin || 0) * 60000).toISOString();
}

function contactName(database, contactId) {
  const row = database.prepare('SELECT name FROM contacts WHERE id = ?').get(contactId);
  return row?.name || translate(resolveHouseholdFormats(database).locale, 'relationships.unknownContact');
}

function eventTitle(title, name, locale) {
  return translate(locale, 'anniversaries.calendarEventTitle', { title, name });
}

function eventDescription(title, monthDay, name, locale, dateFormat) {
  return translate(locale, 'anniversaries.calendarEventDescription', {
    title,
    name,
    date: formatDateKey(monthDay, dateFormat),
  });
}

function deleteCalendarEvent(database, eventId) {
  database.prepare('DELETE FROM calendar_events WHERE id = ?').run(eventId);
}

function syncAnniversaryCalendarEvent(database, anniversary) {
  // "Keine Erinnerung" → Jahrestag soll weder im Dashboard noch im Kalender
  // erscheinen. Vorhandenes Event löschen und null zurückgeben.
  if (anniversary.reminder_offset === '') {
    if (anniversary.calendar_event_id) {
      deleteCalendarEvent(database, anniversary.calendar_event_id);
      database.prepare('UPDATE anniversaries SET calendar_event_id = NULL WHERE id = ?').run(anniversary.id);
    }
    return null;
  }

  const { locale, dateFormat } = resolveHouseholdFormats(database);
  const name = contactName(database, anniversary.contact_id);
  const payload = {
    title: eventTitle(anniversary.title, name, locale),
    description: eventDescription(anniversary.title, anniversary.anniversary_date, name, locale, dateFormat),
    start_datetime: nextAnniversaryDate(anniversary.anniversary_date),
    end_datetime: null,
    all_day: 1,
    location: null,
    color: ANNIVERSARY_COLOR,
    icon: 'gift',
    assigned_to: null,
    recurrence_rule: ANNIVERSARY_RRULE,
    created_by: anniversary.created_by,
  };

  if (anniversary.calendar_event_id) {
    const existing = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(anniversary.calendar_event_id);
    if (existing) {
      database.prepare(`
        UPDATE calendar_events
        SET title = ?, description = ?, start_datetime = ?, end_datetime = ?, all_day = ?,
            location = ?, color = ?, icon = ?, assigned_to = ?, recurrence_rule = ?, created_by = ?
        WHERE id = ?
      `).run(
        payload.title,
        payload.description,
        payload.start_datetime,
        payload.end_datetime,
        payload.all_day,
        payload.location,
        payload.color,
        payload.icon,
        payload.assigned_to,
        payload.recurrence_rule,
        payload.created_by,
        anniversary.calendar_event_id,
      );
      return anniversary.calendar_event_id;
    }
  }

  const result = database.prepare(`
    INSERT INTO calendar_events
      (title, description, start_datetime, end_datetime, all_day, location, color,
       icon, assigned_to, created_by, recurrence_rule, external_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local')
  `).run(
    payload.title,
    payload.description,
    payload.start_datetime,
    payload.end_datetime,
    payload.all_day,
    payload.location,
    payload.color,
    payload.icon,
    payload.assigned_to,
    payload.created_by,
    payload.recurrence_rule,
  );

  database.prepare('UPDATE anniversaries SET calendar_event_id = ? WHERE id = ?')
    .run(result.lastInsertRowid, anniversary.id);
  return result.lastInsertRowid;
}

function syncAnniversaryReminder(database, anniversary, from = new Date()) {
  if (!anniversary.calendar_event_id) return null;

  if (anniversary.reminder_offset === '') {
    database.prepare(`
      DELETE FROM reminders
      WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
    `).run(anniversary.calendar_event_id, anniversary.created_by);
    return null;
  }

  const offsetMin = getOffsetMinutes(anniversary);
  const desired = anniversaryReminderAt(anniversary.anniversary_date, offsetMin, from);
  const existing = database.prepare(`
    SELECT * FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
    ORDER BY created_at DESC
  `).all(anniversary.calendar_event_id, anniversary.created_by);

  const active = existing.find((row) => row.dismissed === 0);
  if (active && active.remind_at === desired) return active.id;

  database.prepare(`
    DELETE FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
  `).run(anniversary.calendar_event_id, anniversary.created_by);

  const result = database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('event', ?, ?, ?)
  `).run(anniversary.calendar_event_id, desired, anniversary.created_by);

  return result.lastInsertRowid;
}

function syncAnniversaryArtifacts(database, anniversary, from = new Date()) {
  const calendarEventId = syncAnniversaryCalendarEvent(database, anniversary);
  const refreshed = { ...anniversary, calendar_event_id: calendarEventId };
  syncAnniversaryReminder(database, refreshed, from);
  return refreshed;
}

function deleteAnniversaryArtifacts(database, anniversary) {
  if (anniversary.calendar_event_id) {
    database.prepare(`
      DELETE FROM reminders
      WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
    `).run(anniversary.calendar_event_id, anniversary.created_by);
    deleteCalendarEvent(database, anniversary.calendar_event_id);
  }
}

function hydrateAnniversary(row, from = new Date()) {
  const next_date = nextAnniversaryDate(row.anniversary_date, from);
  return {
    ...row,
    next_date,
    years_until: yearsSince(row.anniversary_date, from),
    days_until: daysUntilAnniversary(row.anniversary_date, from),
  };
}

function syncAllAnniversaryReminders(database, userId, from = new Date()) {
  const rows = database.prepare(`
    SELECT * FROM anniversaries WHERE created_by = ? ORDER BY anniversary_date ASC
  `).all(userId);
  rows.forEach((row) => syncAnniversaryArtifacts(database, row, from));
}

export {
  ANNIVERSARY_COLOR,
  ANNIVERSARY_RRULE,
  anniversaryReminderAt,
  daysUntilAnniversary,
  deleteAnniversaryArtifacts,
  hydrateAnniversary,
  nextAnniversaryDate,
  syncAllAnniversaryReminders,
  syncAnniversaryArtifacts,
};
