/**
 * Modul: Email-Service (SMTP)
 * Zweck: SMTP-Konfiguration aus sync_config (env-überschreibbar) auflösen und
 *        Mails über nodemailer versenden. Wird vom Forgot-Password-Flow und der
 *        Admin-Test-Route genutzt.
 * Abhängigkeiten: nodemailer, server/db.js
 */
import nodemailerDefault from 'nodemailer';
import * as dbModule from '../db.js';
import { createLogger } from '../logger.js';

const log = createLogger('Email');

const CONFIG_KEYS = {
  host:        { key: 'email_smtp_host',    env: 'EMAIL_SMTP_HOST' },
  port:        { key: 'email_smtp_port',    env: 'EMAIL_SMTP_PORT' },
  secure:      { key: 'email_smtp_secure',  env: 'EMAIL_SMTP_SECURE' },
  user:        { key: 'email_smtp_user',    env: 'EMAIL_SMTP_USER' },
  pass:        { key: 'email_smtp_pass',    env: 'EMAIL_SMTP_PASS' },
  fromAddress: { key: 'email_from_address', env: 'EMAIL_FROM_ADDRESS' },
  fromName:    { key: 'email_from_name',    env: 'EMAIL_FROM_NAME' },
};

const VALID_SECURE = new Set(['ssl', 'starttls', 'none']);

export function createEmailService({ db, nodemailer = nodemailerDefault, env = process.env } = {}) {
  const getDb = () => (db || dbModule.get());

  function cfgGet(key) {
    const row = getDb().prepare('SELECT value FROM sync_config WHERE key = ?').get(key);
    return row?.value ?? null;
  }

  // env (non-empty) wins over DB, mirroring ensureVapid() in services/push.js.
  function resolve(field) {
    const { key, env: envName } = CONFIG_KEYS[field];
    const fromEnv = env[envName];
    if (fromEnv !== undefined && String(fromEnv).trim() !== '') {
      // Getrimmt wird geprüft, zurückgegeben aber nur, wo Trimmen unschädlich
      // ist. Ein Passwort darf mit einem Leerzeichen anfangen oder enden; wer
      // es abschneidet, macht aus einer gültigen Zugangsdatei eine ungültige,
      // und das fällt erst beim ersten Versandversuch auf. Bei Host, Port und
      // den Adressfeldern ist ein versehentliches Leerzeichen dagegen der
      // wahrscheinlichere Fall, dort hilft das Trimmen.
      return field === 'pass' ? String(fromEnv) : String(fromEnv).trim();
    }
    return cfgGet(key);
  }

  /**
   * Steht dieses Feld unter env-Kontrolle? Der Vorrang oben galt schon immer,
   * aber die Settings-Seite wusste nichts davon: sie zeigte Eingabefelder,
   * speicherte brav in die Datenbank, und der Wert wirkte nie. Ohne Hinweis.
   * Bei WEBDAV_BACKUP_* und DOCUMENT_STORAGE_WEBDAV_* war dasselbe
   * Vorrangverhalten längst sichtbar gelöst, bei SMTP nicht.
   */
  function isEnvControlled(field) {
    const fromEnv = env[CONFIG_KEYS[field].env];
    return fromEnv !== undefined && String(fromEnv).trim() !== '';
  }

  /** Pro Feld, nicht pro Gruppe: wer nur EMAIL_SMTP_HOST setzt, darf den Rest weiter in der UI pflegen. */
  function envControlledFields() {
    return Object.fromEntries(Object.keys(CONFIG_KEYS).map(f => [f, isEnvControlled(f)]));
  }

  function getRawConfig() {
    const secure = (resolve('secure') || 'starttls').toLowerCase();
    return {
      host: resolve('host'),
      port: Number.parseInt(resolve('port'), 10) || null,
      secure: VALID_SECURE.has(secure) ? secure : 'starttls',
      user: resolve('user'),
      pass: resolve('pass'),
      fromAddress: resolve('fromAddress'),
      fromName: resolve('fromName') || 'Yuvomi',
    };
  }

  function isConfigured() {
    const c = getRawConfig();
    return Boolean(c.host && c.fromAddress);
  }

  // Public view for the settings UI — never exposes the password.
  function getPublicConfig() {
    const c = getRawConfig();
    return {
      host: c.host || '',
      port: c.port || (c.secure === 'ssl' ? 465 : 587),
      secure: c.secure,
      user: c.user || '',
      fromAddress: c.fromAddress || '',
      fromName: c.fromName,
      passwordSet: Boolean(c.pass),
      configured: isConfigured(),
      envControlled: envControlledFields(),
    };
  }

  function buildTransport(c) {
    const opts = {
      host: c.host,
      port: c.port || (c.secure === 'ssl' ? 465 : 587),
      secure: c.secure === 'ssl',
    };
    if (c.secure === 'starttls') opts.requireTLS = true;
    if (c.user) opts.auth = { user: c.user, pass: c.pass || '' };
    return nodemailer.createTransport(opts);
  }

  function fromHeader(c) {
    return c.fromName ? `"${c.fromName}" <${c.fromAddress}>` : c.fromAddress;
  }

  async function sendMail({ to, subject, html, text }) {
    if (!isConfigured()) throw new Error('Email is not configured.');
    const c = getRawConfig();
    const transport = buildTransport(c);
    const info = await transport.sendMail({ from: fromHeader(c), to, subject, html, text });
    log.info(`Mail sent to ${to} (${subject})`);
    return info;
  }

  // Verifies the connection, then sends a probe mail. Never throws — returns a result.
  async function sendTest(to) {
    try {
      if (!isConfigured()) return { ok: false, error: 'Email is not configured.' };
      const c = getRawConfig();
      const transport = buildTransport(c);
      await transport.verify();
      await transport.sendMail({
        from: fromHeader(c),
        to,
        subject: 'Yuvomi SMTP test',
        text: 'This is a test message confirming your Yuvomi SMTP configuration works.',
        html: '<p>This is a test message confirming your Yuvomi SMTP configuration works.</p>',
      });
      return { ok: true };
    } catch (err) {
      log.warn('SMTP test failed:', err?.message || err);
      return { ok: false, error: err?.message || String(err) };
    }
  }

  return { isConfigured, getPublicConfig, getRawConfig, isEnvControlled, sendMail, sendTest };
}

export const emailService = createEmailService();
