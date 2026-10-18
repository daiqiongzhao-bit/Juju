/**
 * Module: Database Backup
 * Purpose: Authenticated admin-only database backup and restore endpoints.
 * Dependencies: express, server/db.js
 */

import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { currentVersion, getEncryptionKey, restoreFromFile } from '../db.js';
import { requireAdmin } from '../auth.js';
import { createLogger } from '../logger.js';
import { createLocalBackup, getStatus as getSchedulerStatus, triggerBackup } from '../services/backup-scheduler.js';
import * as webdavBackup from '../services/backup-webdav.js';
import * as backupBundle from '../services/backup-bundle.js';
import * as backupSecrets from '../services/backup-secrets.js';
import * as backupVerify from '../services/backup-verify.js';

const router = express.Router();
const log = createLogger('Backup');
const RESTORE_LIMIT = process.env.BACKUP_UPLOAD_LIMIT || '100mb';

function backupFileName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `yuvomi-backup-${stamp}.db`;
}

/**
 * Name des Sicherungspakets. Das Paket (ZIP) enthält die Datenbank UND die
 * Schlüsseldatei — nur zusammen ist eine verschlüsselte Datenbank später
 * wieder lesbar.
 */
function bundleFileName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `yuvomi-backup-${stamp}.zip`;
}

router.get('/status', requireAdmin, async (req, res) => {
  const schedulerStatus = getSchedulerStatus();
  let secrets = null;
  try {
    secrets = await backupSecrets.getSecretsStatus();
  } catch (err) {
    log.error('Secrets status failed:', err?.message || err);
    secrets = { path: backupSecrets.secretsPath(), available: false, keys: [] };
  }
  res.json({
    data: {
      schema_version: currentVersion(),
      restore_upload_limit: RESTORE_LIMIT,
      scheduler: schedulerStatus,
      // Ohne diese Datei ist jede Datensicherung wertlos: die Datenbank ist
      // mit DB_ENCRYPTION_KEY verschlüsselt, und der steht genau hier.
      secrets_file: secrets,
    },
  });
});

router.get('/database', requireAdmin, async (req, res) => {
  let dir = null;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuvomi-backup-'));
    const tmpPath = path.join(dir, bundleFileName());
    const built = await backupBundle.createBundle(tmpPath);
    if (!built.secretsIncluded) {
      log.warn('Backup download without key file — this backup alone cannot restore the database.');
    }

    res.setHeader('Cache-Control', 'no-store');
    res.download(tmpPath, path.basename(tmpPath), async (err) => {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      if (err && !res.headersSent) {
        log.error('Backup download failed:', err);
      }
    });
  } catch (err) {
    log.error('Database backup failed:', err);
    if (dir) {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    res.status(500).json({ error: 'Database backup failed.', code: 500 });
  }
});

