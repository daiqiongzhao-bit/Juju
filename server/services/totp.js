/**
 * Modul: TOTP / 2FA (RFC 6238)
 * Zweck: Zwei-Faktor-Authentifizierung mit zeitbasierten Einmalcodes (TOTP).
 *
 * Kompatibilität: das Format ist bewusst der Industriestandard — dasselbe
 * Verfahren, das Google Authenticator, 1Password, Authy, Microsoft Authenticator
 * und Aegis verwenden. Ein hier erzeugtes Secret lässt sich also in jede dieser
 * Apps einscannen, und umgekehrt.
 *
 * Parameter (fest, weil die Apps keine anderen sinnvoll unterstützen):
 *   - HMAC-SHA1 (RFC 6238 Default; Google Authenticator akzeptiert nur dieses)
 *   - 6 Stellen, Zeitfenster 30 s, Toleranz ±1 Fenster (Uhr-Drift)
 *
 * Abhängigkeiten: node:crypto, server/utils/qrcode.js (QR ohne neue Dependency)
 */

import crypto from 'node:crypto';
import { qrSvg } from '../utils/qrcode.js';

/** Zeitfenster in Sekunden (RFC 6238 Default, von allen Apps erwartet). */
export const STEP_SECONDS = 30;

/** Anzahl Stellen des angezeigten Codes. */
export const DIGITS = 6;

/** Länge des Secrets in Bytes (160 Bit — von den Apps erwartet). */
const SECRET_BYTES = 20;

/** Wie viele Zeitfenster neben dem aktuellen noch akzeptiert werden. */
export const DEFAULT_WINDOW = 1;

/** Anzahl der Wiederherstellungscodes. */
export const RECOVERY_CODE_COUNT = 8;

/** RFC 4648 Base32-Alphabet (ohne Padding — so erwarten es die Apps). */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Umgekehrte Abbildung Zeichen → 5-Bit-Wert. */
const BASE32_LOOKUP = (() => {
  const map = new Map();
  for (let i = 0; i < BASE32_ALPHABET.length; i++) map.set(BASE32_ALPHABET[i], i);
  // Grosszügig beim Lesen: Kleinbuchstaben und die oft verwechselten Ziffern
  // 0/1/8 werden auf O/I/B abgebildet, damit ein abgetippter Code nicht an
  // einem Tippfehler scheitert. Geschrieben wird immer das kanonische Alphabet.
  map.set('0', BASE32_ALPHABET.indexOf('O'));
  map.set('1', BASE32_ALPHABET.indexOf('I'));
  map.set('8', BASE32_ALPHABET.indexOf('B'));
  return map;
})();

/**
 * Kodiert Bytes als Base32 (RFC 4648, ohne `=`-Padding).
 * @param {Buffer} buffer
 * @returns {string}
 */
export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/**
 * Dekodiert einen Base32-String (RFC 4648). Toleriert Kleinbuchstaben,
 * Leerzeichen, Bindestriche und `=`-Padding — alles, was beim manuellen
 * Eintippen eines Secrets passieren kann.
 * @param {string} input
 * @returns {Buffer}
 * @throws {Error} bei ungültigen Zeichen
 */
