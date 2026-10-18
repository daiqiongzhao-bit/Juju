/**
 * Modul: Zwei-Faktor-Authentifizierung (2FA / TOTP) — Routen
 * Zweck: Selbstbedienung im Sicherheitsbereich der Einstellungen plus der
 *        zweite Schritt des Logins für Konten mit aktivierter 2FA.
 *
 * Ablauf beim Einschalten (zwei Schritte, damit kein halb eingerichtetes Konto
 * entsteht, wenn die App den QR-Code nicht scannen kann):
 *   1. POST /setup   → Secret erzeugen, verschlüsselt ablegen, QR-Code zeigen.
 *                      Das Konto bleibt weiterhin OHNE 2FA.
 *   2. POST /enable  → ein gültiger Code beweist, dass die App das Secret
 *                      wirklich kennt. Erst jetzt wird 2FA aktiv und die
 *                      Wiederherstellungscodes ausgegeben.
 *
 * Speicherung (Vorgabe): Secret und Wiederherstellungscodes liegen SM4-
 * verschlüsselt in der Datenbank (server/services/sm4.js, Schlüssel aus
 * JUJU_SM4_KEY). Klartexte verlassen nie die Datenbank-Schicht — die Codes
 * werden genau EINMAL ausgegeben und danach nur noch als „verbraucht/übrig"
 * gezählt.
 *
 * Session-Mechanik: der Login setzt bei 2FA-Konten eine „pending"-Session.
 * Deren Rechte sind in server/auth.js (requireAuth) auf die 2FA-Endpunkte,
 * /auth/me und /auth/logout beschränkt — die bestehende Session- und
 * CSRF-Mechanik bleibt unverändert, es kommt nur ein Zustand hinzu.
 *
 * Abhängigkeiten: express, express-rate-limit, server/db.js,
 *                 server/services/totp.js, server/services/sm4.js,
 *                 server/utils/password.js
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import * as db from '../db.js';
import * as totp from '../services/totp.js';
import { encryptField, decryptField } from '../services/sm4.js';
import { verifyPassword } from '../utils/password.js';
import { setupAuthSession } from '../auth.js';
import { clientPermissions } from '../permissions.js';
import { createLogger } from '../logger.js';

const router = express.Router();
const log = createLogger('TwoFactor');

/**
 * Eigener Limiter: ein 6-stelliger Code hat nur eine Million Kombinationen,
 * und ein Konto mit 2FA ist genau das, was ein Angreifier will. Der Limiter
 * zählt ALLE Antworten (kein skipSuccessfulRequests), weil auch ein
 * „falscher Code" ein gültiger Versuch ist.
 */
const twoFactorLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000,
  max: parseInt(process.env.RATE_LIMIT_MAX_ATTEMPTS, 10) || 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a moment.', code: 429, reason: 'rate_limited' },
});

/** Ausgabe-Name der App im Authenticator (steht auch in der otpauth-URI). */
const DEFAULT_ISSUER = 'Juju';

// --------------------------------------------------------
// Datenbank-Helfer
// --------------------------------------------------------

/**
 * Liest die 2FA-relevanten Spalten eines Nutzers.
 * @param {number} userId
 * @returns {object|null}
 */
function loadUser(userId) {
  try {
    return db.get()
      .prepare(`
        SELECT id, username, display_name, avatar_color, avatar_data, role, family_role,
               password_hash, totp_secret, totp_enabled, totp_enabled_at, totp_recovery_codes
        FROM users WHERE id = ?
      `)
      .get(userId) ?? null;
  } catch (err) {
    // Spalten fehlen (Migration noch nicht gelaufen): kein 2FA möglich, aber
    // auch kein 500er im Einstellungsdialog.
    log.error('2FA columns not readable:', err?.message || err);
    return null;
  }
}

/**
 * Entschlüsselt das TOTP-Secret. Werte ohne `v1.`-Präfix sind kein gültiges
 * Secret (Altlast oder beschädigt) und werden wie „nicht eingerichtet"
 * behandelt — sonst würde jeder Login an einem kaputten Feld scheitern.
 * @param {object} user
 * @returns {string|null}
 */