router.post(
  '/restore',
  requireAdmin,
  express.raw({ type: 'application/octet-stream', limit: RESTORE_LIMIT }),
  async (req, res) => {
    let dir = null;
    // Rollback-Zustand. Wird erst belegt, wenn die Schlüsseldatei tatsächlich
    // überschrieben wurde — nur dann gibt es etwas zurückzudrehen.
    let previousSecrets = null;
    let previousEnv = null;
    let secretsWritten = false;

    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Backup file is required.', code: 400 });
      }

      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuvomi-restore-'));
      const uploadPath = path.join(dir, 'restore.db');

      // Zwei Formate: das neue Paket (ZIP mit Datenbank + Schlüsseldatei) und
      // weiterhin die nackte .db aus älteren Sicherungen.
      let secretsRestored = false;
      let secretsPrevious = null;
      let secretsSkipped = null;
      let verifiedSchemaVersion = null;
      // Neuer Datenbank-Schlüssel, falls das Paket seine eigene Schlüsseldatei
      // mitbringt und der Admin sie übernimmt. `null` = aktuellen behalten.
      let restoreEncryptionKey = null;

      if (backupBundle.isBundle(req.body)) {
        const parsed = backupBundle.parseBundle(req.body);
        await fs.writeFile(uploadPath, parsed.db);

        if (!parsed.secrets) {
          secretsSkipped = 'not_included';
        } else if (parsed.secretsError) {
          secretsSkipped = parsed.secretsError;
        } else if (req.query.restore_secrets === '1') {
          // ① Schlüssel des Pakets NUR in eine temporäre Datei legen (0600).
          //    /data/.juju-secrets bleibt vorerst unangetastet: wäre sie schon
          //    überschrieben und der Datenbank-Restore schlüge danach fehl,
          //    stünde auf der Platte „neuer Schlüssel + mit dem alten
          //    verschlüsselte Datenbank" — die Instanz wäre nach dem nächsten
          //    Neustart dauerhaft unstartbar. Genau das darf nie passieren.
          await backupSecrets.stageSecretsFile(parsed.secrets, dir);

          // ② BEWEIS statt Hoffnung: in einem frischen node-Prozess öffnen.
          //    Der Hauptprozess hat den Schlüssel beim Laden in eine
          //    Modulvariable kopiert (db.js: DB_KEY) — Änderungen an
          //    process.env kämen dort nie an. Ein Kindprozess liest die Umwelt
          //    beim Start neu, seine Sicht ist garantiert die des Backups.
          const verification = await backupVerify.verifyBackupBundle(uploadPath, parsed.secrets);
          if (!verification.ok) {
            throw new Error(
              `This backup cannot be restored — the bundled database could not be opened with the bundled key` +
              `${verification.reason ? ` (${verification.reason})` : ''}. ` +
              `Nothing was changed on disk.`
            );
          }
          verifiedSchemaVersion = verification.schemaVersion;

          // ③ Erst NACH dem Beweis die Schlüsseldatei ersetzen (bestehende
          //    Datei vorher als `.pre-restore-*` sichern, atomar schreiben).
          previousSecrets = await backupSecrets.readSecretsBuffer();
          previousEnv = backupSecrets.snapshotEnv();
          const written = await backupSecrets.restoreSecretsFile(parsed.secrets);
          secretsWritten = true;
          secretsPrevious = written.previousBackup ? path.basename(written.previousBackup) : null;

          // Schlüssel, die bei jedem Aufruf aus process.env gelesen werden
          // (JUJU_SM4_KEY), müssen schon vor dem Datenbank-Restore stimmen —
          // sonst verschlüsseln die Migrationen mit dem falschen Feldschlüssel.
          backupSecrets.applySecretsToEnv(parsed.secrets);

          // Der Datenbank-Schlüssel selbst kommt NICHT über process.env: db.js
          // bekommt ihn explizit und tauscht damit Modulvariable + Verbindung.
          restoreEncryptionKey = backupSecrets.parseSecrets(parsed.secrets).DB_ENCRYPTION_KEY || null;
          secretsRestored = true;
        } else {
          secretsSkipped = 'not_requested';
        }
      } else {
        await fs.writeFile(uploadPath, req.body);
        secretsSkipped = 'legacy_database_only';
      }

      // Auch ohne Schlüsselwechsel gilt: erst beweisen, dann einspielen. Ein
      // Paket von einer fremden Installation, dessen Schlüssel NICHT übernommen
      // wurde, fällt hier auf — bevor irgendetwas überschrieben wird.
      if (restoreEncryptionKey === null) {
        const verification = await backupVerify.verifyBackupDatabase(uploadPath, getEncryptionKey() || '');
        if (!verification.ok) {
          throw new Error(
            `This backup cannot be restored — the database could not be opened with the current key` +
            `${verification.reason ? ` (${verification.reason})` : ''}. ` +
            `Nothing was changed on disk.`
          );
        }
        verifiedSchemaVersion = verification.schemaVersion;
      }

      // ④ Datenbank einspielen. db.js schliesst die Verbindung, tauscht die
      //    Datei (mit `.pre-restore-*` als Rolle) und öffnet mit dem neuen
      //    Schlüssel neu — ohne Neustart. Schlägt etwas fehl, rollt es Datei
      //    UND Schlüssel selbst zurück.
      const result = await restoreFromFile(uploadPath, { encryptionKey: restoreEncryptionKey ?? undefined });

      res.json({
        ok: true,
        data: {
          schema_version: result.schemaVersion,
          verified_schema_version: verifiedSchemaVersion,
          secrets_restored: secretsRestored,
          secrets_previous_file: secretsPrevious,
          secrets_skipped_reason: secretsSkipped,
        },
      });
    } catch (err) {
      log.error('Database restore failed:', err);

      // Vollständiger Rückbau: Schlüsseldatei und Laufzeit-Umwelt. Die
      // Datenbankdatei hat restoreFromFile() bereits zurückgerollt (und dabei
      // den Schlüssel zuerst wieder auf den alten gestellt). Nur zusammen ist
      // der Zustand wieder konsistent — ein „neuer Schlüssel + altes DB-File"
      // würde die Instanz beim nächsten Start mit „Wrong encryption key" töten.
      let secretsRolledBack = false;
      if (secretsWritten) {
        try {
          if (previousEnv) backupSecrets.restoreEnvSnapshot(previousEnv);
          await backupSecrets.rollbackSecretsFile(previousSecrets);
          secretsRolledBack = true;
        } catch (rollbackErr) {
          log.error('Secrets rollback after failed restore failed:', rollbackErr);
        }
      }

      const message = err?.message || 'Database restore failed.';
      // Der häufigste echte Fehler nach einem Umzug: die Datenbank kommt von
      // einer anderen Installation und der Schlüssel passt nicht. Das ist eine
      // Aussage, mit der jemand etwas anfangen kann — „restore failed" nicht.
      const keyMismatch = /file is not a database|not a valid|encrypted|HMAC|could not be opened|解密|password/i.test(message);
      const hint = keyMismatch && !/Nothing was changed on disk/.test(message)
        ? ' If this backup comes from another installation, restore the matching key file (/data/.juju-secrets) as well — a database backup alone cannot be decrypted.'
        : '';
      res.status(400).json({ error: message + hint, code: 400, secrets_rolled_back: secretsRolledBack });
    } finally {
      if (dir) {
        try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  }
);

