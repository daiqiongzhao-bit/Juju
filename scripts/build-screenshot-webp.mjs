/**
 * WebP-Derivate der Screenshots - Yuvomi
 *
 * Die GitHub-Pages-Seite lädt jeden Screenshot als WebP in zwei Breiten
 * (`<name>@1x.webp` 1x, `<name>.webp` 2x) und fällt per onerror auf das PNG
 * zurück (docs/index.html, shotSrc). Die PNGs sind 5-10x größer als der Slot,
 * in dem sie landen - ohne die Derivate zieht die Startseite mehrere Megabyte.
 *
 * Bis hierher entstanden sie von Hand, was nach jedem Screenshot-Lauf einen
 * stillen Rückfall auf die PNGs bedeutete (die WebP zeigten dann noch den alten
 * Stand, denn onerror greift nur bei FEHLENDEN Dateien, nicht bei veralteten).
 *
 * Usage: node scripts/build-screenshot-webp.mjs
 *
 * Welche Bilder Derivate bekommen, steht nicht hier, sondern in den HTML-Dateien
 * unter docs/: gebaut wird, was `data-light`/`data-dark` referenziert, plus alles,
 * was schon ein WebP hat. Eine zweite Liste hier würde von der ersten abdriften.
 *
 * Konvertiert wird über den WebP-Encoder von Chromium (Playwright ist für die
 * Screenshots ohnehin da) - cwebp/ImageMagick sind auf dem Zielrechner nicht
 * installiert und ffmpeg ist ohne libwebp gebaut.
 */

import { chromium } from '/opt/homebrew/lib/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DOCS = resolve(ROOT, 'docs');
const SHOTS = resolve(DOCS, 'screenshots');

// Anzeigebreiten der beiden Geräteprofile auf der Seite. 2x ist die
// Retina-Variante, 1x exakt die Hälfte - dieselben Größen, die der bisherige
// Bestand hat, damit ein Lauf die Seite nicht unbemerkt neu layoutet.
const WIDTHS = {
  web:    { '2x': 1400, '1x': 700 },
  mobile: { '2x': 480,  '1x': 240 },
};
const QUALITY = 0.82;

/** Alle von den Doc-Seiten referenzierten Screenshot-Dateinamen. */
function referencedShots() {
  const names = new Set();
  for (const file of readdirSync(DOCS).filter((f) => f.endsWith('.html'))) {
    const html = readFileSync(resolve(DOCS, file), 'utf8');
    for (const m of html.matchAll(/data-(?:light|dark)="screenshots\/([^"]+\.png)"/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

/** Dateien, die bereits ein WebP haben - sie bleiben aktuell, auch wenn die
 *  Seite sie gerade nicht mehr referenziert. */
function shotsWithExistingWebp(dir) {
  const names = new Set();
  if (!existsSync(dir)) return names;
  for (const f of readdirSync(dir)) {
    const m = f.match(/^(.+?)(?:@1x)?\.webp$/);
    if (m) names.add(`${m[1]}.png`);
  }
  return names;
}

/** Locale-Ordner: die Wurzel (englisch) plus jeder Unterordner, dessen Name ein
 *  Sprach-Tag ist. Bewusst am Namen und nicht daran, ob PNGs drinliegen -
 *  `screenshots/unraid/` enthält ebenfalls PNGs, aber keine Übersetzung des
 *  Screenshot-Satzes. */
const LOCALE_DIR = /^[a-z]{2}(-[a-z]{2})?$/;
function localeDirs() {
  const dirs = [SHOTS];
  for (const entry of readdirSync(SHOTS, { withFileTypes: true })) {
    if (!entry.isDirectory() || !LOCALE_DIR.test(entry.name)) continue;
    dirs.push(resolve(SHOTS, entry.name));
  }
  return dirs;
}

async function convert(page, pngPath, outPath, width) {
  const base64 = readFileSync(pngPath).toString('base64');
  const dataUrl = await page.evaluate(async ({ b64, w, q }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = Math.round((img.naturalHeight / img.naturalWidth) * w);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/webp', q);
  }, { b64: base64, w: width, q: QUALITY });

  if (!dataUrl.startsWith('data:image/webp')) {
    throw new Error(`Chromium returned no WebP for ${pngPath}`);
  }
  writeFileSync(outPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><meta charset="utf-8"><title>webp</title>');

  let written = 0;
  let skipped = 0;

  try {
    for (const dir of localeDirs()) {
      const label = dir === SHOTS ? 'en' : dir.slice(SHOTS.length + 1);
      const wanted = new Set([...referencedShots(), ...shotsWithExistingWebp(dir)]);
      console.log(`\n── ${label} (${wanted.size} shots) ──`);

      for (const name of [...wanted].sort()) {
        const png = resolve(dir, name);
        if (!existsSync(png)) {
          console.log(`  – ${name} (no PNG in this locale)`);
          skipped++;
          continue;
        }
        const profile = name.includes('-mobile') ? 'mobile' : 'web';
        const stem = name.replace(/\.png$/, '');
        await convert(page, png, resolve(dir, `${stem}.webp`), WIDTHS[profile]['2x']);
        await convert(page, png, resolve(dir, `${stem}@1x.webp`), WIDTHS[profile]['1x']);
        written += 2;
        console.log(`  ✓ ${stem}.webp + @1x.webp`);
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\nDone. ${written} WebP files written, ${skipped} shot(s) skipped.`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