function readSecret(user) {
  const raw = user?.totp_secret;
  if (!raw) return null;
  if (!String(raw).startsWith('v1.')) return null;
  const plain = decryptField(raw);
  if (!plain || !String(plain).startsWith('v1.')) return plain || null;
  return null; // Entschlüsselung fehlgeschlagen (decryptField gibt dann den Wert zurück)
}

/**
 * Entschlüsselt und parst die Wiederherstellungscodes.
 * @param {object} user
 * @returns {{ code: string, used_at: string|null }[]}
 */
function readRecoveryCodes(user) {
  const raw = user?.totp_recovery_codes;
  if (!raw) return [];
  if (!String(raw).startsWith('v1.')) return [];
  const plain = decryptField(raw);
  if (!plain || String(plain).startsWith('v1.')) return [];
  return totp.parseRecoveryCodes(plain);
}

/**
 * Prüft einen Code gegen Secret ODER Wiederherstellungscodes.
 * Wird beim Login und beim Abschalten benutzt.
 *
 * @param {object} user
 * @param {unknown} code
 * @returns {{ ok: boolean, viaRecovery: boolean, entries: { code: string, used_at: string|null }[]|null }}
 */
function checkAnyCode(user, code) {
  const secret = readSecret(user);
  const entries = readRecoveryCodes(user);

  if (secret && totp.verifyCode(secret, code)) {
    return { ok: true, viaRecovery: false, entries };
  }

  const consumed = totp.consumeRecoveryCode(entries, code);
  if (consumed.matched) {
    return { ok: true, viaRecovery: true, entries: consumed.entries };
  }
  return { ok: false, viaRecovery: false, entries };
}

/**
 * Baut denselben Nutzer-Block wie POST /auth/login, damit das Frontend nach
 * dem zweiten Faktor genau dieselbe Antwort erhält wie ohne 2FA.
 * @param {object} user
 * @returns {object}
 */
function publicLoginUser(user) {
  const guest = db.get()
    .prepare('SELECT 1 FROM split_expense_guest_users WHERE user_id = ?')
    .get(user.id);
  return {
    id:           user.id,
    username:     user.username,
    display_name: user.display_name,
    avatar_color: user.avatar_color,
    avatar_data:  user.avatar_data,
    role:         user.role,
    family_role:  user.family_role,
    access_scope: guest ? 'split_guest' : 'family',
  };
}

/** Einheitliche Fehlerantwort mit maschinenlesbarem `reason`. */
function fail(res, status, error, reason) {
  return res.status(status).json({ error, code: status, reason });
}

// --------------------------------------------------------
// Selbstbedienung (Einstellungen → Sicherheit)
// --------------------------------------------------------

/**
 * GET /api/v1/auth/2fa/status
 * Status des eigenen Kontos. Erreichbar auch in der „pending"-Session, damit
 * die Login-Seite nach einem Reload erkennt, dass sie den Code-Schritt zeigen
 * muss.
 */
router.get('/status', (req, res) => {
  const user = loadUser(req.authUserId);
  if (!user) return fail(res, 404, 'User not found.', 'user_not_found');

  const enabled = Number(user.totp_enabled) === 1;
  const entries = readRecoveryCodes(user);
  res.json({
    data: {
      enabled,
      enabled_at: user.totp_enabled_at ?? null,
      // Es liegt ein Secret, aber 2FA ist noch nicht aktiv → Schritt 2 fehlt.
      has_pending_setup: !enabled && readSecret(user) !== null,
      recovery_codes_remaining: enabled ? totp.remainingRecoveryCodes(entries) : 0,
      // „pending" = Passwort stimmte, zweiter Faktor fehlt noch.
      two_factor_pending: Boolean(req.session?.pending2fa),
    },
  });
});

/**
 * POST /api/v1/auth/2fa/setup
 * Startet die Einrichtung: neues Secret, otpauth-URI und QR-Code als SVG.
 * Body: { password } — das eigene Passwort verlangt, damit ein unbemerkt
 * geöffneter Browser-Tab kein 2FA-Setup auslösen kann.
 */
