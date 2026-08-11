// --------------------------------------------------------
// Formatierung ausgehender iCalendar-Werte.
// Von caldav-sync.js, apple-calendar.js und caldav-outbound.js geteilt.
// --------------------------------------------------------

/**
 * DB-Datumsstring (YYYY-MM-DDThh:mm oder ...hh:mm:ss[.ms][Z/±offset]) in das
 * RFC-5545-Basisformat (YYYYMMDDTHHmmss[Z/±hhmm]) bringen.
 *
 * parseTimeInput liefert HH:MM ohne Sekunden - ohne diese Normalisierung
 * empfangen Server wie mailbox.org HHMM (4 Stellen) statt HHMMSS (6) und fallen
 * auf 00:00 zurück (#246).
 */
export function toICSDatetime(dt) {
  if (!dt) return '';
  if (!dt.includes('T')) return dt.replace(/-/g, '') + 'T000000';
  const [datePart, rest] = dt.split('T');
  const dateStr = datePart.replace(/-/g, '');
  const m = rest.match(/^(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return `${dateStr}T000000`;
  const ss = m[3] || '00';
  const tz = (m[4] || '').replace(':', '');
  return `${dateStr}T${m[1]}${m[2]}${ss}${tz}`;
}

/** RFC 5545 §3.3.11: Backslash, Semikolon, Komma und Zeilenumbruch maskieren. */
export function escapeICSText(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}
