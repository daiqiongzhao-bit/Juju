/**
 * Modul: Sicherungspaket (Backup Bundle)
 * Zweck: Eine Datensicherung besteht seit 0.0.28 aus ZWEI Teilen: der
 *        verschlüsselten Datenbank und der Schlüsseldatei `/data/.juju-secrets`.
 *        Fehlt der zweite Teil, ist die Datenbank nach einem Restore dauerhaft
 *        unlesbar — das Backup wäre also wertlos, genau dann, wenn man es
 *        braucht. Dieses Modul fasst beide Teile zu einem Paket zusammen.
 *
 * Format: ein ZIP-Container (Store, keine Kompression — die DB ist ohnehin
 * verschlüsselt und damit nicht komprimierbar) mit genau zwei Einträgen:
 *   - `juju.db`          die Datenbank (wie bisher per VACUUM INTO erzeugt)
 *   - `.juju-secrets`    die Schlüsseldatei, Modus 0600 im Paket
 *
 * Warum kein eigenes Format: ZIP lässt sich mit Bordmitteln jedes Betriebssystems
 * öffnen (`unzip`), wenn jemand im Notfall manuell an die Datenbank muss. Und
 * der Container entsteht mit server/utils/zip.js — ohne neue Abhängigkeit.
 *
 * Abhängigkeiten: node:fs/promises, node:os, node:path, server/db.js,
 *                 server/utils/zip.js, server/services/backup-secrets.js
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backupToFile } from '../db.js';
import { createZip, readZip, isZip } from '../utils/zip.js';
import * as secrets from './backup-secrets.js';
import { createLogger } from '../logger.js';

const log = createLogger('BackupBundle');

/** Name des Datenbank-Eintrags im Paket. */
export const DB_ENTRY_NAME = 'juju.db';

/** Name des Schlüsseldatei-Eintrags im Paket (wieder aus backup-secrets.js). */
export const SECRETS_ENTRY_NAME = secrets.SECRETS_ENTRY_NAME;

/**
 * Erzeugt ein vollständiges Sicherungspaket am Zielpfad.
 *
 * Die Datenbank wird in ein temporäres Verzeichnis gesichert und von dort ins
 * Archiv geschoben — so liegt nie ein halbfertiges Paket im Backup-Verzeichnis.
 *
 * @param {string} destinationPath Absoluter Zielpfad (wird überschrieben)
 * @returns {Promise<{ path: string, size: number, dbBytes: number, secretsIncluded: boolean }>}
 */
export async function createBundle(destinationPath) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'juju-bundle-'));
  const dbSnapshot = path.join(workDir, DB_ENTRY_NAME);
  let tempZip = null;

  try {
    await backupToFile(dbSnapshot);
    const dbData = await fs.readFile(dbSnapshot);

    const entries = [{ name: DB_ENTRY_NAME, data: dbData, mode: 0o100644 }];

    // Die Schlüsseldatei nur mitnehmen, wenn sie existiert und gelesen werden
    // kann. Schlägt das fehl, wird das Paket TROTZDEM geschrieben — ein Backup
    // ohne Schlüssel ist besser als gar keins — aber der Scheduler protokolliert
    // es und die Oberfläche zeigt es an.
    let secretsIncluded = false;
    try {
      const secretsData = await secrets.readSecretsBuffer();
      if (secretsData.length > 0) {
        const check = secrets.validateSecretsContent(secretsData);
        if (!check.ok) {
          log.warn(`Secrets file not added to bundle: ${check.error}`);
        } else {
          entries.push({ name: SECRETS_ENTRY_NAME, data: secretsData, mode: 0o100600 });
          secretsIncluded = true;
        }
      }
    } catch (err) {
      log.warn('Secrets file could not be read for bundling:', err?.message || err);
    }

    const archive = createZip(entries);

    // Atomar ablegen: erst tmp im Zielverzeichnis, dann rename. Ein unterbrochener
    // Lauf hinterlässt so kein Paket, das der Rotationslauf fälschlich zählt.
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    tempZip = `${destinationPath}.partial-${process.pid}`;
    await fs.writeFile(tempZip, archive, { mode: 0o600 });
    await fs.chmod(tempZip, 0o600);
    await fs.rename(tempZip, destinationPath);
    tempZip = null;

    return {
      path: destinationPath,
      size: archive.length,
      dbBytes: dbData.length,
      secretsIncluded,
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    if (tempZip) await fs.rm(tempZip, { force: true }).catch(() => {});
  }
}

/**
 * Prüft, ob ein hochgeladener Puffer ein Sicherungspaket ist.
 * @param {Buffer} buffer
 * @returns {boolean}
 */
export function isBundle(buffer) {
  return isZip(buffer);
}

/**
 * Zerlegt ein Sicherungspaket.
 *
 * @param {Buffer} buffer
 * @returns {{ db: Buffer, secrets: Buffer|null, secretsError: string|null, entries: string[] }}
 * @throws {Error} wenn das Paket beschädigt ist oder die Datenbank fehlt
 */
export function parseBundle(buffer) {
  const entries = readZip(buffer);
  const names = entries.map((entry) => entry.name);

  const dbEntry = entries.find((entry) => entry.name === DB_ENTRY_NAME);
  if (!dbEntry) {
    throw new Error(
      'This archive is not a Juju backup bundle (juju.db is missing). ' +
      `Found: ${names.join(', ') || 'nothing'}.`
    );
  }

  const secretsEntry = entries.find((entry) => entry.name === SECRETS_ENTRY_NAME) ?? null;
  let secretsError = null;
  if (secretsEntry) {
    const check = secrets.validateSecretsContent(secretsEntry.data);
    if (!check.ok) secretsError = check.error;
  }

  return {
    db: dbEntry.data,
    secrets: secretsEntry ? secretsEntry.data : null,
    secretsError,
    entries: names,
  };
}

export default { createBundle, parseBundle, isBundle, DB_ENTRY_NAME, SECRETS_ENTRY_NAME };