router.post('/setup', async (req, res) => {
  try {
    const user = loadUser(req.authUserId);
    if (!user) return fail(res, 404, 'User not found.', 'user_not_found');

    if (Number(user.totp_enabled) === 1) {
      return fail(res, 409, 'Two-factor authentication is already enabled.', 'already_enabled');
    }

    const { password } = req.body ?? {};
    if (!password) return fail(res, 400, 'Your password is required.', 'password_required');
    const { valid } = await verifyPassword(String(password), user.password_hash);
    if (!valid) return fail(res, 401, 'Invalid password.', 'invalid_password');

    const secret = totp.generateSecret();
    const uri = totp.otpauthUri({ secret, account: user.username, issuer: DEFAULT_ISSUER });

    db.get()
      .prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0, totp_enabled_at = NULL, totp_recovery_codes = NULL WHERE id = ?')
      .run(encryptField(secret), user.id);

    log.info('2FA setup started', { userId: user.id });
    res.json({
      data: {
        secret,
        otpauth_uri: uri,
        // Serverseitig gerendert (server/utils/qrcode.js) — keine externe
        // Abhängigkeit und keine fremde Anfrage für den QR-Code.
        qr_svg: totp.otpauthQrSvg(uri),
        issuer: DEFAULT_ISSUER,
      },
    });
  } catch (err) {
    log.error('2FA setup failed:', err?.message || err);
    res.status(500).json({ error: '2FA setup failed.', code: 500, reason: 'internal_error' });
  }
});

/**
 * POST /api/v1/auth/2fa/enable
 * Schaltet 2FA scharf und gibt acht Wiederherstellungscodes aus (einmalig).
 * Body: { code }
 */
router.post('/enable', twoFactorLimiter, async (req, res) => {
  try {
    const user = loadUser(req.authUserId);
    if (!user) return fail(res, 404, 'User not found.', 'user_not_found');
    if (Number(user.totp_enabled) === 1) {
      return fail(res, 409, 'Two-factor authentication is already enabled.', 'already_enabled');
    }

    const secret = readSecret(user);
    if (!secret) return fail(res, 409, 'Start the setup first.', 'setup_required');

    const { code } = req.body ?? {};
    if (!totp.verifyCode(secret, code)) {
      return fail(res, 400, 'Invalid verification code.', 'invalid_code');
    }

    const recoveryCodes = totp.generateRecoveryCodes();
    db.get()
      .prepare('UPDATE users SET totp_enabled = 1, totp_enabled_at = ?, totp_recovery_codes = ? WHERE id = ?')
      .run(new Date().toISOString(), encryptField(totp.serializeRecoveryCodes(recoveryCodes)), user.id);

    log.info('2FA enabled', { userId: user.id });
    // Nur hier, direkt nach der Erzeugung: danach sind die Codes nie wieder
    // im Klartext abrufbar.
    res.json({ data: { enabled: true, recovery_codes: recoveryCodes } });
  } catch (err) {
    log.error('2FA enable failed:', err?.message || err);
    res.status(500).json({ error: '2FA could not be enabled.', code: 500, reason: 'internal_error' });
  }
});

/**
 * POST /api/v1/auth/2fa/disable
 * Schaltet 2FA ab und verwirft Secret sowie Codes.
 * Body: { password, code }
 */
router.post('/disable', twoFactorLimiter, async (req, res) => {
  try {
    const user = loadUser(req.authUserId);
    if (!user) return fail(res, 404, 'User not found.', 'user_not_found');
    if (Number(user.totp_enabled) !== 1) {
      return fail(res, 409, 'Two-factor authentication is not enabled.', 'not_enabled');
    }

    const { password, code } = req.body ?? {};
    if (!password) return fail(res, 400, 'Your password is required.', 'password_required');
    const { valid } = await verifyPassword(String(password), user.password_hash);
    if (!valid) return fail(res, 401, 'Invalid password.', 'invalid_password');

    const result = checkAnyCode(user, code);
    if (!result.ok) return fail(res, 400, 'Invalid verification code.', 'invalid_code');

    db.get()
      .prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_enabled_at = NULL, totp_recovery_codes = NULL WHERE id = ?')
      .run(user.id);

    log.info('2FA disabled', { userId: user.id });
    res.json({ data: { enabled: false } });
  } catch (err) {
    log.error('2FA disable failed:', err?.message || err);
    res.status(500).json({ error: '2FA could not be disabled.', code: 500, reason: 'internal_error' });
  }
});

