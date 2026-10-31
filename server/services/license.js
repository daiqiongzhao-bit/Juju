/**
 * Lizenz-/Aktivierungssystem (License key activation) für juju / yuvomi.
 *
 * Design-Prinzipien:
 *  - Standardmäßig OFFEN: Ist JUJU_LICENSE_MASTER nicht gesetzt, gilt die
 *    Instanz als lizenziert ("Community"-Modus). Bestehende Self-Host-Deploys
 *    (wie das des Autors) werden NICHT beeinträchtigt — kein Key nötig.
 *  - Nur wenn der Betreiber JUJU_LICENSE_MASTER setzt, wird die Aktivierung
 *    erzwungen. Er verteilt dann per `scripts/gen-license.js` HMAC-signierte
 *    Keys an Dritte.
 *  - Keys sind HMAC-SHA256-signiert (Node-Builtin crypto), keine externe
 *    Abhängigkeit. Fälschungssicher, aber offline prüfbar.
 *
 * Key-Format:  JUJU1-<base64url(payload)>-<base64url(hmac)>
 */

import crypto from 'node:crypto';

const PREFIX = 'JUJU1';

export function getMasterKey() {
  const k = String(process.env.JUJU_LICENSE_MASTER || '').trim();
  return k || null;
}

// ---- reine Krypto-Funktionen (KEIN DB-Zugriff → vom CLI nutzbar) ----

/**
 * Signiert ein Payload-Objekt und liefert einen License-Key.
 * @param {object} payload - { sub, dev, iat, exp } (exp=0 => nie ablaufend)
 * @param {string} master - Master-Key (Server-seitig, nicht im Key enthalten)
 */
export function signLicense(payload, master) {
  const m = String(master || '').trim();
  if (!m) throw new Error('master key required');
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', m).update(body).digest('base64url');
  // ACHTUNG: base64url enthält selbst das Zeichen '-', daher als Trenner '.'
  // (base64url enthält kein '.'), sonst zerlegt split('-') body/sig fälschlich.
  return `${PREFIX}.${body}.${sig}`;
}

/**
 * Prüft die Signatur eines Keys gegen den Master-Key.
 * @returns {{valid:boolean, error?:string, payload?:object}}
 */
export function verifyLicense(key, master) {
  const m = String(master || '').trim();
  if (!m) return { valid: false, error: 'no-master' };
  const parts = String(key || '').trim().split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return { valid: false, error: 'bad-format' };
  const [, body, sig] = parts;
  const expected = crypto.createHmac('sha256', m).update(body).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, error: 'bad-signature' };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, error: 'bad-payload' };
  }
  if (payload?.exp && Date.now() > payload.exp) {
    return { valid: false, error: 'expired', payload };
  }
  return { valid: true, payload };
}

// ---- DB-gebundene Funktionen (nur Server-Kontext) ----

async function getDb() {
  const mod = await import('../db.js');
  return mod.get();
}

export async function loadState() {
  try {
    const db = await getDb();
    return db.prepare('SELECT * FROM license_state WHERE id = 1').get() || null;
  } catch {
    return null;
  }
}

async function saveState({ status, licenseKey, payloadJson, activatedAt }) {
  const db = await getDb();
  db.prepare(`
    INSERT INTO license_state (id, status, license_key, payload_json, activated_at)
    VALUES (1, @status, @licenseKey, @payloadJson, @activatedAt)
    ON CONFLICT(id) DO UPDATE SET
      status        = excluded.status,
      license_key   = excluded.license_key,
      payload_json  = excluded.payload_json,
      activated_at  = excluded.activated_at
  `).run({ status, licenseKey, payloadJson, activatedAt });
}

/**
 * Aktiviert die Instanz mit einem Key. Wirft nicht — liefert { ok, code, message }.
 */
export async function activate(rawKey) {
  const master = getMasterKey();
  if (!master) {
    return { ok: false, code: 'no-enforcement', message: 'License enforcement is not enabled on this server.' };
  }
  const key = String(rawKey || '').trim();
  if (!key) return { ok: false, code: 'empty', message: 'License key is required.' };
  const v = verifyLicense(key, master);
  if (!v.valid) {
    return { ok: false, code: v.error, message: humanError(v.error) };
  }
  await saveState({
    status: 'active',
    licenseKey: key,
    payloadJson: JSON.stringify(v.payload),
    activatedAt: new Date().toISOString(),
  });
  return { ok: true, payload: v.payload };
}

/**
 * Liefert den Lizenzstatus. Kern-Logik für den Guard-Middleware.
 *  - Kein Master gesetzt → community, lizenziert (kein Zugriffsschutz).
 *  - Master gesetzt, nicht aktiviert → nicht lizenziert.
 *  - Master gesetzt, aktiviert, ggf. abgelaufen → entsprechend.
 */
export async function status() {
  const master = getMasterKey();
  if (!master) {
    return { mode: 'community', licensed: true, reason: null, enforcementEnabled: false };
  }
  const st = await loadState();
  if (!st || st.status !== 'active') {
    return { mode: 'enforced', licensed: false, reason: 'not-activated', enforcementEnabled: true };
  }
  let payload = null;
  try { payload = JSON.parse(st.payload_json); } catch { /* ignore */ }
  if (payload?.exp && Date.now() > payload.exp) {
    return { mode: 'enforced', licensed: false, reason: 'expired', enforcementEnabled: true, payload };
  }
  return { mode: 'enforced', licensed: true, reason: null, enforcementEnabled: true, payload, activatedAt: st.activated_at };
}

export function humanError(code) {
  switch (code) {
    case 'bad-format': return 'License key format is invalid.';
    case 'bad-signature': return 'License key signature is invalid (not issued by this server).';
    case 'bad-payload': return 'License key payload is corrupted.';
    case 'expired': return 'License key has expired.';
    case 'no-master': return 'This server has no license master configured.';
    default: return 'License key could not be verified.';
  }
}
