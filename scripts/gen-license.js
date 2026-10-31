#!/usr/bin/env node
/**
 * License-Key-Generator für juju / yuvomi.
 *
 * Nur sinnvoll, wenn der Ziel-Server mit JUJU_LICENSE_MASTER gestartet wird.
 * Erzeugt einen HMAC-signierten Key (Präfix JUJU1-...), den Empfänger dann
 * unter  Einstellungen → Verwaltung → Lizenz  aktivieren.
 *
 * Beispiel:
 *   node scripts/gen-license.js --master "$JUJU_LICENSE_MASTER" \
 *        --subject "Familie Müller" --devices 5 --days 365
 *
 *   # oder Master via Env:
 *   JUJU_LICENSE_MASTER=xxx node scripts/gen-license.js --subject Demo --days 30
 */

import { signLicense } from '../server/services/license.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    const val = next && !next.startsWith('--') ? next : 'true';
    if (val !== 'true') i += 1;
    out[key] = val;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const master = args.master || process.env.JUJU_LICENSE_MASTER;
  if (!master) {
    console.error('FEHLER: --master <key> erforderlich (oder JUJU_LICENSE_MASTER gesetzt).');
    process.exit(2);
  }
  const subject = args.subject || 'Community';
  const devices = Number(args.devices || 1);
  const days = Number(args.days || 0); // 0 = unbegrenzt gültig
  const now = Date.now();
  const payload = {
    sub: subject,
    dev: devices,
    iat: now,
    exp: days > 0 ? now + days * 86_400_000 : 0,
  };
  const key = signLicense(payload, master);
  console.log('LICENSE KEY:');
  console.log(key);
  console.log('');
  console.log(`Subject : ${subject}`);
  console.log(`Devices : ${devices}`);
  console.log(`Issued  : ${new Date(now).toISOString()}`);
  console.log(`Expires : ${days > 0 ? new Date(payload.exp).toISOString() : 'never'}`);
  console.log('');
  console.log('Aktivierung auf dem Zielserver: Einstellungen → Verwaltung → Lizenz.');
}

main();
