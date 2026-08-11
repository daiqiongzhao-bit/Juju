/**
 * Modul: Passwort-Hashing mit Unicode-Normalisierung
 * Zweck: Browser liefern Passwort-Eingaben unterschiedlich normalisiert aus
 *        (Firefox/macOS NFD, Safari/iOS NFC). bcrypt arbeitet auf Bytes, dadurch
 *        schlug der Login mit Umlauten je nach Browser fehl (Issue #608).
 *        Gehasht wird ab sofort immer NFC; `verifyPassword` akzeptiert zusätzlich
 *        die Rohform und NFD, damit vor dem Fix erzeugte Hashes gültig bleiben.
 * Abhängigkeiten: bcrypt
 */

import bcrypt from 'bcrypt';

export const BCRYPT_ROUNDS = 12;

/** Kanonische Form eines Passworts: NFC. */
export function normalizePassword(password) {
  return String(password ?? '').normalize('NFC');
}

/** Hasht ein Passwort in kanonischer NFC-Form. */
export function hashPassword(password, rounds = BCRYPT_ROUNDS) {
  return bcrypt.hash(normalizePassword(password), rounds);
}

/**
 * Prüft ein Passwort gegen einen bcrypt-Hash.
 *
 * Geprüft wird zuerst NFC, danach die unveränderte Eingabe und NFD. Die beiden
 * Legacy-Formen decken Hashes ab, die vor dem Fix aus einer nicht-normalisierten
 * Eingabe entstanden sind. `needsRehash` signalisiert dem Aufrufer, dass der
 * Hash transparent auf NFC migriert werden sollte.
 *
 * Es werden immer alle Kandidaten durchlaufen, wenn keiner passt - so kostet ein
 * Fehlversuch unabhängig vom Zustand des Kontos gleich viel Zeit.
 *
 * @returns {Promise<{ valid: boolean, needsRehash: boolean }>}
 */
export async function verifyPassword(password, hash) {
  const raw = String(password ?? '');
  const nfc = raw.normalize('NFC');
  const candidates = [nfc];
  for (const variant of [raw, raw.normalize('NFD')]) {
    if (!candidates.includes(variant)) candidates.push(variant);
  }

  for (const candidate of candidates) {
    if (await bcrypt.compare(candidate, hash)) {
      return { valid: true, needsRehash: candidate !== nfc };
    }
  }
  return { valid: false, needsRehash: false };
}