export function base32Decode(input) {
  const text = String(input ?? '').toUpperCase().replace(/[\s-]+/g, '').replace(/=+$/, '');
  if (!text) throw new Error('[TOTP] Secret is empty.');

  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of text) {
    const index = BASE32_LOOKUP.get(char);
    if (index === undefined) throw new Error(`[TOTP] Invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Erzeugt ein neues, kryptographisch zufälliges Secret (160 Bit).
 * @returns {string} Base32, 32 Zeichen
 */
export function generateSecret() {
  return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

/**
 * HOTP nach RFC 4226 — der Baustein, aus dem TOTP den Zeitfaktor macht.
 * @param {string} secretBase32 Base32-Secret
 * @param {number} counter 64-Bit-Zählerwert (als Number, Zeitfenster ≪ 2^32)
 * @returns {string} Code mit führenden Nullen
 */
export function hotp(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  message.writeUInt32BE(counter >>> 0, 4);

  const digest = crypto.createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const truncated =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  return String(truncated % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** Aktueller Zeitfenster-Zähler. */
function currentCounter(atMs = Date.now()) {
  return Math.floor(atMs / 1000 / STEP_SECONDS);
}

/**
 * Zeitunabhängiger String-Vergleich (kein vorzeitiges `return` bei Ungleichheit).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Bringt eine Nutzereingabe auf die reine Ziffernform („123 456" → „123456").
 * @param {unknown} input
 * @returns {string}
 */
export function normalizeCode(input) {
  return String(input ?? '').replace(/[\s-]/g, '');
}

/**
 * Prüft einen 6-stelligen TOTP-Code gegen ein Secret.
 *
 * Die Toleranz von ±1 Zeitfenster ist kein Luxus, sondern notwendig: die
 * Uhr des Telefons weicht typisch einige Sekunden ab, und ein Code wird
 * genau an der Fenstergrenze eingegeben.
 *
 * @param {string} secretBase32 Base32-Secret (Klartext, nicht das DB-Feld)
 * @param {unknown} code Eingabe des Nutzers
 * @param {{ window?: number, atMs?: number }} [opts]
 * @returns {boolean}
 */
export function verifyCode(secretBase32, code, opts = {}) {
  const { window = DEFAULT_WINDOW, atMs = Date.now() } = opts;
  const token = normalizeCode(code);
  if (!new RegExp(`^\\d{${DIGITS}}$`).test(token)) return false;
  if (!secretBase32) return false;

  const counter = currentCounter(atMs);
  let matched = false;
  for (let offset = -window; offset <= window; offset++) {
    // Kein `return` beim Treffer: immer alle Fenster durchlaufen, sonst verrät
    // die Antwortzeit, wie nah der Code am aktuellen Fenster lag.
    if (timingSafeEqual(hotp(secretBase32, counter + offset), token)) matched = true;
  }
  return matched;
}

/**
 * Baut die otpauth://-URI, die als QR-Code gescannt wird.
 * @param {{ secret: string, account: string, issuer?: string }} params
 * @returns {string}
 */
export function otpauthUri({ secret, account, issuer = 'Juju' }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(String(account || 'user'))}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

/**
 * Rendert eine otpauth://-URI als eigenständiges SVG (QR-Code).
 * @param {string} uri
 * @param {{ moduleSize?: number, margin?: number }} [opts]
 * @returns {string} SVG-Markup
 */
export function otpauthQrSvg(uri, opts = {}) {
  return qrSvg(uri, { moduleSize: 5, margin: 4, ...opts });
}

/**
 * Erzeugt `count` Wiederherstellungscodes im Format „ABCDE-12345".
 * Nur Grossbuchstaben und Ziffern — sie müssen telefonisch diktierbar und
 * fehlerfrei abtippbar sein, deshalb kein Base32 mit I/O-Verwechslung.
 * @param {number} [count]
 * @returns {string[]}
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

/**
 * Normalisiert die Eingabe eines Wiederherstellungscodes.
 * @param {unknown} input
 * @returns {string} Grossbuchstaben ohne Trennzeichen
 */
export function normalizeRecoveryCode(input) {
  return String(input ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * Verpackt frische Codes in die gespeicherte Struktur.
 * Gespeichert wird `{ code, used_at }` — „verbraucht" wird nicht gelöscht,
 * sondern markiert, damit der Nutzer in der UI sieht, was noch übrig ist.
 * @param {string[]} codes
 * @returns {string} JSON (vom Aufrufer per SM4 verschlüsselt)
 */
export function serializeRecoveryCodes(codes) {
  return JSON.stringify(codes.map((code) => ({ code, used_at: null })));
}

/**
 * Liest die gespeicherte Struktur. Unlesbares/altes Material wird zu `[]`
 * statt zu einem Fehler — ein kaputter Codespeicher darf den Login nicht
 * blockieren (der Nutzer kann dann immer noch Codes neu erzeugen).
 * @param {string|null} json
 * @returns {{ code: string, used_at: string|null }[]}
 */
export function parseRecoveryCodes(json) {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && typeof entry.code === 'string')
      .map((entry) => ({ code: entry.code, used_at: entry.used_at ?? null }));
  } catch {
    return [];
  }
}

/**
 * Sucht einen noch unbenutzten Wiederherstellungscode und markiert ihn als
 * verbraucht. Der Vergleich läuft über alle Einträge (ohne vorzeitigen Abbruch),
 * damit die Antwortzeit nicht verrät, an welcher Stelle der Code stand.
 *
 * @param {{ code: string, used_at: string|null }[]} entries
 * @param {unknown} input Nutzereingabe
 * @returns {{ matched: boolean, entries: { code: string, used_at: string|null }[] }}
 */
export function consumeRecoveryCode(entries, input) {
  const candidate = normalizeRecoveryCode(input);
  if (!candidate) return { matched: false, entries };

  let matched = false;
  const next = entries.map((entry) => {
    if (entry.used_at) return entry;
    if (timingSafeEqual(normalizeRecoveryCode(entry.code), candidate)) {
      matched = true;
      return { ...entry, used_at: new Date().toISOString() };
    }
    return entry;
  });
  return { matched, entries: next };
}

/**
 * Zählt die noch verfügbaren Wiederherstellungscodes.
 * @param {{ code: string, used_at: string|null }[]} entries
 * @returns {number}
 */
export function remainingRecoveryCodes(entries) {
  return entries.filter((entry) => !entry.used_at).length;
}