/**
 * POST /api/v1/auth/2fa/recovery-codes
 * Erzeugt acht frische Wiederherstellungscodes (die alten werden verworfen).
 * Body: { code }
 */
router.post('/recovery-codes', twoFactorLimiter, async (req, res) => {
  try {
    const user = loadUser(req.authUserId);
    if (!user) return fail(res, 404, 'User not found.', 'user_not_found');
    if (Number(user.totp_enabled) !== 1) {
      return fail(res, 409, 'Two-factor authentication is not enabled.', 'not_enabled');
    }

    const { code } = req.body ?? {};
    const result = checkAnyCode(user, code);
    if (!result.ok) return fail(res, 400, 'Invalid verification code.', 'invalid_code');

    const recoveryCodes = totp.generateRecoveryCodes();
    db.get()
      .prepare('UPDATE users SET totp_recovery_codes = ? WHERE id = ?')
      .run(encryptField(totp.serializeRecoveryCodes(recoveryCodes)), user.id);

    log.info('2FA recovery codes regenerated', { userId: user.id });
    res.json({ data: { recovery_codes: recoveryCodes } });
  } catch (err) {
    log.error('2FA recovery code reset failed:', err?.message || err);
    res.status(500).json({ error: 'Recovery codes could not be regenerated.', code: 500, reason: 'internal_error' });
  }
});

// --------------------------------------------------------
// Zweiter Schritt des Logins
// --------------------------------------------------------

/**
 * POST /api/v1/auth/2fa/verify
 * Vervollständigt den Login aus der „pending"-Session heraus.
 * Body: { code } — 6-stelliger TOTP-Code oder ein Wiederherstellungscode.
 */
router.post('/verify', twoFactorLimiter, async (req, res) => {
  try {
    if (!req.session?.pending2fa) {
      // Kein pending-Zustand: der Nutzer ist schon vollständig angemeldet.
      return fail(res, 409, 'No two-factor challenge is pending.', 'not_pending');
    }

    const user = loadUser(req.authUserId);
    if (!user) return fail(res, 404, 'User not found.', 'user_not_found');

    const { code } = req.body ?? {};

    // 2FA inzwischen abgeschaltet: der pending-Zustand ist damit erledigt.
    if (Number(user.totp_enabled) !== 1) {
      delete req.session.pending2fa;
      delete req.session.pending2faSince;
      return res.json({
        user: publicLoginUser(user),
        permissions: clientPermissions(db.get(), user),
        csrfToken: req.session.csrfToken,
      });
    }

    const result = checkAnyCode(user, code);
    if (!result.ok) {
      log.warn('2FA login failed', { userId: user.id, ip: req.ip });
      return fail(res, 401, 'Invalid verification code.', 'invalid_code');
    }

    // Verbrauchte Wiederherstellungscodes zurückschreiben („nur einmal gültig").
    if (result.viaRecovery && result.entries) {
      db.get()
        .prepare('UPDATE users SET totp_recovery_codes = ? WHERE id = ?')
        .run(encryptField(JSON.stringify(result.entries)), user.id);
    }

    // Session vollwertig machen: neuer CSRF-Token, kein pending mehr. Die sid
    // bleibt bewusst dieselbe (kein regenerate), damit das Cookie, das der
    // Browser schon hat, weitergilt.
    delete req.session.pending2fa;
    delete req.session.pending2faSince;
    await setupAuthSession(req, res, user);

    log.info('2FA login verified', { userId: user.id, viaRecovery: result.viaRecovery });
    res.json({
      user: publicLoginUser(user),
      permissions: clientPermissions(db.get(), user),
      csrfToken: req.session.csrfToken,
    });
  } catch (err) {
    log.error('2FA verification failed:', err?.message || err);
    res.status(500).json({ error: 'Verification failed.', code: 500, reason: 'internal_error' });
  }
});

export default router;
