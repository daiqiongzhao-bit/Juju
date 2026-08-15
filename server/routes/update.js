/**
 * Modul: Admin – Ein-Klick-Update
 * Zweck: Admins können die App über GitHub-Releases aktualisieren lassen:
 *   git fetch -> checkout <tag> -> docker build -> atomarer Container-Tausch.
 * Voraussetzung: /var/run/docker.sock und /opt/juju-src sind in den Container
 * eingehängt (siehe deploy_run.py). Die docker.sock muss für den node-Benutzer
 * schreibbar sein (z. B. chmod 666), da die App als non-root läuft.
 */
import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createLogger } from '../logger.js';

const log = createLogger('Update');

const SRC_DIR = process.env.JUJU_SOURCE_DIR || '/opt/juju-src';
const IMAGE = process.env.JUJU_IMAGE || 'juju:latest';
const LOCK_FILE = `${SRC_DIR}/.update.lock`;
const STATUS_FILE = `${SRC_DIR}/.update-status.json`;
const SWAP_WAIT_SECONDS = Number(process.env.JUJU_UPDATE_SWAP_WAIT || 6);

const execFileP = promisify(execFile);
const router = express.Router();

let inProcess = false;

function writeStatus(status) {
  try {
    writeFileSync(STATUS_FILE, JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2));
  } catch (e) {
    log.warn('status write failed:', e.message);
  }
}
function readStatus() {
  try { return JSON.parse(readFileSync(STATUS_FILE, 'utf-8')); } catch { return null; }
}
function acquireLock() {
  if (inProcess || existsSync(LOCK_FILE)) return false;
  try { writeFileSync(LOCK_FILE, String(process.pid)); inProcess = true; return true; }
  catch { return false; }
}
function releaseLock() {
  inProcess = false;
  try { rmSync(LOCK_FILE, { force: true }); } catch {}
}
async function run(cmd, args, opts = {}) {
  log.info('$ ' + [cmd, ...args].join(' '));
  const { stdout, stderr } = await execFileP(cmd, args, { timeout: opts.timeout || 600000, ...opts });
  if (stdout) log.info(stdout.trim());
  if (stderr) log.warn(stderr.trim());
  return stdout;
}

/**
 * Führt das Update asynchron aus. Der schwere Teil (build + swap) läuft in einem
 * kurzlebigen "juju_swap"-Container, der im Host-Namespace lebt – wenn dieser
 * den laufenden "juju"-Container stoppt, überlebt der Swap-Container und startet
 * den neuen Container. So wird die App atomar ausgetauscht.
 */
async function performUpdate(target) {
  try {
    const tag = target.startsWith('v') ? target : `v${target}`;
    writeStatus({ phase: 'fetching', target: tag });
    await run('git', ['-C', SRC_DIR, 'fetch', '--tags', 'origin']);

    writeStatus({ phase: 'checking-out', target: tag });
    await run('git', ['-C', SRC_DIR, 'checkout', '-f', tag]);

    writeStatus({ phase: 'building', target: tag });
    await run('docker', ['build', '-t', IMAGE, SRC_DIR], { timeout: 600000 });

    writeStatus({ phase: 'swapping', target: tag });
    const swap = [
      `sleep ${SWAP_WAIT_SECONDS}`,
      `docker stop juju 2>/dev/null`,
      `docker rm -f juju 2>/dev/null`,
      `docker run -d --name juju --restart unless-stopped -p 3000:3000`,
      `--env-file ${SRC_DIR}/.env`,
      `-v /opt/juju-data:/data -v /opt/juju-backups:/backups`,
      `-v /var/run/docker.sock:/var/run/docker.sock`,
      `-v ${SRC_DIR}:${SRC_DIR}`,
      `${IMAGE}`,
      `docker rm -f juju_swap 2>/dev/null`,
      `rm -f ${LOCK_FILE} ${STATUS_FILE}`,
    ].join(' ');
    const swapFile = `${SRC_DIR}/.update-swap.sh`;
    writeFileSync(swapFile, `#!/bin/sh\n${swap}\n`);
    await run('docker', [
      'run', '-d', '--name', 'juju_swap', '--restart', 'no',
      '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '-v', `${SRC_DIR}:${SRC_DIR}`,
      IMAGE, 'sh', '-c', `sh ${swapFile}`,
    ]);
    log.info('Updater container launched; swap in ~%ds.', SWAP_WAIT_SECONDS);
  } catch (err) {
    log.error('Update failed:', err.message);
    writeStatus({ phase: 'error', error: err.message });
    releaseLock();
    throw err;
  }
}

// POST /api/v1/update  -> Update auf die angegebene Version (tag) starten
router.post('/', async (req, res) => {
  if (!acquireLock()) {
    return res.status(409).json({ error: 'An update is already in progress.', code: 409 });
  }
  const target = String(req.body?.version || req.body?.tag || '').trim();
  if (!target) {
    releaseLock();
    return res.status(400).json({ error: 'Target version is required.', code: 400 });
  }
  // Antwort sofort; der schwere Teil läuft asynchron im Hintergrund.
  performUpdate(target).catch(() => {});
  return res.status(202).json({ accepted: true, target, message: 'Update started.' });
});

// GET /api/v1/update/status -> Fortschritt (bis der Swap-Container die Datei löscht)
router.get('/status', (_req, res) => {
  const s = readStatus();
  return res.json(s || { phase: 'idle' });
});

export default router;
