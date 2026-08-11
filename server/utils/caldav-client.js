// --------------------------------------------------------
// tsdav-Client für ein caldav_accounts-Konto.
//
// Termine (caldav-sync.js), VTODO-Inbound (caldav-reminders-sync.js) und der
// VTODO-Outbound (caldav-todo-outbound.js) sprechen denselben Server mit
// denselben Zugangsdaten an; die Factory lag dreimal wortgleich herum. tsdav wird
// bewusst dynamisch geladen: der Import zieht spürbar Code nach, und wer keinen
// CalDAV-Account eingerichtet hat, soll ihn nie laden.
// --------------------------------------------------------

/**
 * @param {{caldav_url: string, username: string, password: string}} account
 * @returns {Promise<object>} tsdav-Client
 */
export async function createCalDAVClient(account) {
  const { createDAVClient } = await import('tsdav');
  return createDAVClient({
    serverUrl:          account.caldav_url,
    credentials:        { username: account.username, password: account.password },
    authMethod:         'Basic',
    defaultAccountType: 'caldav',
  });
}

/**
 * Trägt eine Collection die gesuchte iCalendar-Komponente?
 *
 * `supported-calendar-component-set` ist laut RFC 4791 §5.2.3 optional: fehlt die
 * Property, muss der Client alle Komponenten annehmen. tsdav liefert dann ein
 * leeres `components`-Array - wer darauf strikt filtert, blendet auf solchen
 * Servern jede Collection aus. Die Regel steht hier einmal, weil Termine und
 * Aufgaben sie spiegelbildlich brauchen und sie vorher auf der einen Seite fehlte
 * (Aufgabenlisten landeten in der Kalenderauswahl) und auf der anderen zu streng
 * war (#617).
 *
 * @param {{components?: string[]}} cal  Collection aus `fetchCalendars()`
 * @param {string} component            'VEVENT' | 'VTODO'
 */
export function supportsComponent(cal, component) {
  const comps = Array.isArray(cal?.components) ? cal.components : [];
  if (comps.length === 0) return true;
  return comps.map(c => String(c).toUpperCase()).includes(String(component).toUpperCase());
}

/**
 * Collection-URL eines Kalenderobjekts: alles bis zum letzten Segment.
 * CalDAV-Objekte liegen unmittelbar in ihrer Collection, deshalb ist der Pfad
 * ohne Dateinamen die Liste, zu der das Objekt gehört. Nötig, weil tsdav ein
 * Objekt nur innerhalb seiner Collection adressiert, Aufgaben und Einkaufsposten
 * aber nur ihre Objekt-URL tragen.
 */
export function collectionUrlOf(objectUrl) {
  const url = String(objectUrl || '');
  const cut = url.lastIndexOf('/');
  return cut === -1 ? null : url.slice(0, cut + 1);
}