router.post('/trigger', requireAdmin, async (req, res) => {
  try {
    const result = await triggerBackup();
    res.json({ data: result });
  } catch (err) {
    log.error('Manual backup trigger failed:', err);
    res.status(500).json({ error: 'Backup trigger failed.', code: 500 });
  }
});

// ─── WebDAV backup target ──────────────────────────────────────────────────────

/**
 * GET /api/v1/backup/webdav/config
 * Returns current WebDAV configuration (password masked).
 */
router.get('/webdav/config', requireAdmin, (req, res) => {
  res.json({ data: webdavBackup.getStatus() });
});

/**
 * PUT /api/v1/backup/webdav/config
 * Persists WebDAV configuration.
 * Body: { enabled?, url?, username?, password?, remotePath?, keep? }
 */
router.put('/webdav/config', requireAdmin, async (req, res) => {
  try {
    const { enabled, url, username, password, remotePath, keep } = req.body;

    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean.', code: 400 });
    }
    if (url !== undefined && url !== null && url !== '' && typeof url !== 'string') {
      return res.status(400).json({ error: 'url must be a string.', code: 400 });
    }
    if (url && !/^https?:\/\/.+/.test(url.trim())) {
      return res.status(400).json({ error: 'url must start with http:// or https://.', code: 400 });
    }
    if (keep !== undefined && (typeof keep !== 'number' || keep < 1)) {
      return res.status(400).json({ error: 'keep must be a positive integer.', code: 400 });
    }

    webdavBackup.saveConfig({ enabled, url, username, password, remotePath, keep });
    res.json({ data: webdavBackup.getStatus() });
  } catch (err) {
    log.error('WebDAV config save failed:', err);
    res.status(500).json({ error: 'Failed to save WebDAV config.', code: 500 });
  }
});

/**
 * POST /api/v1/backup/webdav/test
 * Tests the WebDAV connection.
 * Body: { url?, username?, password?, remotePath? }  (optional overrides)
 */
router.post('/webdav/test', requireAdmin, async (req, res) => {
  try {
    const { url, username, password, remotePath } = req.body ?? {};
    const overrides = {};
    if (url)        overrides.url        = url;
    if (username)   overrides.username   = username;
    if (password && password !== '****') overrides.password = password;
    if (remotePath) overrides.remotePath = remotePath;

    const result = await webdavBackup.testConnection(overrides);
    res.json({ data: result });
  } catch (err) {
    log.error('WebDAV connection test failed:', err);
    res.status(400).json({ error: err.message ?? 'Connection test failed.', code: 400 });
  }
});

/**
 * GET /api/v1/backup/webdav/files
 * Lists backup files stored on the remote WebDAV server.
 */
router.get('/webdav/files', requireAdmin, async (req, res) => {
  try {
    const files = await webdavBackup.getRemoteFiles();
    res.json({ data: files });
  } catch (err) {
    log.error('WebDAV file listing failed:', err);
    res.status(500).json({ error: err.message ?? 'Failed to list remote files.', code: 500 });
  }
});

/**
 * POST /api/v1/backup/webdav/trigger
 * Creates a fresh backup snapshot and uploads it to WebDAV immediately.
 * A fresh, uniquely named file is created on every trigger so manual uploads
 * never overwrite a previous remote backup.
 */
router.post('/webdav/trigger', requireAdmin, async (req, res) => {
  try {
    const filePath = await createLocalBackup();
    await webdavBackup.uploadBackup(filePath);
    res.json({ data: { file: path.basename(filePath), timestamp: new Date().toISOString() } });
  } catch (err) {
    log.error('WebDAV manual upload failed:', err);
    res.status(500).json({ error: err.message ?? 'WebDAV upload failed.', code: 500 });
  }
});

router.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: `Backup file is too large. Maximum upload size is ${RESTORE_LIMIT}.`, code: 413 });
  }
  next(err);
});

export default router;
