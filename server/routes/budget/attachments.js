/**
 * Modul: Budget-Tracker - Belege
 * Zweck: Verknuepfung zwischen Buchungen und Dokumenten aus dem Dokumente-Modul (#583).
 *
 * Ein Beleg ist immer ein Dokument in family_documents - das Budget speichert
 * keine Dateien selbst. Damit gilt fuer Belege dieselbe Sichtbarkeit wie im
 * Dokumente-Modul, und ein Beleg bleibt dort auffindbar, auch wenn die Buchung
 * geloescht wird.
 *
 * Die Mechanik steckt in services/document-links.js und wird mit den geteilten
 * Ausgaben geteilt; hier stehen nur die Tabellennamen dieses Moduls.
 */

import * as db from '../../db.js';
import { documentLinksFor, loadDocumentLinks, replaceDocumentLinks } from '../../services/document-links.js';

const TABLE = { table: 'budget_entry_attachments', ownerColumn: 'entry_id' };

/**
 * Belege einer einzelnen Buchung.
 * @param {number} entryId
 * @param {number} userId
 * @returns {object[]}
 */
export function attachmentsFor(entryId, userId) {
  return documentLinksFor(db.get(), { ...TABLE, ownerId: entryId, userId });
}

/**
 * Haengt die Belege an eine Eintragsliste an (fuer GET-Antworten).
 * @param {object[]} entries
 * @param {number} userId
 * @returns {object[]} dieselben Eintraege, jeweils mit `attachments`
 */
export function withAttachments(entries, userId) {
  const byEntry = loadDocumentLinks(db.get(), { ...TABLE, ownerIds: entries.map((e) => e.id), userId });
  return entries.map((entry) => ({ ...entry, attachments: byEntry.get(entry.id) || [] }));
}

/**
 * Setzt die Belege einer Buchung auf die uebergebene Dokumentenliste.
 * @param {number} entryId
 * @param {any} rawDocumentIds - Rohwert aus dem Request-Body
 * @param {number} userId
 */
export function replaceAttachments(entryId, rawDocumentIds, userId) {
  replaceDocumentLinks(db.get(), { ...TABLE, ownerId: entryId, documentIds: rawDocumentIds, userId });
}
